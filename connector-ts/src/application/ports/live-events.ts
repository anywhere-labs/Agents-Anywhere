/**
 * Lossy live facts the device pushes to the Server on `Link/attach` (06-protocols.md §2.5): runtime status,
 * notices, queue state, capability and catalog changes, port events. They are current-state projections that
 * clients can re-read, so losing one is harmless; nothing here is persisted.
 */
export interface LiveEvents {
  /** `method` is the v2 event name (`runtime.notice.updated`, `runtime.queue.updated`, …). */
  emit(method: string, payload: Record<string, unknown>): void
}
