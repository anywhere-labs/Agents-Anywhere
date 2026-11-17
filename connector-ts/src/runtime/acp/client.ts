// ported from effi-evo cloud/agentd/src/conv/agent-process.ts @95b52ec (session routing, early buffering, replay capture)
//
// ACP Client Core: the client side of one ACP connection.
// - The wire layer is its own JsonRpcPeer (jsonrpc.ts); reverse extension requests are handed to sessions by
//   sessionId, and unknown ones get method_not_found.
// - Protocol version negotiation (v1 / v2) and initialize `_meta` extension negotiation live here; dialects only
//   read the results.
// - The fs / terminal client capabilities are not declared: AA files and terminals use separate channels, and
//   Codex, Claude, Pi and Hermes do not depend on them.

import { ErrorCodes, JsonRpcError, type JsonRpcPeer, type RequestContext, type RequestOptions } from './jsonrpc.js'

export const CLIENT_INFO = { name: 'agents-anywhere', version: '3.0.0' } as const

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonRecord = { [key: string]: Json }

export interface InitializeOptions {
  /** Highest protocol version the client supports; the Agent answers with the version it supports (<=). */
  readonly protocolVersion: 1 | 2
  readonly clientCapabilities: JsonRecord
  /** Top-level initialize `_meta` (extension negotiation, e.g. `codexIpc`). */
  readonly meta?: JsonRecord
  readonly timeoutMs?: number
}

export interface AgentInfo {
  readonly protocolVersion: number
  readonly agentCapabilities: JsonRecord
  readonly agentInfo: { readonly name?: string; readonly version?: string; readonly title?: string }
  readonly authMethods: readonly JsonRecord[]
  /** Top-level `_meta` of the initialize response. */
  readonly meta: JsonRecord
}

/** The receiver on the session side. A session ID has exactly one sink (main and sub-Agent sessions both register by ID). */
export interface SessionSink {
  onUpdate(update: JsonRecord, notification: JsonRecord): void
  /** Session-scoped reverse requests: permissions, forms, `_codex/session/history_reset`, etc. */
  onRequest(method: string, params: JsonRecord, context: RequestContext): Promise<unknown>
}

/** Updates the Agent pushes before session/new returns (e.g. available commands), held until a session claims them. */
const EARLY_SESSIONS = 32
const EARLY_UPDATES = 200
const EARLY_MS = 120_000

export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

