import { sha256Hex } from '../identity/hash.js'
import { pythonJsonDumps, type JsonValue } from '../identity/python-json.js'
import { ConversationError } from './errors.js'

export type TimelineItemType = 'message' | 'tool' | 'artifact' | 'marker' | 'system'
export type TimelineItemStatus = 'pending' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled' | 'interrupted'
export type TimelineRole = 'user' | 'assistant' | 'system' | 'tool'

export const TIMELINE_ITEM_TYPES: ReadonlySet<string> = new Set<TimelineItemType>(['message', 'tool', 'artifact', 'marker', 'system'])
export const TIMELINE_ITEM_STATUSES: ReadonlySet<string> = new Set<TimelineItemStatus>([
  'pending', 'running', 'waiting_approval', 'done', 'failed', 'cancelled', 'interrupted',
])
export const TERMINAL_ITEM_STATUSES: ReadonlySet<string> = new Set<TimelineItemStatus>(['done', 'failed', 'cancelled', 'interrupted'])

export type JsonObject = { [key: string]: JsonValue }

/** Where an item came from (protocol `TimelineSource`); `runtime` is the runtime type or `platform`. */
export interface TimelineSource {
  readonly runtime: string
  readonly sessionId?: string | null
  readonly itemId?: string | null
  readonly itemType?: string | null
  readonly event?: string | null
  readonly derivedKey?: string | null
  readonly clientMessageId?: string | null
}

/**
 * A large field moved out of the item into the local blob store (04-connector.md §6.4). The item keeps a
 * preview at `path` (JSON pointer inside `content`); clients expand it through `Store/readBlob`.
 */
export interface BlobRef {
  readonly path: string
  readonly blobId: string
  readonly bytes: number
  readonly mediaType: string | null
}

/**
 * What a projection produces: an item without the clock-owned fields. The id is computed by
 * `domain/identity` so it is the same on every path (live event, history read, paging, IPC).
 */
export interface TimelineDraft {
  readonly id: string
  readonly type: TimelineItemType
  readonly status: TimelineItemStatus
  readonly role: TimelineRole | null
  readonly orderSeq: number
  readonly content: JsonObject
  readonly source: TimelineSource
  readonly createdAt: string
  readonly completedAt?: string | null
  /** Set by the store's byte budget; projections leave it out. */
  readonly blobRefs?: readonly BlobRef[]
}

/** A stored item: the draft plus what the Conversation owns (revision, hash, clock position). */
export interface TimelineItem extends TimelineDraft {
  readonly sessionId: string
  readonly revision: number
  readonly contentHash: string
  readonly updatedSeq: number
  readonly updatedAt: string
}

/** Sub-positions per native record: `orderSeq = nativeIndex × 1024 + subIndex` (04-connector.md §6.6). */
export const ORDER_SUB_SLOTS = 1024

/**
 * Order is fixed by the native position, so projecting the tail first and the head later still sorts
 * correctly without renumbering.
 */
export function orderSeqOf(nativeIndex: number, subIndex = 0): number {
  if (!Number.isSafeInteger(nativeIndex) || nativeIndex < 0) throw new ConversationError('invalid_argument', 'nativeIndex must be a non-negative integer')
  if (!Number.isInteger(subIndex) || subIndex < 0 || subIndex >= ORDER_SUB_SLOTS) {
    throw new ConversationError('invalid_argument', `subIndex must be within [0, ${ORDER_SUB_SLOTS})`)
  }
  const value = nativeIndex * ORDER_SUB_SLOTS + subIndex
  if (!Number.isSafeInteger(value)) throw new ConversationError('invalid_argument', 'orderSeq exceeds the safe integer range')
  return value
}

/**
 * v2 `runtime_protocol/timeline.py` `timeline_content_hash`: sha256 of
 * `json.dumps({type,status,role,content}, ensure_ascii=False, sort_keys=True, separators=(',', ':'))`.
 * It identifies the current state only; equal hashes never mean "same item" (ids do).
 */
export function timelineContentHash(type: TimelineItemType, status: TimelineItemStatus, role: TimelineRole | null, content: JsonObject): string {
  const encoded = pythonJsonDumps({ type, status, role, content }, { sortKeys: true, ensureAscii: false })
  return `sha256:${sha256Hex(escapeLoneSurrogates(encoded))}`
}

