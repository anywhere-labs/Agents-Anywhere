// Module-level E2EE state the rest of the client feeds without depending on the trust layer:
// the Server's declaration from `/auth/config` and which device holds each session (from the session list).

export type ServerE2eeMode = "off" | "required"

let declared: ServerE2eeMode | null = null
const sessionDevices = new Map<string, string>()
const listeners = new Set<(mode: ServerE2eeMode) => void>()

/** `/auth/config` said this. Only `required` has an effect; `off` never relaxes a client that already requires. */
export function declareServerE2ee(mode: ServerE2eeMode | null | undefined): void {
  if (mode !== "required" && mode !== "off") return
  declared = mode
  for (const listener of listeners) listener(mode)
}

export function serverE2eeDeclaration(): ServerE2eeMode | null {
  return declared
}

export function onServerE2eeDeclared(listener: (mode: ServerE2eeMode) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteSessionDevices(sessions: readonly { id: string; connectorId?: string | null }[] | null | undefined): void {
  for (const session of sessions ?? []) if (session.connectorId) sessionDevices.set(session.id, session.connectorId)
}

export function knownSessionDevice(sessionId: string): string | undefined {
  return sessionDevices.get(sessionId)
}

const pairingRequests = new Set<(deviceId: string | null) => void>()

/** Opens the pairing dialog (for a device when known). Any screen may call it, any number of times. */
export function requestSecurePairing(deviceId?: string | null): void {
  for (const listener of pairingRequests) listener(deviceId ?? null)
}

export function onSecurePairingRequested(listener: (deviceId: string | null) => void): () => void {
  pairingRequests.add(listener)
  return () => pairingRequests.delete(listener)
}
