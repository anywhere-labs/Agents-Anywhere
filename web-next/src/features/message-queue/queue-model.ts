/**
 * Pure rules for the server-owned session message queue.
 *
 * The server owns the queue; clients only show it and decide how a new
 * message is delivered. Kept free of React and path aliases so node tests
 * can import it directly.
 */

export type QueueItemStatus = "queued" | "sending" | "failed"

export type QueueItemView = {
  messageId: string
  sessionId: string
  clientMessageId: string
  content: string
  status: QueueItemStatus
  position: number
  interruptRequested: boolean
  error: { code: string; message: string } | null
  [key: string]: unknown
}

export type QueueStateView = {
  sessionId: string
  revision: number
  items: QueueItemView[]
  [key: string]: unknown
}

/** How the composer delivers a message. */
export type MessageDelivery = "send" | "queue" | "interrupt" | "steer"

/** Session states in which a new message waits instead of starting a turn. */
export const QUEUEABLE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "pending",
  "waiting_approval",
  "blocked",
  "stopping",
])

/** Keep the newest whole-queue snapshot; an older revision never wins. */
export function mergeQueueState<T extends QueueStateView>(current: T | null, next: T | null | undefined): T | null {
  if (!next) return current
  if (current && current.sessionId === next.sessionId && current.revision > next.revision) return current
  return next
}

export function readQueueState(value: unknown): QueueStateView | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== "string" || typeof record.revision !== "number" || !Array.isArray(record.items)) {
    return null
  }
  return record as QueueStateView
}

/**
 * Whether a new message has to wait in the queue.
 *
 * A message also waits behind earlier ones, so the queue keeps its order
 * when the session is momentarily idle.
 */
export function messageMustWait(status: string | null | undefined, queue: QueueStateView | null): boolean {
  return QUEUEABLE_STATUSES.has(status ?? "") || Boolean(queue && queue.items.length > 0)
}

/** The queue stopped: its head failed, or the last turn ended in an error. */
export function queuePause(
  status: string | null | undefined,
  queue: QueueStateView | null,
): "failed" | "error" | null {
  const head = queue?.items[0]
  if (!head) return null
  if (head.status === "failed") return "failed"
  if (status === "error" && head.status === "queued") return "error"
  return null
}

export function queueItemEditable(item: QueueItemView): boolean {
  return item.status !== "sending"
}

/** The queue the server returned with a queued message, if any. */
export function queuedDelivery(result: unknown): QueueStateView | null | undefined {
  if (!result || typeof result !== "object") return undefined
  const record = result as Record<string, unknown>
  if (record.delivery !== "queued") return undefined
  return readQueueState(record.queue)
}
