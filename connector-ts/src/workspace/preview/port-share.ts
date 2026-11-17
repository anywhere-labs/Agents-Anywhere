// PortShare (09-port-preview.md §4.1): which local ports this device agrees to expose through a preview.
import { WorkspaceError } from '../errors.js'
import type { ListeningPort } from '../ports.js'

/** At most this many previews may be open on one device at a time (09 §4.1, preview 1.0 README). */
export const MAX_OPEN_PREVIEWS = 8

const LOOPBACK_V4 = /^127\./u
const isWildcard = (address: string): boolean => address === '0.0.0.0' || address === '::' || address === '*'
const isLoopback = (address: string): boolean =>
  LOOPBACK_V4.test(address) || address === '::1' || address === 'localhost' || /^::ffff:127\./u.test(address)

/**
 * The loopback address to forward to, or null when the port is not reachable on loopback. A service bound only to a
 * LAN address (say 192.168.1.5:3000) is refused: the device must never become a hop into the user's network.
 */
export function loopbackTarget(bindings: readonly ListeningPort[]): '127.0.0.1' | '::1' | null {
  if (bindings.some(b => isWildcard(b.address) || LOOPBACK_V4.test(b.address) || /^::ffff:127\./u.test(b.address))) return '127.0.0.1'
  if (bindings.some(b => b.address === '::1')) return '::1'
  if (bindings.some(b => isLoopback(b.address))) return '127.0.0.1'
  return null
}

export interface PortShareDecision {
  readonly port: number
  readonly localIP: '127.0.0.1' | '::1'
}

/**
 * Checks one preview request against the PortShare rules: the port must be listening now, reachable on loopback,
 * and the device must have room for another preview. The user confirmed the port by asking for the preview, which
 * is the only way the Server sends `Commands/previewOpen`. Error codes follow contracts/runtime-errors 1.1;
 * `details.reason` tells a closed port (`not_listening`) from one bound off loopback (`not_local`).
 */
export function decidePortShare(
  port: number,
  listening: readonly ListeningPort[],
  openPreviews: number,
  alreadyOpen: boolean,
): PortShareDecision {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WorkspaceError('invalid_argument', `invalid port: ${port}`)
  const bindings = listening.filter(entry => entry.port === port)
  if (bindings.length === 0) throw new WorkspaceError('preview_port_not_allowed', `nothing is listening on port ${port}`, { port, reason: 'not_listening' })
  const localIP = loopbackTarget(bindings)
  if (localIP === null) {
    throw new WorkspaceError('preview_port_not_allowed', `port ${port} is not reachable on this computer's loopback address`, { port, reason: 'not_local' })
  }
  if (!alreadyOpen && openPreviews >= MAX_OPEN_PREVIEWS) {
    throw new WorkspaceError('preview_limit_reached', `at most ${MAX_OPEN_PREVIEWS} previews can be open on one device`, { limit: MAX_OPEN_PREVIEWS })
  }
  return { port, localIP }
}
