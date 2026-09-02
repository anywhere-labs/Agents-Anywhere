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
