// ACP Client Core：一条 ACP 连接上的客户端一侧。
//
// ported from effi-evo cloud/agentd/src/conv/agent-process.ts @95b52ec（会话路由、early 缓冲、只读回放捕获），
// effi-crew cloud/agentd/src/conv/agent-process.ts @30f8334 是它的早期版本。
// 与 agentd 的差别：
// - 线路层用自己的 JsonRpcPeer（jsonrpc.ts），反向扩展请求按 sessionId 交给会话，不认识的回 method_not_found；
// - 协议版本协商（v1 / v2）和 initialize `_meta` 扩展协商集中在这里，方言只读结果；
// - 不声明 fs / terminal 客户端能力：AA 的文件与终端走独立通道，Codex、Claude、Pi、Hermes 都不依赖它们。

import { ErrorCodes, JsonRpcError, type JsonRpcPeer, type RequestContext, type RequestOptions } from './jsonrpc.js'

export const CLIENT_INFO = { name: 'agents-anywhere', version: '3.0.0' } as const

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonRecord = { [key: string]: Json }

export interface InitializeOptions {
  /** 客户端支持的最高协议版本；Agent 回它支持的版本（≤）。 */
  readonly protocolVersion: 1 | 2
  readonly clientCapabilities: JsonRecord
  /** initialize 顶层 `_meta`（扩展协商，例如 `codexIpc`）。 */
  readonly meta?: JsonRecord
  readonly timeoutMs?: number
}

export interface AgentInfo {
  readonly protocolVersion: number
  readonly agentCapabilities: JsonRecord
  readonly agentInfo: { readonly name?: string; readonly version?: string; readonly title?: string }
  readonly authMethods: readonly JsonRecord[]
  /** initialize 响应顶层 `_meta`。 */
  readonly meta: JsonRecord
}

/** 会话一侧的接收者。一个会话 ID 只有一个 sink（主会话或子 Agent 会话都按 ID 注册）。 */
export interface SessionSink {
  onUpdate(update: JsonRecord, notification: JsonRecord): void
  /** 会话范围内的反向请求：权限、表单、`_codex/session/history_reset` 等。 */
  onRequest(method: string, params: JsonRecord, context: RequestContext): Promise<unknown>
}

/** Agent 在 session/new 返回前就推的更新（例如可用命令），先存着等会话认领。 */
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
  /** 任何流量的最后时间（ms），供空闲回收。 */
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

  /** 没有会话认领的反向请求（例如 `_session/list/changes` 之外的全局请求）。 */
  onGlobalRequest(handler: (method: string, params: JsonRecord, context: RequestContext) => Promise<unknown>): void {
    this.globalRequest = handler
  }

  /** 非 session/update 的通知（例如 `_session/list/changes`、`_auth/status_update`）。 */
  onNotification(method: string, listener: (params: JsonRecord) => void): () => void {
    const list = this.notificationListeners.get(method) ?? []
    list.push(listener)
    this.notificationListeners.set(method, list)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /** 认领一个会话 ID；之前缓冲的更新立即交付。返回解除函数。 */
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
   * 在 fn 执行期间把该会话的更新收集起来（只读回放：session/load 的历史在响应之前到达）。
   * 收集期间不交给 sink。
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

/** ACP 错误的可读描述。 */
export function describeAcpError(error: unknown): string {
  if (error instanceof JsonRpcError) {
    const data = error.data === undefined ? '' : ' ' + JSON.stringify(error.data).slice(0, 300)
    if (error.code === ErrorCodes.authRequired) return `agent requires authentication: ${error.message}${data}`
    return error.message + data
  }
  if (error instanceof Error) return error.message
  return String(error)
}
