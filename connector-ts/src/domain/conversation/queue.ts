import { ConversationError } from './errors.js'

/**
 * The running-turn message queue, moved from the Server to the device (04-connector.md §5.8). Shape, events and
 * error codes are unchanged from v2 (`docs/api/session-message-queue.md`); the device is the single writer, so
 * dispatch needs neither a Redis claim nor a conditional update.
 */
export const QUEUE_MAX_ITEMS = 20

export type QueueItemStatus = 'queued' | 'sending' | 'failed'

export interface QueueAttachment {
  readonly fileId: string
  readonly name: string | null
  readonly mediaType: string | null
  readonly size: number | null
}

export interface QueueItem {
  readonly messageId: string
  readonly sessionId: string
  readonly clientMessageId: string
  readonly content: string
  readonly attachments: readonly QueueAttachment[]
  readonly status: QueueItemStatus
  readonly interruptRequested: boolean
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly error: { readonly code: string; readonly message: string } | null
}

export interface SessionQueue {
  readonly sessionId: string
  readonly revision: number
  readonly items: readonly QueueItem[]
  /** The previous turn ended with an error: dispatch waits for the user's `resume`, `retry` or `sendNow`. */
  readonly paused: boolean
}

/** `SessionQueueState` as clients read it (positions start at 1). */
export interface SessionQueueState {
  sessionId: string
  revision: number
  items: (Omit<QueueItem, 'attachments'> & { position: number; attachments: QueueAttachment[] })[]
}

export function emptyQueue(sessionId: string): SessionQueue {
  return { sessionId, revision: 0, items: [], paused: false }
}

export function queueState(queue: SessionQueue): SessionQueueState {
  return {
    sessionId: queue.sessionId,
    revision: queue.revision,
    items: queue.items.map((item, index) => ({ ...item, attachments: [...item.attachments], position: index + 1 })),
  }
}

function changed(queue: SessionQueue, items: readonly QueueItem[], paused = queue.paused): SessionQueue {
  return { sessionId: queue.sessionId, revision: queue.revision + 1, items, paused }
}

function find(queue: SessionQueue, messageId: string): { item: QueueItem; index: number } {
  const index = queue.items.findIndex(item => item.messageId === messageId)
  const item = queue.items[index]
  if (item === undefined) throw new ConversationError('queue_item_not_found', `queue item ${messageId} not found`)
  return { item, index }
}

function notSending(item: QueueItem): void {
  if (item.status === 'sending') throw new ConversationError('queue_item_sending', `queue item ${item.messageId} is being sent`)
}

export type EnqueueResult = { readonly queue: SessionQueue; readonly item: QueueItem; readonly duplicate: boolean }

/**
 * Appends (`auto`) or puts at the head and asks for an interrupt (`interrupt`). The same `clientMessageId`
 * is queued once; a repeat returns the existing item. A sending head stays first.
 */
export function enqueue(queue: SessionQueue, item: Omit<QueueItem, 'status' | 'interruptRequested' | 'error'>, mode: 'auto' | 'interrupt'): EnqueueResult {
  const existing = queue.items.find(entry => entry.clientMessageId === item.clientMessageId)
  if (existing !== undefined) return { queue, item: existing, duplicate: true }
  if (queue.items.length >= QUEUE_MAX_ITEMS) throw new ConversationError('queue_full', `the queue already holds ${QUEUE_MAX_ITEMS} messages`)
  const entry: QueueItem = { ...item, status: 'queued', interruptRequested: mode === 'interrupt', error: null }
  if (mode === 'auto') return { queue: changed(queue, [...queue.items, entry]), item: entry, duplicate: false }
  const head = queue.items[0]
  const items = head?.status === 'sending' ? [head, entry, ...queue.items.slice(1)] : [entry, ...queue.items]
  return { queue: changed(queue, items), item: entry, duplicate: false }
}

export function update(queue: SessionQueue, messageId: string, patch: { content?: string; attachments?: readonly QueueAttachment[] }, at: string): SessionQueue {
  const { item, index } = find(queue, messageId)
  notSending(item)
  const next: QueueItem = {
    ...item,
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.attachments !== undefined ? { attachments: patch.attachments } : {}),
    updatedAt: at,
  }
  return changed(queue, queue.items.map((entry, i) => (i === index ? next : entry)))
}

export function remove(queue: SessionQueue, messageId: string): { queue: SessionQueue; removed: QueueItem } {
  const { item } = find(queue, messageId)
  notSending(item)
  return { queue: changed(queue, queue.items.filter(entry => entry.messageId !== messageId)), removed: item }
}

/** A failed item goes back to `queued` in place; dispatch resumes. */
export function retry(queue: SessionQueue, messageId: string, at: string): SessionQueue {
  const { item, index } = find(queue, messageId)
  notSending(item)
  if (item.status !== 'failed') return queue
  const next: QueueItem = { ...item, status: 'queued', error: null, updatedAt: at }
  return changed(queue, queue.items.map((entry, i) => (i === index ? next : entry)), false)
}

/** Moves the item to the head (behind a sending item) and asks for an interrupt of the running turn. */
export function sendNow(queue: SessionQueue, messageId: string, at: string): SessionQueue {
  const { item } = find(queue, messageId)
  notSending(item)
  const moved: QueueItem = { ...item, status: 'queued', error: null, interruptRequested: true, updatedAt: at }
  const rest = queue.items.filter(entry => entry.messageId !== messageId)
  const head = rest[0]
  const items = head?.status === 'sending' ? [head, moved, ...rest.slice(1)] : [moved, ...rest]
  return changed(queue, items, false)
}

