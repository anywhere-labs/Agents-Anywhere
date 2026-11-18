// `Store/exportShare` (06-protocols.md §5): the immutable snapshot a public share keeps. The Server stores the items
// and copies the attachments they reference (through `Store/readBlob`), so the snapshot is what the public share
// page renders: protocol timeline items, long text that was moved to the blob store put back inline.

import type { ConversationStore } from '../application/ports/index.js'
import { PAGE_BUDGET, PAGE_LIMIT_MAX, toProtocolItem, type BlobRef, type TimelineItem } from '../domain/conversation/index.js'
import type { HistoryBackfill } from './readers.js'

/** Largest `items` part of one stream chunk (UTF-8 JSON bytes), well below the 4 MiB Router frame. */
export const SHARE_CHUNK_BYTES = 1024 * 1024
/** A long text field goes back inline only while its item stays below this. */
export const SHARE_ITEM_MAX = 1024 * 1024
/** Default `byteBudget` (device-meshcall 1.0 `ExportShareRequest`). */
export const SHARE_DEFAULT_BUDGET = 1024 * 1024
/** Native history projected per round before exporting a whole session, and the most rounds. */
const HISTORY_PAGE = 500
const HISTORY_ROUNDS = 40

export type ShareScope = 'session' | 'message'

export interface ShareExportRequest {
  sessionId: string
  scope: ShareScope
  /** `message` scope: the items to export; the ones not on this device are left out. */
  itemIds: readonly string[]
  /** Upper bound on the serialized items of the whole snapshot. */
  byteBudget: number
}

export interface ShareExport {
  items: Record<string, unknown>[]
  /** File ids the items reference (`fileId` anywhere in their content), in first-seen order. */
  attachmentIds: string[]
}

/** One `ExportShareChunk`: `items` concatenated and `attachments` united by the Server, in order. */
export interface ShareChunk {
  seq: number
  chunk: { items: Record<string, unknown>[]; attachments: string[] }
  end: boolean
}

export class ShareTooLarge extends Error {
  public readonly code = 'share_too_large'
  public constructor(message: string) {
    super(message)
    this.name = 'ShareTooLarge'
  }
}

export interface ShareExportDeps {
  readonly store: Pick<ConversationStore, 'timeline' | 'blobs'>
  readonly history: HistoryBackfill | null
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Projects the native history older than what is stored, so a whole-session share starts at the beginning. */
async function backfill(deps: ShareExportDeps, sessionId: string): Promise<void> {
  const history = deps.history
  if (history === null) return
  await history.ensureLatest(sessionId)
  for (let round = 0; await history.hasOlder(sessionId); round++) {
    if (round >= HISTORY_ROUNDS) throw new ShareTooLarge(`the session has more than ${HISTORY_ROUNDS * HISTORY_PAGE} items`)
    const oldest = (await deps.store.timeline.read(sessionId, 'after', null, 1, Number.MAX_SAFE_INTEGER)).items[0]?.orderSeq ?? null
    // Nothing added: the native record cannot be read now (its Runtime is not available); share what is stored.
    if (!(await history.ensureBefore(sessionId, oldest, HISTORY_PAGE))) return
  }
}

async function sessionItems(deps: ShareExportDeps, sessionId: string, budget: number): Promise<TimelineItem[]> {
  await backfill(deps, sessionId)
  const items: TimelineItem[] = []
  let bytes = 0
  let cursor: number | null = null
  for (;;) {
    const page = await deps.store.timeline.read(sessionId, 'after', cursor, PAGE_LIMIT_MAX, PAGE_BUDGET)
    items.push(...page.items)
    bytes += page.bytes
    if (bytes > budget) throw new ShareTooLarge(`the session is larger than ${budget} bytes`)
    const last = page.items.at(-1)
    if (!page.hasMore || last === undefined) return items
    cursor = last.orderSeq
  }
}

async function selectedItems(deps: ShareExportDeps, sessionId: string, itemIds: readonly string[]): Promise<TimelineItem[]> {
  const found = await Promise.all([...new Set(itemIds)].map(id => deps.store.timeline.get(sessionId, id)))
  return found.filter((item): item is TimelineItem => item !== null).sort((left, right) => left.orderSeq - right.orderSeq)
}

/** RFC 6901 pointer segments of `path` (`""` is the whole value). */
function segments(path: string): string[] | null {
  if (path === '') return []
  if (!path.startsWith('/')) return null
  return path.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
}

/** Replaces the string at `path` inside `root`; false when the path does not lead to a string. */
function replaceString(root: unknown, path: string, value: string): boolean {
  const parts = segments(path)
  if (parts === null || parts.length === 0) return false
  let node: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return false
    node = (node as Record<string, unknown>)[part]
  }
  const key = parts.at(-1)!
  if (node === null || typeof node !== 'object' || typeof (node as Record<string, unknown>)[key] !== 'string') return false
  ;(node as Record<string, unknown>)[key] = value
  return true
}

