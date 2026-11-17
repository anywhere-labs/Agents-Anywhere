// ported from effi-crew cloud/agentd/src/conv/slim.ts @30f8334 (slimDraft, fitItem, fitPage)
//
// Keeping session content small enough to store, send and draw: base64 images kept verbatim can make a handful of
// messages weigh over 100 MB, more than a client can open. The device store is the authority for session content
// (D1), so nothing is thrown away. A large field moves into the content-addressed blob store and the item keeps a
// head/tail preview plus a `blobRef` that clients can expand (04-connector.md §6.4).
//
// Layers:
//   1. slimDraft — what is stored: inline media (image / audio / blob data, data: URLs) and very long strings
//      leave the item; the item's payload stays under ITEM_PAYLOAD_MAX.
//   2. fitItem — one item on the wire within a byte budget, cutting harder on a copy if it must.
//   3. fitPage — a page of items within a budget: the newest that fit, the rest reachable by paging (hasMore).

import { TERMINAL_ITEM_STATUSES, type BlobRef, type JsonObject, type TimelineDraft, type TimelineItem } from '../domain/conversation/index.js'

export { PAGE_BUDGET, PAGE_LIMIT_MAX, SNAPSHOT_LIMIT } from '../domain/conversation/index.js'

/** A string longer than this leaves the item. */
export const STRING_MAX = 48 * 1024
/** An item's stored payload above this gets harder cuts (04-connector.md §6.4). */
export const ITEM_PAYLOAD_MAX = 64 * 1024
/** Head and tail kept as the preview of a moved string (04-connector.md §6.4: 4 KiB each). */
export const PREVIEW_HEAD = 4 * 1024
export const PREVIEW_TAIL = 4 * 1024
/** One item on the wire, whatever the page budget (below the 4 MiB Router frame). */
export const ITEM_WIRE_MAX = 3 * 1024 * 1024

const MEDIA_TYPES = new Set(['image', 'audio', 'blob'])
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(;[\w=.+-]+)*;base64,/u
const BASE64_RUN = /^[A-Za-z0-9+/=\r\n]+$/u
const MAX_DEPTH = 40

/** Made only of base64 characters, with the mix of classes real base64 has (not "aaaa…" or a long number). */
function looksBase64(sample: string): boolean {
  if (!BASE64_RUN.test(sample)) return false
  return [/[A-Z]/u, /[a-z]/u, /[0-9]/u].filter(pattern => pattern.test(sample)).length === 3
}

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Where a moved field's bytes go; returns the blob id. Content-addressed, so repeating a write is free. */
export type BlobSink = (bytes: Uint8Array, mediaType: string | null) => { blobId: string; bytes: number }

