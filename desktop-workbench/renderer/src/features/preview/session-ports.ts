import type { ListeningPort, PortListeningEvent } from "@/generated/preview/v1_0/port-listening-event"
import type { PortClosedEvent } from "@/generated/preview/v1_0/port-closed-event"

export type { ListeningPort }

export const PORT_LISTENING_EVENT = "port.listening"
export const PORT_CLOSED_EVENT = "port.closed"

export function isPortEventType(type: string): boolean {
  return type === PORT_LISTENING_EVENT || type === PORT_CLOSED_EVENT
}

/**
 * The ports a session's Agent or terminals are serving. `port.listening` carries
 * the device's whole current list (09-port-preview.md §5.1); `port.closed` one port.
 */
export function applySessionPortEvent(
  current: ReadonlyMap<number, ListeningPort>,
  type: string,
  payload: Record<string, unknown>,
  sessionId: string,
): ReadonlyMap<number, ListeningPort> {
  if (type === PORT_LISTENING_EVENT) {
    const event = payload as Partial<PortListeningEvent>
    const ports = Array.isArray(event.ports) ? event.ports : []
    const next = new Map<number, ListeningPort>()
    for (const port of ports) {
      if (port && typeof port.port === "number" && port.sessionId === sessionId) next.set(port.port, port)
    }
    if (next.size === current.size && [...next].every(([key, value]) => sameListeningPort(current.get(key), value))) return current
    return next
  }
  if (type === PORT_CLOSED_EVENT) {
    const port = (payload as Partial<PortClosedEvent>).port
    if (typeof port !== "number" || !current.has(port)) return current
    const next = new Map(current)
    next.delete(port)
    return next
  }
  return current
}

function sameListeningPort(left: ListeningPort | undefined, right: ListeningPort): boolean {
  return Boolean(left) && left!.pid === right.pid && left!.processName === right.processName && left!.url === right.url
}

/** What the card shows for a port: the URL the Agent printed, or localhost. */
export function localPortUrl(port: ListeningPort): string {
  return port.url || `http://localhost:${port.port}`
}