function isText(ref: BlobRef): boolean {
  return ref.mediaType !== null && ref.mediaType.startsWith('text/')
}

/**
 * The item as the share keeps it: long text moved to the blob store goes back in place while the item stays below
 * `SHARE_ITEM_MAX` and the snapshot below `room` more bytes. Media moved out stays a placeholder (the public page
 * has no way to expand it), and `blobRefs` are dropped (the Server keeps no copy of those blobs).
 */
async function shareItem(deps: ShareExportDeps, item: TimelineItem, room: number): Promise<{ item: Record<string, unknown>; grew: number }> {
  const { blobRefs, ...wire } = toProtocolItem(item) as unknown as Record<string, unknown> & { blobRefs?: BlobRef[] }
  const base = jsonBytes(wire)
  const texts = (blobRefs ?? []).filter(isText)
  if (texts.length === 0) return { item: wire, grew: 0 }
  const content = structuredClone(wire.content)
  let size = base
  for (const ref of texts) {
    // A UTF-8 text grows its item by at most its byte length plus JSON escaping; skip the read when it cannot fit.
    if (size + ref.bytes > SHARE_ITEM_MAX || size - base + ref.bytes > room) continue
    const bytes = await deps.store.blobs.read(ref.blobId)
    if (bytes === null) continue
    const candidate = structuredClone(content)
    if (!replaceString(candidate, ref.path, Buffer.from(bytes).toString('utf8'))) continue
    const next = jsonBytes({ ...wire, content: candidate })
    if (next > SHARE_ITEM_MAX || next - base > room) continue
    replaceString(content, ref.path, Buffer.from(bytes).toString('utf8'))
    size = next
  }
  return { item: { ...wire, content }, grew: size - base }
}

/** Every `fileId` string in `value`, in first-seen order (the Server collects references the same way). */
function fileIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) fileIds(entry, into)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'fileId' && typeof entry === 'string' && entry !== '') into.add(entry)
    else fileIds(entry, into)
  }
}

/**
 * The snapshot of `request`: a whole session (with its native history) or the selected items, in timeline order.
 * Refuses with `share_too_large` past `byteBudget` rather than sharing a cut snapshot.
 */
export async function exportShare(deps: ShareExportDeps, request: ShareExportRequest): Promise<ShareExport> {
  const budget = request.byteBudget > 0 ? request.byteBudget : SHARE_DEFAULT_BUDGET
  const stored = request.scope === 'session'
    ? await sessionItems(deps, request.sessionId, budget)
    : await selectedItems(deps, request.sessionId, request.itemIds)
  let total = stored.reduce((sum, item) => sum + jsonBytes(toProtocolItem(item)), 0)
  if (total > budget) throw new ShareTooLarge(`the selection is larger than ${budget} bytes`)
  const items: Record<string, unknown>[] = []
  const ids = new Set<string>()
  for (const item of stored) {
    const shared = await shareItem(deps, item, budget - total)
    total += shared.grew
    items.push(shared.item)
    fileIds(shared.item.content, ids)
  }
  return { items, attachmentIds: [...ids] }
}

/**
 * The stream items of a snapshot: `items` split so each chunk stays below `maxBytes` (an item never splits), the
 * attachments on the last one, which ends the stream. An empty snapshot is one empty, final chunk.
 */
export function shareChunks(items: readonly Record<string, unknown>[], attachments: readonly string[], maxBytes = SHARE_CHUNK_BYTES): ShareChunk[] {
  const groups: Record<string, unknown>[][] = [[]]
  // Bytes of the group serialized as a JSON array: brackets, items and the commas between them.
  let used = 2
  for (const item of items) {
    const size = jsonBytes(item)
    const current = groups.at(-1)!
    if (current.length > 0 && used + 1 + size > maxBytes) {
      groups.push([item])
      used = 2 + size
    } else {
      used += (current.length > 0 ? 1 : 0) + size
      current.push(item)
    }
  }
  return groups.map((group, index) => {
    const last = index === groups.length - 1
    return { seq: index, chunk: { items: group, attachments: last ? [...attachments] : [] }, end: last }
  })
}
