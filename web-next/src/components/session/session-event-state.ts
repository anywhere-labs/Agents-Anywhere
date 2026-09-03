import type {
  ProtocolCapabilitySet,
  ProtocolEventEnvelope,
} from "@/features/dashboard/types"

const LIVE_PROJECTION_EVENT_TYPES = new Set<ProtocolEventEnvelope["type"]>([
  "session.meta.updated",
  "runtime.state.updated",
  "runtime.capability.updated",
  "runtime.catalog.updated",
])

export class SessionEventSequenceCursor {
  private sessionId: string
  private nextSeq: number

  constructor(sessionId: string, nextSeq = 0) {
    this.sessionId = sessionId
    this.nextSeq = nextSeq
  }

  switchTo(sessionId: string, nextSeq = 0): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.nextSeq = nextSeq
  }

  advance(sessionId: string, nextSeq: number): void {
    if (this.sessionId !== sessionId) return
    this.nextSeq = Math.max(this.nextSeq, nextSeq)
  }

  replaceFromSnapshot(sessionId: string, nextSeq: number): void {
    if (this.sessionId !== sessionId) return
    this.nextSeq = nextSeq
  }

  current(sessionId: string): number {
    return this.sessionId === sessionId ? this.nextSeq : 0
  }

  accepts(sessionId: string, sequence: number): boolean {
    return this.sessionId === sessionId && sequence >= this.nextSeq
  }
}

export function drainSessionEventBuffer(
  events: readonly ProtocolEventEnvelope[],
  applyEvent: (event: ProtocolEventEnvelope) => void,
  shouldPause: () => boolean = () => false,
): ProtocolEventEnvelope[] {
  const pending = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => (
      left.event.sequence - right.event.sequence || left.index - right.index
    ))

  for (let index = 0; index < pending.length; index += 1) {
    if (shouldPause()) {
      return pending.slice(index).map(({ event }) => event)
    }
    const entry = pending[index]
    if (entry) applyEvent(entry.event)
  }
  return []
}

export async function settleSessionEventRecovery(
  recovery: Promise<void>,
  releaseRecovery: () => void,
  drainBufferedEvents: () => void,
): Promise<void> {
  try {
    await recovery
  } finally {
    // The drain must observe an inactive recovery gate. Otherwise every
    // buffered event is paused and can remain stranded indefinitely.
    releaseRecovery()
    drainBufferedEvents()
  }
}

export function sessionEventUsesDurableEventIdDedup(
  event: ProtocolEventEnvelope,
): boolean {
  return !LIVE_PROJECTION_EVENT_TYPES.has(event.type)
}

export function acceptSessionEventId(
  event: ProtocolEventEnvelope,
  processedEventIds: Set<string>,
): boolean {
  if (!sessionEventUsesDurableEventIdDedup(event)) return true
  if (processedEventIds.has(event.eventId)) return false
  processedEventIds.add(event.eventId)
  return true
}

export function bufferedEventsAfterLiveCapabilityRead(
  bufferedBeforeRead: ProtocolEventEnvelope[],
  bufferedDuringRead: ProtocolEventEnvelope[],
  liveReadSucceeded: boolean,
): ProtocolEventEnvelope[] {
  const eventsBeforeRead = liveReadSucceeded
    ? bufferedBeforeRead.filter((event) => event.type !== "runtime.capability.updated")
    : bufferedBeforeRead
  return [...eventsBeforeRead, ...bufferedDuringRead]
}

export function mergeEffectiveCapabilities(
  current: ProtocolCapabilitySet | null,
  incoming: ProtocolCapabilitySet | null,
): ProtocolCapabilitySet | null {
  if (!incoming || capabilitySetsSemanticallyEqual(current, incoming)) return current
  return incoming
}

export function capabilitySetsSemanticallyEqual(
  left: ProtocolCapabilitySet | null,
  right: ProtocolCapabilitySet,
): boolean {
  if (!left) return false
  return stableStringify(capabilitySetSemanticValue(left)) === stableStringify(capabilitySetSemanticValue(right))
}

function capabilitySetSemanticValue(value: ProtocolCapabilitySet) {
  return [...value.capabilities]
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
