import type { ProtocolEventEnvelope, TimelineItem } from "@/features/dashboard/types"

export const SESSION_EVENT_FLUSH_MS = Math.ceil(1000 / 30)

/** Upserts contain complete items. Only intermediate revisions may be omitted. */
export function coalesceSessionEvents(events: ProtocolEventEnvelope[]): ProtocolEventEnvelope[] {
  const result: ProtocolEventEnvelope[] = []
  const items = new Map<string, ProtocolEventEnvelope>()
  const drain = () => {
    result.push(...[...items.values()].sort((a, b) => a.sequence - b.sequence))
    items.clear()
  }
  for (const event of events) {
    const item = event.payload.item as TimelineItem | undefined
    if ((event.type === "timeline.item_created" || event.type === "timeline.item_updated") &&
        item && typeof item.id === "string" && typeof item.updatedSeq === "number") {
      const key = JSON.stringify([event.sessionId, item.id])
      const previous = items.get(key)
      // Preserve anomalous older revisions for the existing sequence validator.
      if (previous && (previous.payload.item as TimelineItem).updatedSeq > item.updatedSeq) drain()
      items.set(key, event)
    } else {
      // Snapshots, lifecycle and interaction events are ordering barriers.
      drain()
      result.push(event)
    }
  }
  drain()
  return result
}

export function createSessionEventBuffer(commit: (events: ProtocolEventEnvelope[]) => void) {
  let pending: ProtocolEventEnvelope[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  return {
    push(event: ProtocolEventEnvelope) {
      if (disposed) return
      pending.push(event)
      // A fixed window, not debounce: continuous output cannot postpone a flush.
      timer ??= setTimeout(() => {
        timer = undefined
        if (disposed) return
        const events = pending
        pending = []
        commit(coalesceSessionEvents(events))
      }, SESSION_EVENT_FLUSH_MS)
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = []
    },
  }
}
