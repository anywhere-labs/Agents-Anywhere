import { onContentTransportRequired } from "@/lib/transport/content-transport"

/** Codes that mean this client must pair with the session's device before reading its content. */
export const SESSION_PAIRING_CODES: ReadonlySet<string> = new Set(["e2ee_not_paired", "e2ee_required", "device_pin_mismatch"])

// Recorded from the first request on, before any session view mounts: the very
// first snapshot read is usually the one that is refused.
const required = new Map<string, string>()
const listeners = new Set<() => void>()

onContentTransportRequired(({ sessionId, code }) => {
  if (!sessionId || !SESSION_PAIRING_CODES.has(code) || required.get(sessionId) === code) return
  required.set(sessionId, code)
  emit()
})

function emit() {
  for (const listener of listeners) listener()
}

/** The latest pairing code reported for this session's content (HTTPS or tunnel path), or null. */
export function sessionPairingCode(sessionId: string): string | null {
  return required.get(sessionId) ?? null
}

export function subscribeSessionPairing(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The device was paired (or the session reloaded fine): stop asking. */
export function clearSessionPairing(sessionId: string) {
  if (required.delete(sessionId)) emit()
}