export function getPath(value: unknown, ...path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export class AcpClient {
  info: AgentInfo | undefined
  private readonly sinks = new Map<string, SessionSink>()
  private readonly captures = new Map<string, (update: JsonRecord) => void>()
  private readonly early = new Map<string, { at: number; updates: JsonRecord[] }>()
  private globalRequest: ((method: string, params: JsonRecord, context: RequestContext) => Promise<unknown>) | undefined
  private readonly notificationListeners = new Map<string, ((params: JsonRecord) => void)[]>()
  /** Time of the last traffic of any kind (ms), used for idle reclamation. */
  lastActivity = Date.now()

  constructor(readonly peer: JsonRpcPeer) {
    peer.onNotification('session/update', params => this.routeUpdate(asRecord(params)))
    peer.onUnknownRequest((params, context) => this.routeRequest(context.method, asRecord(params), context))
    peer.onUnknownNotification((params, method) => {
      this.lastActivity = Date.now()
      for (const listener of this.notificationListeners.get(method) ?? []) listener(asRecord(params))
    })
  }

  get protocolVersion(): number {
    return this.info?.protocolVersion ?? 1
  }

  async initialize(options: InitializeOptions): Promise<AgentInfo> {
    const params: JsonRecord = {
      protocolVersion: options.protocolVersion,
      clientCapabilities: options.clientCapabilities,
      clientInfo: { ...CLIENT_INFO },
      ...(options.meta ? { _meta: options.meta } : {}),
    }
    const result = asRecord(await this.request('initialize', params, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }))
    const version = typeof result.protocolVersion === 'number' ? result.protocolVersion : 1
    if (version > options.protocolVersion || version < 1) {
      throw new JsonRpcError(ErrorCodes.invalidRequest, `agent answered unsupported ACP protocol version ${version}`)
    }
    this.info = {
      protocolVersion: version,
      agentCapabilities: asRecord(result.agentCapabilities),
      agentInfo: asRecord(result.agentInfo) as AgentInfo['agentInfo'],
      authMethods: Array.isArray(result.authMethods) ? result.authMethods.map(asRecord) : [],
      meta: asRecord(result._meta),
    }
    return this.info
  }

  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    this.lastActivity = Date.now()
    return this.peer.request<T>(method, params, options).finally(() => {
      this.lastActivity = Date.now()
    })
  }

  notify(method: string, params?: unknown): void {
    this.lastActivity = Date.now()
    this.peer.notify(method, params)
  }

  /** Reverse requests no session claims (e.g. global requests other than `_session/list/changes`). */
  onGlobalRequest(handler: (method: string, params: JsonRecord, context: RequestContext) => Promise<unknown>): void {
    this.globalRequest = handler
  }

  /** Notifications other than session/update (e.g. `_session/list/changes`, `_auth/status_update`). */
  onNotification(method: string, listener: (params: JsonRecord) => void): () => void {
    const list = this.notificationListeners.get(method) ?? []
    list.push(listener)
    this.notificationListeners.set(method, list)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /** Claims a session ID; previously buffered updates are delivered at once. Returns a release function. */
  attach(sessionId: string, sink: SessionSink): () => void {
    this.sinks.set(sessionId, sink)
    const early = this.early.get(sessionId)
    this.early.delete(sessionId)
    for (const notification of early?.updates ?? []) sink.onUpdate(asRecord(notification.update), notification)
    return () => {
      if (this.sinks.get(sessionId) === sink) this.sinks.delete(sessionId)
    }
  }

  attached(sessionId: string): boolean {
    return this.sinks.has(sessionId)
  }

  get attachedCount(): number {
    return this.sinks.size
  }

  /**
   * Collects the session's updates while fn runs (read-only replay: session/load history arrives before the
   * response). Collected updates are not handed to the sink.
   */
  async capture<T>(sessionId: string, fn: () => Promise<T>): Promise<{ result: T; updates: JsonRecord[] }> {
    const updates: JsonRecord[] = []
    this.captures.set(sessionId, update => updates.push(update))
    try {
      const result = await fn()
      return { result, updates }
    } finally {
      this.captures.delete(sessionId)
    }
  }

  private routeUpdate(notification: JsonRecord): void {
    this.lastActivity = Date.now()
    const sessionId = notification.sessionId
    if (typeof sessionId !== 'string') return
    const update = asRecord(notification.update)
    const capture = this.captures.get(sessionId)
    if (capture) return capture(update)
    const sink = this.sinks.get(sessionId)
    if (sink) return sink.onUpdate(update, notification)
    this.keepEarly(sessionId, notification)
  }

  private keepEarly(sessionId: string, notification: JsonRecord): void {
    const now = Date.now()
    for (const [id, entry] of this.early) if (now - entry.at > EARLY_MS) this.early.delete(id)
    let entry = this.early.get(sessionId)
    if (!entry) {
      if (this.early.size >= EARLY_SESSIONS) {
        const oldest = this.early.keys().next().value
        if (oldest !== undefined) this.early.delete(oldest)
      }
      entry = { at: now, updates: [] }
      this.early.set(sessionId, entry)
    }
    if (entry.updates.length < EARLY_UPDATES) entry.updates.push(notification)
  }

  private async routeRequest(method: string, params: JsonRecord, context: RequestContext): Promise<unknown> {
    this.lastActivity = Date.now()
    const sessionId = params.sessionId
    if (typeof sessionId === 'string') {
      const sink = this.sinks.get(sessionId)
      if (sink) return sink.onRequest(method, params, context)
    }
    if (this.globalRequest) return this.globalRequest(method, params, context)
    if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
    throw JsonRpcError.methodNotFound(method)
  }
}

export function isMethodNotFound(error: unknown): boolean {
  return error instanceof JsonRpcError && error.code === ErrorCodes.methodNotFound
}

export function isInvalidParams(error: unknown): boolean {
  return error instanceof JsonRpcError && error.code === ErrorCodes.invalidParams
}

/** Readable description of an ACP error. */
export function describeAcpError(error: unknown): string {
  if (error instanceof JsonRpcError) {
    const data = error.data === undefined ? '' : ' ' + JSON.stringify(error.data).slice(0, 300)
    if (error.code === ErrorCodes.authRequired) return `agent requires authentication: ${error.message}${data}`
    return error.message + data
  }
  if (error instanceof Error) return error.message
  return String(error)
}
