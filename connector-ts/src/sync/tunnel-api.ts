// The client API inside a secure channel (contracts/e2ee/1.0 「通道消息」): the same paths and bodies as normal mode,
// answered by this device instead of the Server. Session reads come from the local store, commands go through the
// same CommandInbox as `aa.device.v1.Commands/*`, device content (files, terminals) through the workspace handlers.

import { randomBytes } from 'node:crypto'

import type { CommandInbox } from '../application/inbound/commands.js'
import type { ChannelCaller, TunnelApi, TunnelApiRequest, TunnelApiResponse, TunnelSubscription } from '../application/inbound/tunnel-api.js'
import type { Clock, ConversationStore } from '../application/ports/index.js'
import { eventCursor, type Session } from '../domain/conversation/index.js'
import { goalWire } from '../domain/goals/index.js'
import { planningWire } from '../domain/planning/index.js'
import { protocolEvent } from './client-shape.js'
import type { DeviceReaders } from './readers.js'
import { watchSession, type WatchDeps } from './watch.js'

/** A workspace handler by v2 method name (`fs.readDir`, `terminal.create`, ...). */
export type WorkspaceCall = (params: Record<string, unknown>) => Promise<unknown>

/** Terminal output routed to one subscriber (the workspace `Terminals.attach/release`). */
export type TerminalSink = (method: 'terminal.output' | 'terminal.exited', params: Record<string, unknown>) => void

export interface TunnelTerminals {
  attach(params: Record<string, unknown>, sink: TerminalSink): Promise<Record<string, unknown>>
  release(params: Record<string, unknown>, sink: TerminalSink): Promise<unknown>
}

/** Live session facts (`runtime.status` with a sessionId) for channel subscribers; in E2EE they never go on attach. */
export interface SessionFacts {
  subscribe(sessionId: string, listener: (method: string, payload: Record<string, unknown>) => void): () => void
}

export interface DeviceTunnelApiDeps {
  readonly deviceId: string
  readonly store: ConversationStore
  readonly readers: DeviceReaders
  readonly watch: WatchDeps
  readonly inbox: CommandInbox
  readonly clock: Clock
  readonly workspace?: Readonly<Record<string, WorkspaceCall>>
  readonly terminals?: TunnelTerminals
  readonly facts?: SessionFacts
  /** Ids the device allocates (a session created through the channel). */
  readonly newId?: (prefix: string) => string
}

/** A client API error: FastAPI's `{detail: {code, message}}`, which the clients already parse. */
export class TunnelHttpError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string, public readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'TunnelHttpError'
  }
}

const notFound = (what: string): TunnelHttpError => new TunnelHttpError(404, 'not_found', what)
const invalid = (message: string): TunnelHttpError => new TunnelHttpError(422, 'invalid_argument', message)

/** AA error codes the Server maps to HTTP statuses for the same routes. */
function statusOf(code: string): number {
  switch (code) {
    case 'session_not_found':
    case 'not_found':
    case 'terminal_not_found':
    case 'file_not_found':
    case 'plan_document_not_found':
    case 'queue_item_not_found':
      return 404
    case 'invalid_argument':
    case 'invalid_path':
      return 422
    case 'path_not_allowed':
    case 'permission_denied':
      return 403
    case 'precondition_failed':
    case 'if_match_failed':
      return 412
    case 'runtime_unavailable':
      return 503
    default:
      return 409
  }
}