/** JSON pointer segment escaping (RFC 6901). */
function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`
}

function runningPreview(text: string, head: number, tail: number, total: number): string {
  return `${text.slice(0, head)}\n…（输出进行中，中间省略 ${kb(total - head - tail)}，已有 ${kb(total)}，完成后可展开查看）…\n${text.slice(-tail)}`
}

function preview(text: string, head: number, tail: number, total: number): string {
  return `${text.slice(0, head)}\n…（中间省略 ${kb(total - head - tail)}，完整内容 ${kb(total)}，可展开查看）…\n${text.slice(-tail)}`
}

interface SlimContext {
  readonly sink: BlobSink
  readonly stringMax: number
  readonly refs: BlobRef[]
  /** Paths already replaced by a preview in an earlier tier: never move a preview again. */
  readonly moved: ReadonlySet<string>
  /**
   * The item is still in progress (streaming): long text is cut to a preview without writing a blob. A growing
   * field is committed every ~100 ms, and writing each version as its own blob left hundreds of copies of one
   * output behind; the full text is written once, when the item finishes. Media and base64 move at once (they
   * arrive whole).
   */
  readonly deferText: boolean
}

function moveString(value: string, path: string, context: SlimContext): string {
  const dataUrl = DATA_URL.exec(value)
  if (dataUrl !== null) {
    const mediaType = dataUrl[1] ?? 'application/octet-stream'
    const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')
    const stored = context.sink(bytes, mediaType)
    context.refs.push({ path, blobId: stored.blobId, bytes: stored.bytes, mediaType })
    return `[${mediaType}，${kb(stored.bytes)}，已存到本机，可展开查看]`
  }
  if (value.length > 4096 && looksBase64(value.slice(0, 4096)) && looksBase64(value.slice(-1024))) {
    const bytes = Buffer.from(value.replace(/[\r\n]/gu, ''), 'base64')
    const stored = context.sink(bytes, 'application/octet-stream')
    context.refs.push({ path, blobId: stored.blobId, bytes: stored.bytes, mediaType: 'application/octet-stream' })
    return `[二进制数据，约 ${kb(stored.bytes)}，已存到本机，可展开查看]`
  }
  const encoded = Buffer.from(value, 'utf8')
  const head = Math.min(PREVIEW_HEAD, Math.floor(context.stringMax * 0.75))
  const tail = Math.min(PREVIEW_TAIL, Math.floor(context.stringMax * 0.2))
  if (context.deferText) return runningPreview(value, head, tail, encoded.length)
  const stored = context.sink(encoded, 'text/plain; charset=utf-8')
  context.refs.push({ path, blobId: stored.blobId, bytes: stored.bytes, mediaType: 'text/plain; charset=utf-8' })
  return preview(value, head, tail, encoded.length)
}

/**
 * A JSON value as it should be kept: media data out, long strings out. Returns the same reference when
 * nothing needed changing (cheap to call on every streaming update).
 */
function slimValue(value: unknown, path: string, context: SlimContext, depth: number): unknown {
  if (typeof value === 'string') return value.length > context.stringMax && !context.moved.has(path) ? moveString(value, path, context) : value
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return '[层级太深，未保存]'
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((entry, index) => {
      const slim = slimValue(entry, pointer(path, index), context, depth + 1)
      if (slim !== entry) changed = true
      return slim
    })
    return changed ? out : value
  }
  const object = value as Record<string, unknown>
  // MCP / ACP media content: { type: "image", data: "<base64>", mimeType } (also audio, and resource blobs).
  if (typeof object.type === 'string' && MEDIA_TYPES.has(object.type) && typeof object.data === 'string' && object.data.length > 256) {
    const { data, ...rest } = object
    const mediaType = typeof object.mimeType === 'string' ? object.mimeType : null
    const stored = context.sink(Buffer.from(data as string, 'base64'), mediaType)
    context.refs.push({ path: pointer(path, 'data'), blobId: stored.blobId, bytes: stored.bytes, mediaType })
    const label = object.type === 'image' ? '图片' : object.type === 'audio' ? '音频' : '数据'
    return { ...rest, omitted: `${label}，约 ${kb(stored.bytes)}，已存到本机` }
  }
  if (typeof object.blob === 'string' && object.blob.length > 256) {
    const { blob, ...rest } = object
    const mediaType = typeof object.mimeType === 'string' ? object.mimeType : null
    const stored = context.sink(Buffer.from(blob as string, 'base64'), mediaType)
    context.refs.push({ path: pointer(path, 'blob'), blobId: stored.blobId, bytes: stored.bytes, mediaType })
    return { ...rest, omitted: `数据，约 ${kb(stored.bytes)}，已存到本机` }
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(object)) {
    const slim = slimValue(entry, pointer(path, key), context, depth + 1)
    if (slim !== entry) changed = true
    out[key] = slim
  }
  return changed ? out : value
}

/**
 * The draft as it is stored. Strings above 48 KiB and inline media move to blobs; if the payload is still above
 * 64 KiB (many medium fields), strings above 8 KiB, then above 1 KiB, move too.
 * Deterministic, so replaying the same draft yields the same hash and does not tick the clock.
 */
export function slimDraft(draft: TimelineDraft, sink: BlobSink): TimelineDraft {
  let content = draft.content
  const refs: BlobRef[] = []
  for (const stringMax of [STRING_MAX, 8 * 1024, 1024]) {
    const context: SlimContext = { sink, stringMax, refs, moved: new Set(refs.map(ref => ref.path)), deferText: !TERMINAL_ITEM_STATUSES.has(draft.status) }
    content = slimValue(content, '', context, 0) as JsonObject
    if (jsonBytes(content) <= ITEM_PAYLOAD_MAX) break
  }
  if (refs.length === 0) {
    // Nothing moved out; text of an item still in progress may have been cut to a preview.
    if (content === draft.content && draft.blobRefs === undefined) return draft
    const { blobRefs: _drop, ...rest } = draft
    return { ...rest, content }
  }
  return { ...draft, content, blobRefs: refs }
}

/** One item within `budget` bytes on the wire; the stored item is untouched. */
export function fitItem(item: TimelineItem, budget = ITEM_WIRE_MAX): TimelineItem {
  if (jsonBytes(item) <= budget) return item
  // Fields were already moved at write time; what is left is structure. Keep the head of each string.
  const cut = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return value.length > 1024 ? `${value.slice(0, 1024)}…` : value
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
    if (Array.isArray(value)) return value.length > 200 ? [...value.slice(-200).map(entry => cut(entry, depth + 1)), `（前面 ${value.length - 200} 项没有显示）`] : value.map(entry => cut(entry, depth + 1))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cut(entry, depth + 1)]))
  }
  return { ...item, content: cut(item.content, 0) as JsonObject }
}

/**
 * The items that fit in `budget`, keeping order. `newestFirst` picks from the end (latest page, `before`
 * paging); otherwise from the start (`after` paging). At least one item always fits.
 */
export function fitPage(items: readonly TimelineItem[], budget: number, newestFirst: boolean): { items: TimelineItem[]; truncated: boolean; bytes: number } {
  const out: TimelineItem[] = []
  let used = 0
  const order = newestFirst ? [...items].reverse() : items
  for (const item of order) {
    const fitted = fitItem(item)
    const size = jsonBytes(fitted)
    if (out.length > 0 && used + size > budget) {
      return { items: newestFirst ? out.reverse() : out, truncated: true, bytes: used }
    }
    out.push(fitted)
    used += size
  }
  return { items: newestFirst ? out.reverse() : out, truncated: false, bytes: used }
}