/** JavaScript keeps a lone surrogate as `\udXXX`; v2 mirrors that before hashing so plugin and Python agree. */
function escapeLoneSurrogates(text: string): string {
  if (text.isWellFormed()) return text
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] as string
        out += text[i + 1] as string
        i++
        continue
      }
      out += `\\u${unit.toString(16)}`
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += `\\u${unit.toString(16)}`
      continue
    }
    out += text[i] as string
  }
  return out
}

export function validateDraft(draft: TimelineDraft): void {
  if (!draft.id) throw new ConversationError('invalid_argument', 'timeline item id is empty')
  if (!TIMELINE_ITEM_TYPES.has(draft.type)) throw new ConversationError('invalid_argument', `unknown timeline item type ${draft.type}`)
  if (!TIMELINE_ITEM_STATUSES.has(draft.status)) throw new ConversationError('invalid_argument', `unknown timeline item status ${draft.status}`)
  if (!Number.isSafeInteger(draft.orderSeq) || draft.orderSeq < 0) throw new ConversationError('invalid_argument', 'orderSeq must be a non-negative integer')
  if (!draft.source.runtime) throw new ConversationError('invalid_argument', 'timeline source runtime is empty')
}

export type UpsertDecision =
  | { readonly kind: 'unchanged'; readonly item: TimelineItem }
  /** `item` lacks the clock fields; the caller stamps `updatedSeq` and `updatedAt` from the session clock. */
  | { readonly kind: 'insert' | 'update'; readonly item: Omit<TimelineItem, 'updatedSeq' | 'updatedAt'> }

/**
 * Decides what an upsert does. Identical state (same hash and position) does not tick the clock, so
 * replaying a history page or a duplicate runtime event produces no client traffic.
 */
export function decideUpsert(sessionId: string, existing: TimelineItem | undefined, draft: TimelineDraft): UpsertDecision {
  validateDraft(draft)
  const contentHash = timelineContentHash(draft.type, draft.status, draft.role, draft.content)
  if (existing === undefined) {
    return { kind: 'insert', item: { ...withoutUndefined(draft), sessionId, revision: 1, contentHash } }
  }
  if (
    existing.contentHash === contentHash
    && existing.orderSeq === draft.orderSeq
    && sameSource(existing.source, draft.source)
    && (existing.completedAt ?? null) === (draft.completedAt ?? null)
    && JSON.stringify(existing.blobRefs ?? []) === JSON.stringify(draft.blobRefs ?? [])
  ) {
    return { kind: 'unchanged', item: existing }
  }
  return {
    kind: 'update',
    item: {
      ...withoutUndefined(draft),
      // The first sighting fixes when the item was created; later projections cannot move it.
      createdAt: existing.createdAt,
      sessionId,
      revision: existing.revision + 1,
      contentHash,
    },
  }
}

function sameSource(left: TimelineSource, right: TimelineSource): boolean {
  const keys: (keyof TimelineSource)[] = ['runtime', 'sessionId', 'itemId', 'itemType', 'event', 'derivedKey', 'clientMessageId']
  return keys.every(key => (left[key] ?? null) === (right[key] ?? null))
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

/** The item as protocol 1.1/1.2 clients read it (`TimelineItem` in `session-snapshot-response`). */
export interface ProtocolTimelineItem {
  id: string
  sessionId: string
  type: TimelineItemType
  status: TimelineItemStatus
  role: TimelineRole | null
  orderSeq: number
  updatedSeq: number
  revision: number
  contentHash: string
  content: JsonObject
  source: TimelineSource
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** Present only when fields were moved to blobs; v2 clients ignore it. */
  blobRefs?: BlobRef[]
}

export function toProtocolItem(item: TimelineItem): ProtocolTimelineItem {
  return {
    id: item.id,
    sessionId: item.sessionId,
    type: item.type,
    status: item.status,
    role: item.role,
    orderSeq: item.orderSeq,
    updatedSeq: item.updatedSeq,
    revision: item.revision,
    contentHash: item.contentHash,
    content: item.content,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt ?? null,
    ...(item.blobRefs !== undefined && item.blobRefs.length > 0 ? { blobRefs: [...item.blobRefs] } : {}),
  }
}