function errorBody(error: unknown): TunnelApiResponse {
  if (error instanceof TunnelHttpError) return { status: error.status, body: { detail: { code: error.code, message: error.message, ...error.extra } } }
  const code = (error as { code?: unknown })?.code
  const message = (error as Error)?.message ?? String(error)
  if (typeof code === 'string' && code !== 'internal') return { status: statusOf(code), body: { detail: { code, message } } }
  return { status: 500, body: { detail: { code: 'internal', message } } }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function int(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw invalid(`expected an integer in [${min}, ${max}]`)
  return parsed
}

/** `seq:N` (v2 cursor); anything else starts from the beginning. */
function cursorSeq(cursor: string | null): number {
  const match = /^seq:(\d+)$/u.exec(cursor ?? '')
  return match === null ? 0 : Number(match[1])
}

interface Route {
  readonly method: string
  readonly segments: readonly string[]
  readonly query: URLSearchParams
  readonly body: Record<string, unknown>
}

/** `/api/v2/sessions/x/snapshot?limit=5` → segments `['sessions', 'x', 'snapshot']` (the namespace is optional). */
function parse(request: TunnelApiRequest): Route {
  const url = new URL(request.path, 'http://device.invalid')
  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
  if (segments[0] === 'api' && /^v\d+$/u.test(segments[1] ?? '')) segments.splice(0, 2)
  return { method: request.method, segments, query: url.searchParams, body: record(request.body) }
}

/**
 * The SealedAttachmentKeys of a request (contracts/e2ee/1.0): the device trusts the key's name, type, size and
 * sha256 over whatever `attachments` says, and refuses an attachment of a sealed request that has no key.
 */
function attachmentsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const refs = Array.isArray(body.attachments) ? body.attachments.map(record) : []
  const keys = new Map<string, Record<string, unknown>>()
  for (const key of Array.isArray(body.sealedAttachmentKeys) ? body.sealedAttachmentKeys.map(record) : []) {
    const fileId = text(key.fileId)
    if (fileId !== null) keys.set(fileId, key)
  }
  return refs.map(ref => {
    const fileId = text(ref.fileId) ?? text(ref.id)
    if (fileId === null) throw invalid('every attachment needs a fileId')
    const key = keys.get(fileId)
    if (key === undefined) {
      if (keys.size > 0) throw invalid(`attachment ${fileId} has no sealed key`)
      return { fileId, name: text(ref.name) ?? fileId, mediaType: text(ref.mediaType) ?? text(ref.mimeType) ?? 'application/octet-stream', size: typeof ref.size === 'number' ? ref.size : 0, ...(text(ref.sha256) !== null ? { sha256: ref.sha256 } : {}) }
    }
    const sealedKey = text(key.key)
    const sha256 = text(key.sha256)
    if (sealedKey === null || !/^[A-Za-z0-9_-]{43}$/u.test(sealedKey)) throw invalid(`attachment ${fileId}: malformed key`)
    if (sha256 === null || !/^[0-9a-f]{64}$/u.test(sha256)) throw invalid(`attachment ${fileId}: malformed sha256`)
    if (typeof key.size !== 'number' || !Number.isSafeInteger(key.size) || key.size < 0) throw invalid(`attachment ${fileId}: malformed size`)
    return {
      fileId,
      name: text(key.name) ?? text(ref.name) ?? fileId,
      mediaType: text(key.mimeType) ?? 'application/octet-stream',
      size: key.size,
      sha256,
      sealedKey,
    }
  })
}

/**
 * The session view a client reads in `snapshot.session` and `create-and-start`: what this device knows. Directory
 * fields only the Server keeps (pinned, unread, project) take their defaults; the client merges its list entry.
 */
function sessionView(deviceId: string, session: Session, title: string | null = null): Record<string, unknown> {
  return {
    id: session.sessionId,
    connectorId: deviceId,
    connectorStatus: 'online',
    runtime: session.runtimeType,
    runtimeId: session.runtimeId,
    runtimeType: session.runtimeType,
    externalSessionId: session.externalSessionId,
    title: title ?? session.nativeTitle,
    cwd: session.cwd,
    status: session.status,
    takeover: session.takeover,
    archived: session.archived,
    sourceAvailability: session.sourceAvailability,
    latestTurnEndSeq: session.latestTurnEndSeq ?? 0,
    lastActivityAt: session.lastActivityAt,
    sortAt: session.lastActivityAt,
    updatedSeq: session.clock.headSeq,
    planState: session.planState,
    goalState: session.goalState,
    displayDevice: null,
    displayUser: null,
  }
}

export class DeviceTunnelApi implements TunnelApi {
  private readonly newId: (prefix: string) => string

  public constructor(private readonly deps: DeviceTunnelApiDeps) {
    this.newId = deps.newId ?? (prefix => `${prefix}${randomBytes(12).toString('base64url')}`)
  }

  public async request(caller: ChannelCaller, request: TunnelApiRequest): Promise<TunnelApiResponse> {
    try {
      const route = parse(request)
      const [area, id] = route.segments
      if (area === 'sessions' && id === 'create-and-start' && route.segments.length === 2 && route.method === 'POST') return await this.createAndStart(caller, route.body)
      if (area === 'sessions' && id !== undefined && route.segments.length >= 3) return await this.session(caller, id, route)
      if (area === 'connectors' && id !== undefined) {
        if (id !== this.deps.deviceId) throw notFound(`connector ${id} is not this device`)
        return await this.device(route)
      }
      throw notFound(`${request.method} ${route.segments.join('/')} is not served through the channel`)
    } catch (error) {
      return errorBody(error)
    }
  }