export function resume(queue: SessionQueue): SessionQueue {
  return queue.paused ? changed(queue, queue.items, false) : queue
}

/** Every item must be listed exactly once and a sending item must stay first (`queue_order_mismatch`). */
export function reorder(queue: SessionQueue, messageIds: readonly string[]): SessionQueue {
  const current = new Set(queue.items.map(item => item.messageId))
  const requested = new Set(messageIds)
  if (requested.size !== messageIds.length || requested.size !== current.size || ![...requested].every(id => current.has(id))) {
    throw new ConversationError('queue_order_mismatch', 'the new order must list every queued message exactly once')
  }
  const sending = queue.items.find(item => item.status === 'sending')
  if (sending !== undefined && messageIds[0] !== sending.messageId) {
    throw new ConversationError('queue_order_mismatch', 'the message being sent must stay first')
  }
  const byId = new Map(queue.items.map(item => [item.messageId, item]))
  return changed(queue, messageIds.map(id => byId.get(id) as QueueItem))
}

/** Clears everything except an item being sent. */
export function clear(queue: SessionQueue): { queue: SessionQueue; removed: QueueItem[] } {
  const keep = queue.items.filter(item => item.status === 'sending')
  const removed = queue.items.filter(item => item.status !== 'sending')
  if (removed.length === 0 && !queue.paused) return { queue, removed }
  return { queue: changed(queue, keep, false), removed }
}

/** Busy statuses from v2: a message cannot start a new turn while the session is in one of them. */
export const BUSY_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting', 'pending', 'waiting_approval', 'blocked', 'stopping'])

export type DispatchDecision =
  | { readonly kind: 'dispatch'; readonly item: QueueItem }
  /** The head asked for an interrupt and the session is busy: interrupt first, dispatch when idle. */
  | { readonly kind: 'interrupt'; readonly item: QueueItem }
  | { readonly kind: 'wait'; readonly reason: 'empty' | 'paused' | 'busy' | 'head_failed' | 'head_sending' | 'not_taken_over' | 'archived' }

/**
 * Only the head is dispatched, only when the session is `idle`. A failed head blocks the queue until the
 * user retries or deletes it; a paused queue waits for `resume`.
 */
export function nextDispatch(queue: SessionQueue, session: { status: string; takeover: boolean; archived: boolean }): DispatchDecision {
  const head = queue.items[0]
  if (head === undefined) return { kind: 'wait', reason: 'empty' }
  if (session.archived) return { kind: 'wait', reason: 'archived' }
  if (!session.takeover) return { kind: 'wait', reason: 'not_taken_over' }
  if (head.status === 'sending') return { kind: 'wait', reason: 'head_sending' }
  if (head.status === 'failed') return { kind: 'wait', reason: 'head_failed' }
  if (queue.paused) return { kind: 'wait', reason: 'paused' }
  if (BUSY_STATUSES.has(session.status)) return head.interruptRequested ? { kind: 'interrupt', item: head } : { kind: 'wait', reason: 'busy' }
  return { kind: 'dispatch', item: head }
}

export function markSending(queue: SessionQueue, messageId: string, at: string): SessionQueue {
  const { item, index } = find(queue, messageId)
  if (index !== 0) throw new ConversationError('invalid_transition', 'only the head of the queue is dispatched')
  if (item.status !== 'queued') throw new ConversationError('invalid_transition', `queue item ${messageId} is ${item.status}`)
  const next: QueueItem = { ...item, status: 'sending', updatedAt: at }
  return changed(queue, [next, ...queue.items.slice(1)])
}

/** Sent items leave the queue; there is no `sent` state. */
export function markSent(queue: SessionQueue, messageId: string): SessionQueue {
  if (!queue.items.some(item => item.messageId === messageId)) return queue
  return changed(queue, queue.items.filter(item => item.messageId !== messageId))
}

export function markFailed(queue: SessionQueue, messageId: string, error: { code: string; message: string }, at: string): SessionQueue {
  const { item, index } = find(queue, messageId)
  const next: QueueItem = { ...item, status: 'failed', interruptRequested: false, error, updatedAt: at }
  return changed(queue, queue.items.map((entry, i) => (i === index ? next : entry)))
}

/** A turn ending in error pauses the queue; the user decides whether to continue. */
export function onTurnEnded(queue: SessionQueue, outcome: 'idle' | 'error'): SessionQueue {
  if (outcome === 'error' && queue.items.length > 0 && !queue.paused) return changed(queue, queue.items, true)
  return queue
}

/**
 * After a crash in the middle of a dispatch: a `sending` item with acceptance evidence was sent (removed);
 * without it the outcome is unknown and the item fails with `queue_dispatch_unknown`. Never resent.
 */
export function recoverSending(queue: SessionQueue, wasAccepted: (item: QueueItem) => boolean, at: string): SessionQueue {
  let next = queue
  for (const item of queue.items) {
    if (item.status !== 'sending') continue
    next = wasAccepted(item)
      ? markSent(next, item.messageId)
      : markFailed(next, item.messageId, { code: 'queue_dispatch_unknown', message: 'The previous dispatch ended without a known outcome.' }, at)
  }
  return next
}

/** Archived sessions drop their queue at the next dispatch attempt. */
export function dropForArchive(queue: SessionQueue): SessionQueue {
  return queue.items.length === 0 ? queue : changed(queue, [], false)
}
