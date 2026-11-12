import { MeshCallClient } from 'meshcall'

const GUARDED = Symbol.for('agents-anywhere.meshcall.call-result-guard')

interface RegisteredCall { result?: Promise<unknown> }
type GuardedPrototype = { registerCall?: (...args: unknown[]) => RegisteredCall, [GUARDED]?: true }

/**
 * meshcall 0.3.0 creates a unary or client-stream call's result promise before
 * it writes the call.open frame, and awaits that promise only once the write
 * completes. A write waits for the socket, so a busy Connector can hold it for
 * seconds. If the caller's signal aborts (SyncFeed.close) or the local deadline
 * fires (`timeoutMs`) in that window, the result rejects while nobody holds it.
 * Node reports an unhandled rejection, and DSH's fail-loud exits the whole Host
 * (#499, #517), although the call site would have received and handled it.
 *
 * Marking the promise handled at registration closes the window: the call site
 * still awaits the same promise and receives the same error. Idempotent; a
 * meshcall without this method needs no guard.
 */
export function guardMeshCallResults(): void {
  const prototype = MeshCallClient.prototype as unknown as GuardedPrototype
  const registerCall = prototype.registerCall
  if (prototype[GUARDED] || typeof registerCall !== 'function') return
  prototype.registerCall = function (this: unknown, ...args: unknown[]): RegisteredCall {
    const registered = registerCall.apply(this, args)
    registered?.result?.catch(() => undefined)
    return registered
  }
  prototype[GUARDED] = true
}