  public async subscribe(_caller: ChannelCaller, subscription: TunnelSubscription, emit: (event: Record<string, unknown>) => void): Promise<() => void> {
    if (subscription.stream === 'terminal') return this.subscribeTerminal(subscription.terminalId ?? '', subscription.fromSeq ?? 0, emit)
    return this.subscribeSession(subscription.sessionId, subscription.afterCursor, emit)
  }

  // ------------------------------------------------------------------------------------------- sessions

  private async requireSession(sessionId: string): Promise<Session> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null) throw new TunnelHttpError(404, 'session_not_found', 'session not found')
    return session
  }

  private now(): string {
    return this.deps.clock.nowIso()
  }

  /** Runs a command like `aa.device.v1.Commands/*` and answers like the Server's REST route (`{ok, result}`). */
  private async command(caller: ChannelCaller, route: string, payload: Record<string, unknown>, commandId: string | null): Promise<Record<string, unknown>> {
    const ack = await this.deps.inbox.handle(route, { commandId: commandId ?? this.newId('cmd_'), m: route, p: payload } as never, `client:${caller.clientId}`)
    if (ack.outcome === 'rejected') {
      const code = ack.e?.code ?? 'command_rejected'
      throw new TunnelHttpError(statusOf(code), code, ack.e?.message ?? code)
    }
    return record(ack.r)
  }

  private async session(caller: ChannelCaller, sessionId: string, route: Route): Promise<TunnelApiResponse> {
    const rest = route.segments.slice(2)
    const path = `${route.method} ${rest.join('/')}`
    const body = route.body
    const ok = (result: unknown): TunnelApiResponse => ({ status: 200, body: { ok: true, result } })
    const reads = this.deps.readers
    switch (path) {
      case 'GET snapshot': {
        const session = await this.requireSession(sessionId)
        const device = await reads.snapshot({ sessionId, limit: int(route.query.get('limit'), 100, 1, 500) })
        return {
          status: 200,
          body: { ...device, session: sessionView(this.deps.deviceId, session), effectiveCapabilities: device.runtimeCapabilities ?? { revision: 0, capabilities: [] }, runtimeCapabilities: device.runtimeCapabilities ?? { revision: 0, capabilities: [] }, serverTime: this.now() },
        }
      }
      case 'GET meta':
        return { status: 200, body: sessionView(this.deps.deviceId, await this.requireSession(sessionId)) }
      case 'GET timeline': {
        const mode = route.query.get('mode') ?? 'latest'
        const limit = int(route.query.get('limit'), 100, 1, 500)
        const read = mode === 'history'
          ? { mode: 'before' as const, cursor: int(route.query.get('beforeOrderSeq'), 0, 1, Number.MAX_SAFE_INTEGER) }
          : mode === 'changes'
            ? { mode: 'after' as const, cursor: int(route.query.get('afterSeq'), 0, 0, Number.MAX_SAFE_INTEGER) }
            : mode === 'latest' ? { mode: 'latest' as const, cursor: null } : null
        if (read === null) throw invalid('mode must be latest, changes or history')
        const page = await reads.read({ sessionId, mode: read.mode, cursor: read.cursor, limit })
        return { status: 200, body: { sessionId, items: page.items, nextSeq: page.headSeq, hasMore: page.hasMore, serverTime: this.now() } }
      }
      case 'GET events': {
        let cursor = cursorSeq(route.query.get('after'))
        const events: unknown[] = []
        for (let page = 0; page < 8; page++) {
          const changes = await reads.changesSince({ sessionId, afterSeq: cursor })
          if (changes.snapshotRequired) return { status: 200, body: { events: [], nextCursor: eventCursor(changes.toSeq), snapshotRequired: true, serverTime: this.now() } }
          events.push(...(changes.events ?? []))
          cursor = Math.max(cursor, changes.toSeq)
          if (changes.complete) return { status: 200, body: { events, nextCursor: eventCursor(cursor), serverTime: this.now() } }
        }
        return { status: 200, body: { events: [], nextCursor: eventCursor(cursorSeq(route.query.get('after'))), snapshotRequired: true, serverTime: this.now() } }
      }
      case 'GET runtime/state':
        return { status: 200, body: { ...(await reads.sessionState({ sessionId })), serverTime: this.now() } }
      case 'GET runtime/capabilities':
        return { status: 200, body: { ...(await reads.capabilities({ sessionId })), serverTime: this.now() } }
      case 'GET runtime/notices':
        return { status: 200, body: { ...(await reads.notices({ sessionId })), serverTime: this.now() } }
      case 'GET runtime/queue':
        return { status: 200, body: (await reads.queue({ sessionId })).queue }
      case 'GET planning': {
        await this.requireSession(sessionId)
        const state = await this.deps.store.planning.load(sessionId)
        return { status: 200, body: state === null ? null : planningWire(state) }
      }
      case 'GET goal': {
        const session = await this.requireSession(sessionId)
        const goal = await this.deps.store.goals.load(sessionId)
        return { status: 200, body: goal === null ? null : goalWire(goal, session.takeover) }
      }
      case 'POST runtime/messages': {
        const clientMessageId = text(body.clientMessageId) ?? this.newId('cm_')
        return ok(await this.command(caller, 'sessionSendMessage', {
          sessionId,
          clientMessageId,
          content: typeof body.content === 'string' ? body.content : '',
          attachments: attachmentsOf(body),
          ...(text(body.queue) !== null ? { queue: body.queue } : {}),
        }, clientMessageId))
      }
      case 'POST runtime/steer': {
        const clientMessageId = text(body.clientMessageId) ?? this.newId('cm_')
        return ok(await this.command(caller, 'sessionSteer', { sessionId, clientMessageId, content: typeof body.content === 'string' ? body.content : '', attachments: attachmentsOf(body) }, clientMessageId))
      }
      case 'POST runtime/interrupt':
        return ok(await this.command(caller, 'sessionInterrupt', { sessionId }, text(body.commandId)))
      case 'POST sync':
        return ok(await this.command(caller, 'sessionSync', { sessionId, ...(typeof body.takeover === 'boolean' ? { takeover: body.takeover } : {}) }, text(body.commandId)))
      case 'PATCH runtime/selections': {
        const selections = record(body.selections)
        const entries = Object.entries(selections)
        if (entries.length === 0) throw invalid('selections is required')
        let connectorResult: Record<string, unknown> = {}
        for (const [optionId, value] of entries) {
          if (value === null) continue
          connectorResult = await this.command(caller, 'sessionSelect', { sessionId, optionId, value }, null)
        }
        return { status: 200, body: { ok: true, state: (await reads.sessionState({ sessionId })).state, connectorResult, serverTime: this.now() } }
      }
      case 'POST planning':
        return { status: 200, body: await this.command(caller, 'sessionPlanning', { ...body, sessionId }, text(body.operationId)) }
      case 'POST goal':
        return { status: 200, body: await this.command(caller, 'sessionGoal', { ...body, sessionId }, text(body.operationId)) }
      case 'DELETE runtime/queue':
        return { status: 200, body: await this.queue(caller, 'sessionQueueClear', { sessionId }) }
      case 'POST runtime/queue/resume':
        return { status: 200, body: await this.queue(caller, 'sessionQueueResume', { sessionId }) }
      case 'PUT runtime/queue/order':
        return { status: 200, body: await this.queue(caller, 'sessionQueueReorder', { sessionId, messageIds: Array.isArray(body.messageIds) ? body.messageIds : [] }) }
      default:
        break
    }
    // Paths with an id inside.
    if (rest[0] === 'runtime' && rest[1] === 'notices' && rest[3] === 'respond' && rest.length === 4 && route.method === 'POST') {
      return ok(await this.command(caller, 'sessionRespondNotice', {
        sessionId,
        noticeId: rest[2],
        actionId: text(body.actionId) ?? '',
        ...(body.input !== undefined && body.input !== null ? { input: body.input } : {}),
        ...(text(body.responseId) !== null ? { responseId: body.responseId } : {}),
      }, text(body.responseId) ?? text(body.commandId)))
    }
    if (rest[0] === 'runtime' && rest[1] === 'queue' && rest.length >= 3) {
      const messageId = rest[2]
      const action = `${route.method} ${rest.slice(3).join('/')}`
      switch (action) {
        case 'DELETE ':
          return { status: 200, body: await this.queue(caller, 'sessionQueueDelete', { sessionId, messageId }) }
        case 'POST retry':
          return { status: 200, body: await this.queue(caller, 'sessionQueueRetry', { sessionId, messageId }) }
        case 'POST send-now':
          return { status: 200, body: await this.queue(caller, 'sessionQueueSendNow', { sessionId, messageId }) }
        case 'PATCH ':
          return { status: 200, body: await this.queue(caller, 'sessionQueueUpdate', { sessionId, messageId, ...(typeof body.content === 'string' ? { content: body.content } : {}), ...(Array.isArray(body.attachments) ? { attachments: attachmentsOf(body) } : {}) }) }
        default:
          break
      }
    }
    if (rest[0] === 'plans' && rest.length === 3 && route.method === 'GET') {
      const revision = Number(rest[2])
      if (!Number.isInteger(revision)) throw invalid('revision must be an integer')
      return { status: 200, body: (await reads.planDocument({ sessionId, planId: rest[1]!, revision })).document }
    }
    throw notFound(`${route.method} sessions/{id}/${rest.join('/')} is not served through the channel yet`)
  }

  /** Queue commands answer the queue state (`SessionQueueState`), like the Server's queue routes. */
  private async queue(caller: ChannelCaller, route: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.command(caller, route, payload, null)
    return (await this.deps.readers.queue({ sessionId: String(payload.sessionId) })).queue
  }

  /**
   * `POST /sessions/create-and-start` through the channel: the device allocates the session id (no Server row
   * exists yet), creates and starts it with the first message, and reports it through the outbox like any other
   * session. A retry with the same `clientMessageId` returns the first attempt's session.
   */
  private async createAndStart(caller: ChannelCaller, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    if (text(body.connectorId) !== null && body.connectorId !== this.deps.deviceId) throw invalid('connectorId is not this device')
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      throw new TunnelHttpError(409, 'e2ee_attachments_unsupported', 'The first message of an end-to-end encrypted session cannot carry attachments yet.')
    }
    const runtimeType = text(body.runtime) ?? 'codex'
    const cwd = text(body.cwd)
    if (cwd === null) throw invalid('cwd is required')
    const clientMessageId = text(body.clientMessageId) ?? this.newId('create_')
    const previous = await this.deps.store.commands.get(clientMessageId)
    const sessionId = typeof previous?.sessionId === 'string' ? previous.sessionId : `sess_${randomBytes(16).toString('hex')}`
    const result = await this.command(caller, 'sessionCreationBegin', {
      sessionId,
      runtimeId: text(body.runtimeId) ?? runtimeType,
      runtimeType,
      cwd,
      ...(text(body.title) !== null ? { title: body.title } : {}),
      ...(Object.keys(record(body.selections)).length > 0 ? { selections: record(body.selections) } : {}),
      clientMessageId,
      content: typeof body.content === 'string' ? body.content : '',
      takeover: true,
    }, clientMessageId)
    const session = await this.requireSession(sessionId)
    return { status: 200, body: { session: sessionView(this.deps.deviceId, session, text(body.title)), connectorResult: result, attachments: [] } }
  }

  private async subscribeSession(sessionId: string, afterCursor: string | null, emit: (event: Record<string, unknown>) => void): Promise<() => void> {
    await this.requireSession(sessionId)
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const changes of watchSession(this.deps.watch, { sessionId, afterSeq: cursorSeq(afterCursor) }, abort.signal)) {
          for (const event of changes.events ?? []) emit(event as unknown as Record<string, unknown>)
        }
      } catch {
        // The channel closes the subscription; a store failure ends the stream like a closed WebSocket.
      }
    })()
    const stopFacts = this.deps.facts?.subscribe(sessionId, (method, payload) => {
      emit(protocolEvent(sessionId, 0, method, payload, this.now()) as unknown as Record<string, unknown>)
    })
    return () => {
      abort.abort()
      stopFacts?.()
    }
  }

  // --------------------------------------------------------------------------------------------- device

  private scope(): string {
    return `browse_${this.deps.deviceId}`
  }

  private async workspace(method: string, params: Record<string, unknown>): Promise<unknown> {
    const handler = this.deps.workspace?.[method]
    if (handler === undefined) throw new TunnelHttpError(501, 'not_implemented', `${method} is not available on this device`)
    return handler({ sessionId: this.scope(), ...params })
  }

  private async device(route: Route): Promise<TunnelApiResponse> {
    const rest = route.segments.slice(2)
    const body = route.body
    const root = route.query.get('root') ?? text(body.root)
    const needRoot = (): string => {
      if (root === null) throw invalid('root is required')
      return root
    }
    const ok = (result: unknown): TunnelApiResponse => ({ status: 200, body: { ok: true, result } })
    const action = `${route.method} ${rest.join('/')}`
    switch (action) {
      case 'POST fs/list':
        return ok(await this.workspace('fs.readDir', { root: needRoot(), path: typeof body.path === 'string' ? body.path : '.' }))
      case 'POST fs/readText':
        return { status: 200, body: { ...record(await this.workspace('fs.readText', { root: needRoot(), path: text(body.path) ?? '', maxBytes: typeof body.maxBytes === 'number' ? body.maxBytes : 1_048_576 })), serverTime: this.now() } }
      case 'GET fs/read':
        return {
          status: 200,
          body: await this.workspace('fs.readRange', {
            root: needRoot(),
            path: route.query.get('path') ?? '',
            offset: int(route.query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
            length: int(route.query.get('length'), 8 * 1024 * 1024, 1, 8 * 1024 * 1024),
          }),
        }
      case 'POST fs/write':
        return ok(await this.workspace('fs.writeFile', { root: needRoot(), path: text(body.path) ?? '', content: typeof body.content === 'string' ? body.content : '', encoding: body.encoding ?? 'utf8', ...(text(body.ifMatch) !== null ? { ifMatch: body.ifMatch } : {}) }))
      case 'POST terminals-v2':
        return ok(await this.workspace('terminal.create', {
          terminalId: `trm_${randomBytes(18).toString('base64url')}`,
          root: needRoot(),
          cwd: text(body.cwd) ?? '.',
          shell: body.shell ?? null,
          command: body.command ?? null,
          args: Array.isArray(body.args) ? body.args : [],
          profile: body.profile ?? null,
          cols: typeof body.cols === 'number' ? body.cols : 80,
          rows: typeof body.rows === 'number' ? body.rows : 24,
          env: record(body.env),
          label: body.label ?? null,
          persistent: body.persistent === true,
          outputTransport: 'relay',
        }))
      case 'GET terminals-v2':
        return ok(await this.workspace('terminal.list', {}))
      default:
        break
    }
    if (rest[0] === 'terminals-v2' && rest.length >= 2) {
      const terminalId = rest[1]!
      const sub = `${route.method} ${rest.slice(2).join('/')}`
      switch (sub) {
        case 'PATCH ':
          return ok(await this.workspace('terminal.rename', { terminalId, label: text(body.label) ?? '' }))
        case 'PATCH persistence':
          return ok(await this.workspace('terminal.setPersistent', { terminalId, persistent: body.persistent }))
        case 'DELETE ':
          return ok(await this.workspace('terminal.close', { terminalId }))
        case 'POST resize':
          return ok(await this.workspace('terminal.resize', { terminalId, cols: body.cols, rows: body.rows }))
        case 'POST write': {
          if (typeof body.dataBase64 !== 'string') throw invalid('dataBase64 is required')
          return ok(await this.workspace('terminal.write', { terminalId, dataBase64: body.dataBase64 }))
        }
        case 'GET snapshot':
          return ok(await this.workspace('terminal.snapshot', { terminalId, fromSeq: int(route.query.get('fromSeq'), 0, 0, Number.MAX_SAFE_INTEGER) }))
        default:
          break
      }
    }
    throw notFound(`${route.method} connectors/{id}/${rest.join('/')} is not served through the channel yet`)
  }

  /**
   * `TunnelSubscribe {stream: "terminal"}`: the normal-mode `terminals-v2/{id}/stream` messages — a `replay` of the
   * scrollback, then `output` and `exit` as they happen. Input and resize arrive as requests.
   */
  private async subscribeTerminal(terminalId: string, fromSeq: number, emit: (event: Record<string, unknown>) => void): Promise<() => void> {
    const terminals = this.deps.terminals
    if (terminals === undefined || terminalId === '') throw new TunnelHttpError(404, 'terminal_not_found', 'terminal not found')
    const sink: TerminalSink = (method, params) => {
      if (method === 'terminal.output') emit({ type: 'output', data: params.dataBase64, seq: params.seq })
      else emit({ type: 'exit', exitCode: typeof params.exitCode === 'number' ? params.exitCode : null, reason: typeof params.reason === 'string' ? params.reason : 'exit' })
    }
    const params = { terminalId, sessionId: this.scope(), fromSeq }
    const snapshot = await terminals.attach(params, sink)
    if (typeof snapshot.dataBase64 === 'string') emit({ type: 'replay', data: snapshot.dataBase64, seq: typeof snapshot.seq === 'number' ? snapshot.seq : fromSeq })
    const terminal = record(snapshot.terminal)
    if (terminal.status === 'exited') emit({ type: 'exit', exitCode: typeof terminal.exitCode === 'number' ? terminal.exitCode : null, reason: 'exit' })
    return () => void terminals.release(params, sink).catch(() => undefined)
  }
}
