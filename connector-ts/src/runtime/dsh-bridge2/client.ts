/**
 * Calls into a 2.0 plugin's `aa.dsh.v2.Bridge` through the local Router
 * (v2 `connector/runtimes/dsh/bridge/client.py`).
 */
import { DeadlineExceededError, MeshCallClient, MeshCallError, UnavailableError, type CallOptions } from 'meshcall'
import type { Bridge2Calls, Json } from './relay.js'

export const BRIDGE_SERVICE = 'aa.dsh.v2.Bridge'
export const NAMESPACE_METADATA = 'aa-session-namespace'
export const CONNECTOR_METADATA = 'aa-connector-id'
export const BRIDGE2_PROTOCOL_VERSION = '2.0'
const DISCOVERY_RETRY_MS = 100
const DISCOVERY_BUDGET_MS = 2_000

/** MeshCall codes a 1.x caller knew under the plugin's error names. */
const PROTOCOL_CODES: Record<string, string> = {
  method_not_found: 'METHOD_NOT_FOUND',
  invalid_argument: 'INVALID_PARAMS',
  deadline_exceeded: 'REQUEST_TIMEOUT',
}

/** An answer from the plugin: `code` is its error name (`SESSION_NOT_FOUND` …). */
export class BridgeRpcError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details: Json = {}) { super(message) }
}

/** No plugin is registered on the Router, or the Router is gone. */
export class BridgeUnavailableError extends Error {}

export function bridgeError(error: unknown): Error {
  if (error instanceof UnavailableError) return new BridgeUnavailableError(error.message)
  if (error instanceof DeadlineExceededError) return new BridgeRpcError('REQUEST_TIMEOUT', error.message, true)
  if (error instanceof MeshCallError) {
    return new BridgeRpcError(PROTOCOL_CODES[error.code] ?? error.code, error.message, error.retryable, error.details ?? {})
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** The calls the Bridge client needs from a `Mesh` (unary and server streams). */
export interface MeshCalls {
  unary<Request, Response>(service: string, method: string, request: Request, options?: CallOptions): Promise<Response>
  serverStream<Request, Item>(service: string, method: string, request: Request, options?: CallOptions): AsyncIterable<Item>
}

const GUARDED = Symbol.for('agents-anywhere.meshcall.call-result-guard')
type GuardedPrototype = { registerCall?: (...args: unknown[]) => { result?: Promise<unknown> }, [GUARDED]?: true }

/**
 * dsh-bridge-next `meshcall-guard.ts`: meshcall 0.3.0 can reject a call's result
 * promise before anyone awaits it (aborted signal or local deadline while the open
 * frame is still being written). Mark it handled at registration; idempotent.
 */
export function guardMeshCallResults(): void {
  const prototype = MeshCallClient.prototype as unknown as GuardedPrototype
  const registerCall = prototype.registerCall
  if (prototype[GUARDED] || typeof registerCall !== 'function') return
  prototype.registerCall = function (this: unknown, ...args: unknown[]) {
    const registered = registerCall.apply(this, args)
    registered?.result?.catch(() => undefined)
    return registered
  }
  prototype[GUARDED] = true
}

export interface Bridge2ClientOptions {
  connectorId: string
  sessionNamespace: string
  clientVersion?: string
  requestTimeoutMs?: number
  /** Called once when a call finds the plugin gone. */
  onLost?: (error: Error) => void
}

export class Bridge2Client implements Bridge2Calls {
  initializeResult: Json | undefined
  private connectedFlag = false

  constructor(private readonly mesh: MeshCalls, private readonly options: Bridge2ClientOptions) {}

  get connected(): boolean { return this.connectedFlag }

  get metadata(): Record<string, string> {
    return { [NAMESPACE_METADATA]: this.options.sessionNamespace, [CONNECTOR_METADATA]: this.options.connectorId }
  }

  /**
   * The plugin needs a moment after the rendezvous appears to find the Router and
   * register; wait for it within a short budget, then report it unavailable.
   */
  async start(budgetMs = DISCOVERY_BUDGET_MS): Promise<Json> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      try {
        const result = await this.request('initialize', { protocolVersion: BRIDGE2_PROTOCOL_VERSION, runtime: 'dsh',
          clientInfo: { name: 'agents-anywhere-connector', version: this.options.clientVersion ?? BRIDGE2_PROTOCOL_VERSION } },
        Math.max(100, deadline - Date.now()))
        const identity = result.identity as Json | undefined
        if (identity?.runtime !== 'dsh') throw new Error('DSH bridge returned an invalid identity')
        if (!String(identity.protocolVersion ?? '').startsWith('2.')) throw new Error('DSH bridge protocol is incompatible')
        this.initializeResult = result
        this.connectedFlag = true
        return result
      } catch (error) {
        if (!(error instanceof BridgeUnavailableError) || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, Math.min(DISCOVERY_RETRY_MS, deadline - Date.now())))
      }
    }
  }

  async request(method: string, params: Json = {}, timeoutMs?: number): Promise<Json> {
    try {
      return await this.mesh.unary<Json, Json>(BRIDGE_SERVICE, method, params,
        { timeoutMs: timeoutMs ?? this.options.requestTimeoutMs ?? 30_000, metadata: this.metadata })
    } catch (error) {
      const mapped = bridgeError(error)
      if (mapped instanceof BridgeUnavailableError) this.lost(mapped)
      throw mapped
    }
  }

  async *stream(method: string, params: Json, signal: AbortSignal): AsyncIterable<Json> {
    try {
      for await (const item of this.mesh.serverStream<Json, Json>(BRIDGE_SERVICE, method, params, { signal, metadata: this.metadata })) yield item
    } catch (error) {
      if (signal.aborted) return
      const mapped = bridgeError(error)
      if (mapped instanceof BridgeUnavailableError) this.lost(mapped)
      throw mapped
    }
  }

  private lost(error: Error): void {
    if (!this.connectedFlag) return
    this.connectedFlag = false
    this.options.onLost?.(error)
  }
}
