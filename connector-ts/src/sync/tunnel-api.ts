// The client API a device answers: the same paths and bodies as the Server's `/api/v2`, inside a secure channel
// (contracts/e2ee/1.0, channel messages section) and for calls the Server forwards. Session reads come from the local
// store, commands go through the same CommandInbox as `aa.device.v1.Commands/*`, device content (files, terminals,
// shell) through the workspace handlers. Every answer has the shape the Server's response models gave.
// ported from Agents-Anywhere v2 server/agent_server/api/sessions.py @4c8012369 (session_runtime_state, session_runtime_capabilities, session_runtime_model_catalog, session_runtime_permission_catalog, patch_session_selections, list_session_runtime_commands, execute_session_command, send_message, interrupt_session, steer_session, list_session_runtime_notices, respond_interaction, sync_session)
// ported from Agents-Anywhere v2 server/agent_server/services/session_run.py @4c8012369 (send_message, steer_session, update_session_selections, _interrupt_session, _attachment_payloads)
// ported from Agents-Anywhere v2 server/agent_server/infra/device_link.py @4c8012369 (DeviceRpcBridge._session_command_execute, _device_payload)
// ported from Agents-Anywhere v2 server/agent_server/api/session_planning.py @4c8012369 (execute_planning, list_plans, read_plan, download_plan)
// ported from Agents-Anywhere v2 server/agent_server/api/session_goals.py @4c8012369 (execute_goal)
// ported from Agents-Anywhere v2 server/agent_server/api/device_session_reads.py @4c8012369 (device_timeline, device_events)

import { randomBytes } from 'node:crypto'

import { CREATE_AND_START_METHOD, type CommandInbox } from '../application/inbound/commands.js'
import type { NativeAppCommandsApi } from '../application/ports/index.js'
import type { ChannelCaller, TunnelApi, TunnelApiRequest, TunnelApiResponse, TunnelCallContext, TunnelSubscription } from '../application/inbound/tunnel-api.js'
import type { Clock, ConversationStore } from '../application/ports/index.js'
import { eventCursor, type Session } from '../domain/conversation/index.js'
import type { AttachmentRef } from '../generated/device-meshcall/v1_0/client-call-request.js'
import type { CommandAck } from '../generated/device-meshcall/v1_0/command-ack.js'
import type { CommandCall } from '../generated/device-meshcall/v1_0/command-call.js'
import { appCommandViews, commandText, commandViews, slashResult, type SessionCommand } from './client-api/commands.js'
import { TunnelHttpError, conflict, errorBody, int, invalid, notFound, okBody, parse, record, statusOf, text, type Route } from './client-api/http.js'
import { NOTICE_GONE_CODES, capabilityUsable, findCapability, noticeAnswerInput, parsePlanCommand, sessionSourceError, unsupportedMediaType } from './client-api/rules.js'
import { capabilitySetView, goalView, modelCatalogView, noticeView, permissionCatalogView, planningView, runtimeStateView } from './client-api/views.js'
import { WorkspaceRoutes, type PreviewFacts, type RuntimeCatalogs, type TransferFacts, type WorkspaceCall } from './client-api/workspace-routes.js'
import { protocolEvent } from './client-shape.js'
import type { DeviceReaders } from './readers.js'
import { watchSession, type WatchDeps } from './watch.js'

export { TunnelHttpError } from './client-api/http.js'
export type { PreviewFacts, RuntimeCatalogs, TransferFacts, WorkspaceCall } from './client-api/workspace-routes.js'

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

/** An uploaded attachment as the Server recorded it (`AttachmentRef` of `Client/call`). */
export type AttachmentFacts = AttachmentRef

/**
 * A call as the routes read it: the command identity the caller registered, and what only the Server knows, taken
 * over the request body's own claims — the session id it allocated, the takeover switch and archive state, the uploads it holds, the
 * transfer of a download, the file of a preview token. A call through a secure channel has none of them.
 */
interface Call {
  readonly command: { readonly commandId: string; readonly inputDigest: string | null; readonly deadline: string | null } | null
  readonly sessionId: string | null
  readonly takeover: boolean | null
  readonly archived: boolean | null
  readonly attachments: readonly AttachmentFacts[] | null
  readonly transfer: TransferFacts | null
  readonly preview: PreviewFacts | null
  readonly onCommand: TunnelCallContext['onCommand'] | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The `Client/call` context as a `Call`; the Server's facts are read defensively (the contract allows more keys). */
export function callOf(context: TunnelCallContext | undefined): Call {
  const server = record(context?.server)
  const transfer = record(server.transfer)
  const preview = record(server.preview)
  const transferId = nonEmpty(transfer.transferId)
  const token = nonEmpty(transfer.token)
  const uploadPath = nonEmpty(transfer.path)
  const previewRoot = nonEmpty(preview.root)
  const previewPath = nonEmpty(preview.path)
  return {
    command: context?.command === undefined ? null : { commandId: context.command.commandId, inputDigest: nonEmpty(context.command.inputDigest), deadline: nonEmpty(context.command.deadline) },
    sessionId: nonEmpty(server.sessionId),
    takeover: typeof server.takeover === 'boolean' ? server.takeover : null,
    archived: typeof server.archived === 'boolean' ? server.archived : null,
    attachments: Array.isArray(server.attachments) ? server.attachments.map(record).filter(item => nonEmpty(item.fileId) !== null) as unknown as AttachmentFacts[] : null,
    transfer: transferId !== null && token !== null && uploadPath !== null ? { transferId, token, path: uploadPath, ...(nonEmpty(transfer.downloadUrl) !== null ? { downloadUrl: transfer.downloadUrl as string } : {}) } : null,
    preview: previewRoot !== null && previewPath !== null ? { root: previewRoot, path: previewPath } : null,
    onCommand: context?.onCommand ?? null,
  }
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
  /** The slash commands a session's Runtime reported last (`SessionCommandCatalog.get`). */
  readonly commands?: (sessionId: string) => readonly SessionCommand[]
  /** The session's native desktop app, offered as slash commands next to the Runtime's own. */
  readonly nativeApps?: NativeAppCommandsApi
  /** Runtime instances' own catalogs (`connectors/{id}/runtimes/{r}/catalogs/*`). */
  readonly runtimes?: RuntimeCatalogs
  /** `fs.uploadPreparedDownload` of the device link: the bytes of `POST fs/read` go to the Server's relay. */
  readonly transferUpload?: (params: Record<string, unknown>) => Promise<unknown>
  /** The platform the workspace runs on; default this process's. */
  readonly platform?: NodeJS.Platform
}

const READ_ONLY = 'session is read-only until takeover is enabled'
const SELECTION_CAPABILITIES: Readonly<Record<string, string>> = { model: 'catalog.model', permission: 'catalog.permission' }
const PLAN_REVIEW_COMMANDS: ReadonlySet<string> = new Set(['approve_and_execute', 'request_revision', 'dismiss_review'])
const QUEUE_MODES: ReadonlySet<string> = new Set(['auto', 'interrupt', 'never'])
const SLASH_COMMAND = /^[A-Za-z][A-Za-z0-9_-]*$/u
const COMMAND_UNAVAILABLE = '命令目录已变化，请刷新。'
const COMMAND_MISMATCH = '命令与原始输入不一致。'

/** `seq:N` (the cursor format clients send); anything else starts from the beginning. */
function cursorSeq(cursor: string | null): number {
  const match = /^seq:(\d+)$/u.exec(cursor ?? '')
  return match === null ? 0 : Number(match[1])
}

function inputObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * The SealedAttachmentKeys of a request (contracts/e2ee/1.0): the device trusts the key's name, type, size and
 * sha256 over whatever `attachments` says, and refuses an attachment of a sealed request that has no key.
 */
function sealedAttachments(body: Record<string, unknown>): Record<string, unknown>[] {
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
    return { fileId, name: text(key.name) ?? text(ref.name) ?? fileId, mediaType: text(key.mimeType) ?? 'application/octet-stream', size: key.size, sha256, sealedKey }
  })
}

/**
 * The attachments of a message: the Server's records of the uploads when it forwarded the call (in the order the
 * body names them; one it does not hold is a 404), else what the request itself carries.
 */
export function attachmentsOf(body: Record<string, unknown>, facts: readonly AttachmentFacts[] | null): Record<string, unknown>[] {
  const refs = Array.isArray(body.attachments) ? body.attachments.map(record) : []
  if (refs.length > 10) throw invalid('at most 10 attachments')
  if (facts === null) return sealedAttachments(body)
  const byId = new Map(facts.map(fact => [fact.fileId, fact]))
  const wanted = refs.length > 0 ? refs.map(ref => text(ref.fileId) ?? text(ref.id) ?? '') : facts.map(fact => fact.fileId)
  return wanted.map(fileId => {
    const fact = byId.get(fileId)
    if (fact === undefined) throw new TunnelHttpError(404, 'attachment_not_found', `attachment not found: ${fileId}`)
    const out: Record<string, unknown> = { fileId: fact.fileId, name: fact.name, mediaType: fact.mediaType }
    if (typeof fact.size === 'number') out.size = fact.size
    if (typeof fact.sha256 === 'string') out.sha256 = fact.sha256
    return out
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
    projectId: session.projectId ?? null,
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

/** The command a rejected ack carries, as an error a route can map. */
class CommandRejected extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'CommandRejected'
  }
}

export class DeviceTunnelApi implements TunnelApi {
  private readonly newId: (prefix: string) => string
  private readonly files: WorkspaceRoutes

  public constructor(private readonly deps: DeviceTunnelApiDeps) {
    this.newId = deps.newId ?? (prefix => `${prefix}${randomBytes(12).toString('base64url')}`)
    this.files = new WorkspaceRoutes({
      deviceId: deps.deviceId,
      now: () => deps.clock.nowIso(),
      ...(deps.workspace !== undefined ? { workspace: deps.workspace } : {}),
      ...(deps.transferUpload !== undefined ? { transferUpload: deps.transferUpload } : {}),
      ...(deps.runtimes !== undefined ? { runtimes: deps.runtimes } : {}),
      platform: deps.platform ?? process.platform,
      newTerminalId: () => `trm_${randomBytes(18).toString('base64url')}`,
      newShellTaskId: () => `sht_${randomBytes(12).toString('base64url')}`,
    })
  }

  public async request(caller: ChannelCaller, request: TunnelApiRequest, context?: TunnelCallContext): Promise<TunnelApiResponse> {
    try {
      const call = callOf(context)
      const route = parse(request)
      const [area, id] = route.segments
      if (area === 'sessions' && id === 'create-and-start' && route.segments.length === 2 && route.method === 'POST') return await this.createAndStart(caller, call, route.body)
      if (area === 'sessions' && id !== undefined && route.segments.length >= 3) return await this.session(caller, call, id, route)
      if (area === 'connectors' && id !== undefined) {
        if (id !== this.deps.deviceId) throw notFound(`connector ${id} is not this device`)
        return await this.files.device(route, call.transfer, call.preview)
      }
      throw notFound(`${request.method} ${route.segments.join('/')} is not served by this device`)
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

  /**
   * Runs a command like `aa.device.v1.Commands/*` and returns the ack's result. The identity the caller registered
   * wins over the body's; the inbox gets no cancellation, so a caller that stops waiting never stops the command.
   */
  private async command(caller: ChannelCaller, call: Call, route: string, payload: Record<string, unknown>, commandId: string | null): Promise<Record<string, unknown>> {
    return this.settle(caller, call, route, payload, commandId, (command, actor) => this.deps.inbox.handle(route, command, actor))
  }

  /** Runs `submit` under the call's command identity and reports its ack; a rejection throws `CommandRejected`. */
  private async settle(caller: ChannelCaller, call: Call, method: string, payload: Record<string, unknown>, commandId: string | null,
    submit: (command: CommandCall, actor: string) => Promise<CommandAck>): Promise<Record<string, unknown>> {
    const identity = call.command
    const id = identity?.commandId ?? commandId ?? this.newId('c_')
    const ack = await submit({
      commandId: id,
      m: method,
      p: payload,
      ...(identity?.inputDigest != null ? { inputDigest: identity.inputDigest } : {}),
      ...(identity?.deadline != null ? { deadline: identity.deadline } : {}),
    } as never, `client:${caller.clientId}`)
    call.onCommand?.(id, ack)
    if (ack.outcome === 'rejected') {
      const code = ack.e?.code ?? 'command_rejected'
      throw new CommandRejected(code, ack.e?.message ?? code)
    }
    return record(ack.r)
  }

  /** `command`, with a rejection as an HTTP error of `status` (the default status of its code when null). */
  private async commandAs(status: number | null, caller: ChannelCaller, call: Call, route: string, payload: Record<string, unknown>, commandId: string | null): Promise<Record<string, unknown>> {
    try {
      return await this.command(caller, call, route, payload, commandId)
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error
      throw new TunnelHttpError(status ?? statusOf(error.code), error.code, error.message)
    }
  }

  private takeover(session: Session, call: Call): boolean {
    return call.takeover ?? session.takeover
  }

  /** Archived in the Server's directory or on the device (its use cases refuse an archived session either way). */
  private archived(session: Session, call: Call): boolean {
    return call.archived === true || session.archived
  }

  private requireTakeover(session: Session, call: Call): void {
    if (!this.takeover(session, call)) throw conflict('session_read_only', READ_ONLY)
  }

  /** The session's capability set as the Runtime reports it now (null when it is not open on this device). */
  private async capabilities(sessionId: string): Promise<Record<string, unknown> | null> {
    const read = await this.deps.readers.capabilities({ sessionId })
    return inputObject(read.capabilitySet)
  }

  /** A 409 unless the session capability is usable now; returns it. */
  private async requireCapability(session: Session, call: Call, capabilityId: string): Promise<Record<string, unknown>> {
    const capability = findCapability(await this.capabilities(session.sessionId), capabilityId)
    if (!capabilityUsable(capability, this.takeover(session, call))) throw conflict('capability_unavailable', `session capability is unavailable: ${capabilityId}`)
    return capability as Record<string, unknown>
  }

  private async requireAttachmentTypes(session: Session, call: Call, attachments: readonly Record<string, unknown>[]): Promise<void> {
    if (attachments.length === 0) return
    const capability = await this.requireCapability(session, call, 'runtime.attachment')
    const refused = unsupportedMediaType(capability, attachments.map(item => String(item.mediaType ?? '')))
    if (refused !== null) throw conflict('attachment_type_unsupported', `attachment type is not supported by this runtime: ${refused}`)
  }

  private async session(caller: ChannelCaller, call: Call, sessionId: string, route: Route): Promise<TunnelApiResponse> {
    const rest = route.segments.slice(2)
    const path = `${route.method} ${rest.join('/')}`
    const body = route.body
    const reads = this.deps.readers
    switch (path) {
      case 'GET snapshot': {
        const session = await this.requireSession(sessionId)
        const device = await reads.snapshot({ sessionId, limit: int(route.query.get('limit'), 100, 1, 500) })
        const capabilities = inputObject(device.runtimeCapabilities)
        return {
          status: 200,
          body: { ...device, session: sessionView(this.deps.deviceId, session), effectiveCapabilities: capabilitySetView(capabilities, session), runtimeCapabilities: capabilities ?? { revision: 0, capabilities: [] }, serverTime: this.now() },
        }
      }
      case 'GET meta':
        return { status: 200, body: sessionView(this.deps.deviceId, await this.requireSession(sessionId)) }
      case 'GET timeline':
        return this.timeline(sessionId, route)
      case 'GET events':
        return this.events(sessionId, route)
      case 'GET runtime/state': {
        const session = await this.requireSession(sessionId)
        const state = inputObject((await reads.sessionState({ sessionId })).state)
        return { status: 200, body: { state: runtimeStateView(state, session, this.now()), serverTime: this.now() } }
      }
      case 'GET runtime/capabilities': {
        const session = await this.requireSession(sessionId)
        return { status: 200, body: { connectorId: this.deps.deviceId, capabilitySet: capabilitySetView(await this.capabilities(sessionId), session), serverTime: this.now() } }
      }
      case 'GET runtime/notices': {
        const notices = (await reads.notices({ sessionId })).notices
        return { status: 200, body: { notices: (Array.isArray(notices) ? notices : []).map(item => noticeView(record(item))), serverTime: this.now() } }
      }
      case 'GET runtime/queue':
        return { status: 200, body: { ...record((await reads.queue({ sessionId })).queue), deviceOffline: false } }
      case 'GET runtime/catalogs/model':
      case 'GET runtime/catalogs/permission': {
        const session = await this.requireSession(sessionId)
        const catalogs = record((await reads.catalogs({ sessionId })).catalogs)
        const catalog = path.endsWith('model') ? modelCatalogView(catalogs.models, session.runtimeType) : permissionCatalogView(catalogs.permissions, session.runtimeType)
        return { status: 200, body: { catalog, serverTime: this.now() } }
      }
      case 'GET runtime/commands':
        return this.listCommands(sessionId, call, route)
      case 'POST runtime/commands':
        return this.executeCommand(caller, call, sessionId, body)
      case 'GET planning':
        await this.requireSession(sessionId)
        return { status: 200, body: planningView((await reads.sessionState({ sessionId, part: 'planning' })).planning) }
      case 'GET goal':
        await this.requireSession(sessionId)
        return { status: 200, body: goalView((await reads.sessionState({ sessionId, part: 'goal' })).goal) }
      case 'GET plans':
        return { status: 200, body: (await reads.planDocument({ sessionId })).plans ?? [] }
      case 'POST runtime/messages':
        return this.sendMessage(caller, call, sessionId, body)
      case 'POST runtime/steer':
        return this.steer(caller, call, sessionId, body)
      case 'POST runtime/interrupt': {
        const session = await this.requireSession(sessionId)
        this.requireTakeover(session, call)
        await this.requireCapability(session, call, 'session.interrupt')
        return okBody(await this.commandAs(502, caller, call, 'sessionInterrupt', { sessionId }, text(body.commandId)))
      }
      case 'POST sync': {
        const session = await this.requireSession(sessionId)
        if (session.externalSessionId === null || session.externalSessionId === '') throw conflict('session_not_bound', 'session has no external runtime id')
        const takeover = call.takeover ?? (typeof body.takeover === 'boolean' ? body.takeover : undefined)
        return okBody(await this.commandAs(502, caller, call, 'sessionSync', { sessionId, ...(takeover !== undefined ? { takeover } : {}) }, text(body.commandId)))
      }
      case 'PATCH runtime/selections':
        return this.select(caller, call, sessionId, body)
      case 'POST planning':
        return this.planning(caller, call, sessionId, body)
      case 'POST goal':
        return this.goal(caller, call, sessionId, body)
      case 'DELETE runtime/queue':
        return { status: 200, body: await this.queue(caller, call, 'sessionQueueClear', { sessionId }) }
      case 'POST runtime/queue/resume':
        return { status: 200, body: await this.queue(caller, call, 'sessionQueueResume', { sessionId }) }
      case 'PUT runtime/queue/order':
        return { status: 200, body: await this.queue(caller, call, 'sessionQueueReorder', { sessionId, messageIds: Array.isArray(body.messageIds) ? body.messageIds : [] }) }
      default:
        break
    }
    // Paths with an id inside.
    if (rest[0] === 'runtime' && rest[1] === 'notices' && rest[3] === 'respond' && rest.length === 4 && route.method === 'POST') return this.respond(caller, call, sessionId, rest[2]!, body)
    if (rest[0] === 'runtime' && rest[1] === 'queue' && rest.length >= 3) {
      const messageId = rest[2]
      switch (`${route.method} ${rest.slice(3).join('/')}`) {
        case 'DELETE ':
          return { status: 200, body: await this.queue(caller, call, 'sessionQueueDelete', { sessionId, messageId }) }
        case 'POST retry':
          return { status: 200, body: await this.queue(caller, call, 'sessionQueueRetry', { sessionId, messageId }) }
        case 'POST send-now':
          return { status: 200, body: await this.queue(caller, call, 'sessionQueueSendNow', { sessionId, messageId }) }
        case 'PATCH ':
          return { status: 200, body: await this.queue(caller, call, 'sessionQueueUpdate', { sessionId, messageId, ...(typeof body.content === 'string' ? { content: body.content } : {}), ...(Array.isArray(body.attachments) ? { attachments: attachmentsOf(body, call.attachments) } : {}) }) }
        default:
          break
      }
    }
    if (rest[0] === 'plans' && (rest.length === 3 || (rest.length === 4 && rest[3] === 'markdown')) && route.method === 'GET') {
      const revision = Number(rest[2])
      if (!Number.isInteger(revision)) throw invalid('revision must be an integer')
      const read = await reads.planDocument({ sessionId, planId: rest[1]!, revision }).catch((error: unknown) => {
        if ((error as { code?: unknown }).code === 'plan_document_not_found') throw new TunnelHttpError(404, 'plan_document_not_found', 'plan not found')
        throw error
      })
      const document = record(read.document)
      if (rest.length === 4) return { status: 200, body: String(document.markdown ?? ''), contentType: 'text/markdown; charset=utf-8' }
      return { status: 200, body: document }
    }
    if (rest[0] === 'terminals') {
      const session = await this.requireSession(sessionId)
      return this.files.sessionTerminals(route, sessionId, session.cwd)
    }
    throw notFound(`${route.method} sessions/{id}/${rest.join('/')} is not served by this device`)
  }

  private async timeline(sessionId: string, route: Route): Promise<TunnelApiResponse> {
    const mode = route.query.get('mode') ?? 'latest'
    if (mode !== 'latest' && mode !== 'changes' && mode !== 'history') throw invalid('mode must be latest, changes or history')
    const limit = int(route.query.get('limit'), 100, 1, 500)
    let read: { mode: 'before' | 'after' | 'latest'; cursor: number | null }
    if (mode === 'history') {
      if (route.query.get('beforeOrderSeq') === null) throw invalid('beforeOrderSeq is required for history mode')
      read = { mode: 'before', cursor: int(route.query.get('beforeOrderSeq'), 1, 1, Number.MAX_SAFE_INTEGER) }
    } else if (mode === 'changes') read = { mode: 'after', cursor: int(route.query.get('afterSeq'), 0, 0, Number.MAX_SAFE_INTEGER) }
    else read = { mode: 'latest', cursor: null }
    const page = await this.deps.readers.read({ sessionId, mode: read.mode, cursor: read.cursor, limit })
    return { status: 200, body: { sessionId, items: page.items, nextSeq: page.headSeq, hasMore: page.hasMore, serverTime: this.now(), historySource: 'live', deviceOffline: false } }
  }

  private async events(sessionId: string, route: Route): Promise<TunnelApiResponse> {
    const after = cursorSeq(route.query.get('after'))
    const answer = (events: unknown[], cursor: number, snapshotRequired: boolean): TunnelApiResponse => ({
      status: 200,
      body: { events, nextCursor: eventCursor(cursor), snapshotRequired, serverTime: this.now(), deviceOffline: false },
    })
    let cursor = after
    const events: unknown[] = []
    for (let page = 0; page < 8; page++) {
      const changes = await this.deps.readers.changesSince({ sessionId, afterSeq: cursor })
      if (changes.snapshotRequired) return answer([], changes.toSeq, true)
      events.push(...(changes.events ?? []))
      cursor = Math.max(cursor, changes.toSeq)
      if (changes.complete) return answer(events, cursor, false)
    }
    // Too far behind to replay through one request: the client reloads the snapshot.
    return answer([], cursor, true)
  }

  // ----------------------------------------------------------------------------------------- messages

  /** `POST runtime/messages`: archived and read-only sessions refuse it; the device decides about busy and the queue. */
  private async sendMessage(caller: ChannelCaller, call: Call, sessionId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    const source = sessionSourceError({ archived: this.archived(session, call), sourceAvailability: session.sourceAvailability })
    if (source !== null) throw conflict(source.code, source.message)
    this.requireTakeover(session, call)
    if (typeof body.content !== 'string') throw invalid('content is required')
    const queue = body.queue ?? null
    if (queue !== null && (typeof queue !== 'string' || !QUEUE_MODES.has(queue))) throw invalid('queue must be auto, interrupt or never')
    const attachments = attachmentsOf(body, call.attachments)
    const clientMessageId = call.command?.commandId ?? text(body.clientMessageId) ?? this.newId('msg_')
    return okBody(await this.commandAs(409, caller, call, 'sessionSendMessage', {
      sessionId,
      clientMessageId,
      content: body.content,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(queue !== null ? { queue } : {}),
    }, clientMessageId))
  }

  /** `POST runtime/steer`: only into a running turn, when the Runtime can steer and takes the attachments' types. */
  private async steer(caller: ChannelCaller, call: Call, sessionId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    this.requireTakeover(session, call)
    if (session.status !== 'running' && session.status !== 'waiting_approval') throw conflict('session_not_running', 'session is not running')
    await this.requireCapability(session, call, 'session.steer')
    if (typeof body.content !== 'string') throw invalid('content is required')
    const attachments = attachmentsOf(body, call.attachments)
    await this.requireAttachmentTypes(session, call, attachments)
    const clientMessageId = call.command?.commandId ?? text(body.clientMessageId) ?? this.newId('msg_')
    return okBody(await this.commandAs(502, caller, call, 'sessionSteer', {
      sessionId,
      clientMessageId,
      content: body.content,
      ...(attachments.length > 0 ? { attachments } : {}),
    }, clientMessageId))
  }

  /**
   * `PATCH runtime/selections`: the whole batch in one `session.select`; model and permission need their catalog
   * capability. Answers the runtime state with the selections applied.
   */
  private async select(caller: ChannelCaller, call: Call, sessionId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    this.requireTakeover(session, call)
    const selections = inputObject(body.selections)
    const entries = Object.entries(selections ?? {})
    if (selections === null || entries.length === 0 || entries.length > 32) throw invalid('selections must name 1 to 32 options')
    for (const [key, value] of entries) if (value !== null && typeof value !== 'string') throw invalid(`selection ${key} must be a string or null`)
    for (const [kind, capabilityId] of Object.entries(SELECTION_CAPABILITIES)) {
      if (kind in selections) await this.requireCapability(session, call, capabilityId)
    }
    const result = await this.commandAs(502, caller, call, 'sessionSelect', { sessionId, selections }, text(body.commandId))
    if (result.ok === false) throw new TunnelHttpError(502, text(result.code) ?? 'runtime_rejected', text(result.message) ?? text(result.code) ?? 'runtime rejected selection update')
    const state = runtimeStateView(inputObject(result.state), await this.requireSession(sessionId), this.now(), selections)
    return { status: 200, body: { ok: true, state, connectorResult: result, serverTime: this.now() } }
  }

  /**
   * `POST runtime/notices/{n}/respond`: the notice's context is merged into the answer's input (v2 clients send it as
   * `inputData` too). A notice that is gone answers `{ok: false, error}` with 200, like the Server did.
   */
  private async respond(caller: ChannelCaller, call: Call, sessionId: string, noticeId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    await this.requireCapability(session, call, 'session.interaction.approval')
    const actionId = typeof body.actionId === 'string' ? body.actionId : null
    if (actionId === null) throw invalid('actionId is required')
    const userInput = inputObject(body.input) ?? inputObject(body.inputData)
    const interaction = await this.deps.store.interactions.get(sessionId, noticeId)
    const input = noticeAnswerInput(interaction === null ? null : interaction.payload, userInput)
    const responseId = call.command?.commandId ?? text(body.responseId) ?? this.newId('rsp_')
    let result: Record<string, unknown>
    try {
      result = await this.command(caller, call, 'sessionRespondNotice', {
        sessionId,
        noticeId,
        actionId,
        responseId,
        ...(input !== null ? { input } : {}),
      }, responseId)
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error
      if (NOTICE_GONE_CODES.has(error.code)) return { status: 200, body: { ok: false, result: null, error: { code: error.code, message: error.message } } }
      throw new TunnelHttpError(error.code === 'conflict' ? 409 : 502, error.code, error.message)
    }
    if (result.ok === false) {
      return { status: 200, body: { ok: false, result, error: { code: text(result.code) ?? 'runtime_operation_failed', message: text(result.message) ?? 'Runtime 未接受该回答。' } } }
    }
    return okBody(result)
  }

  // -------------------------------------------------------------------------------------- slash commands

  /** `GET runtime/commands`: the Runtime's catalog, then the commands of the session's native desktop app. */
  private async listCommands(sessionId: string, call: Call, route: Route): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    await this.requireCapability(session, call, 'session.commands')
    const query = route.query.get('query')
    if (query !== null && query.length > 4096) throw invalid('query is too long')
    const limit = int(route.query.get('limit'), 100, 1, 1000)
    const catalog = this.deps.commands?.(sessionId) ?? []
    const appCommands = (await this.deps.nativeApps?.list(sessionId)) ?? []
    return { status: 200, body: { commands: [...commandViews(catalog, query, limit), ...appCommandViews(appCommands, query)].slice(0, limit), serverTime: this.now() } }
  }

  /**
   * `POST runtime/commands`: `/plan` runs the planning command; a command of the session's native desktop app runs
   * on the device (`nativeApps`); any other command must be in the session's catalog and is sent as the message
   * `/<command> <args>`. A failure is a result with `ok: false`, not an HTTP error.
   */
  private async executeCommand(caller: ChannelCaller, call: Call, sessionId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    const command = typeof body.command === 'string' ? body.command : ''
    if (command.length === 0 || command.length > 64 || !SLASH_COMMAND.test(command)) throw invalid('command must be a command name')
    const rawArgs = body.args ?? []
    if (!Array.isArray(rawArgs) || rawArgs.length > 32 || !rawArgs.every(arg => typeof arg === 'string')) throw invalid('args must be at most 32 strings')
    const args = rawArgs as string[]
    const raw = body.raw ?? null
    if (raw !== null && (typeof raw !== 'string' || raw.length > 4096)) throw invalid('raw must be a string of at most 4096 characters')
    const operationId = call.command?.commandId ?? text(body.operationId)
    const answer = (result: Record<string, unknown>): TunnelApiResponse => ({ status: 200, body: { ...result, serverTime: this.now() } })
    if (command === 'plan') {
      await this.requireCapability(session, call, 'session.planning')
      const intent = parsePlanCommand(raw ?? `/plan${args.length > 0 ? ` ${args.join(' ')}` : ''}`)
      if (intent === null) throw invalid('raw must invoke /plan')
      const planOperation = operationId ?? this.newId('op_')
      let planning: Record<string, unknown>
      try {
        planning = await this.command(caller, call, 'sessionPlanning', { sessionId, ...intent, operationId: planOperation }, planOperation)
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error
        planning = { ok: false, code: error.code, message: error.message, operationId: planOperation, outcome: 'rejected' }
      }
      const ok = planning.ok !== false
      const executionState = planning.outcome === 'unknown' ? 'unknown' : ok ? 'accepted' : 'completed'
      return answer(slashResult('plan', ok, text(planning.code), text(planning.message), { planning, executionState, retryable: false }))
    }
    await this.requireCapability(session, call, 'session.commands')
    const app = await this.deps.nativeApps?.execute(sessionId, command, args, { takeover: this.takeover(session, call) })
    if (app != null) return answer(slashResult(command, app.ok, app.code, app.message, app.result))
    const catalog = this.deps.commands?.(sessionId) ?? []
    const name = command.replace(/^\//u, '')
    if (!catalog.some(item => item.name === name)) return answer(slashResult(name, false, 'command_unavailable', COMMAND_UNAVAILABLE, { executionState: 'completed' }))
    const content = commandText(name, args, raw as string | null)
    if (content === null) return answer(slashResult(name, false, 'invalid_command', COMMAND_MISMATCH, { executionState: 'completed' }))
    const clientMessageId = operationId ?? this.newId('cmd_')
    try {
      const sent = await this.command(caller, call, 'sessionSendMessage', { sessionId, clientMessageId, content }, clientMessageId)
      return answer(slashResult(name, true, null, null, { ...sent, clientMessageId, executionState: 'accepted' }))
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error
      return answer(slashResult(name, false, error.code, error.message, { executionState: 'completed' }))
    }
  }

  // -------------------------------------------------------------------------------------- planning, goal

  private async planning(caller: ChannelCaller, call: Call, sessionId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    if (this.archived(session, call)) throw conflict('session_archived', '会话已归档。')
    await this.requireCapability(session, call, 'session.planning')
    if (typeof body.command === 'string' && PLAN_REVIEW_COMMANDS.has(body.command)) await this.requireCapability(session, call, 'session.plan_review')
    if (Array.isArray(body.attachments) && body.attachments.length > 0) await this.requireCapability(session, call, 'runtime.attachment')
    const operationId = call.command?.commandId ?? text(body.operationId)
    return { status: 200, body: await this.commandAs(null, caller, call, 'sessionPlanning', { ...body, sessionId, ...(operationId !== null ? { operationId } : {}) }, operationId) }
  }

  private async goal(caller: ChannelCaller, call: Call, sessionId: string, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    const session = await this.requireSession(sessionId)
    if (this.archived(session, call) || !this.takeover(session, call)) throw conflict('goal_control_not_allowed', 'goal_control_not_allowed')
    await this.requireCapability(session, call, 'session.goal')
    if (Array.isArray(body.attachments) && body.attachments.length > 0) await this.requireCapability(session, call, 'runtime.attachment')
    const operationId = call.command?.commandId ?? text(body.operationId)
    return { status: 200, body: await this.commandAs(null, caller, call, 'sessionGoal', { ...body, sessionId, ...(operationId !== null ? { operationId } : {}) }, operationId) }
  }

  /** Queue commands answer the queue state (`SessionQueueState`), like the Server's queue routes. */
  private async queue(caller: ChannelCaller, call: Call, route: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.commandAs(null, caller, call, route, payload, null)
    return (await this.deps.readers.queue({ sessionId: String(payload.sessionId) })).queue
  }

  /**
   * `POST /sessions/create-and-start`: the session id is the Server's when it forwarded the call, else the device
   * allocates one (no Server row exists yet in encrypted mode); the device creates and starts the session with the
   * first message (`CommandInbox.createAndStart`, with an optional planning or goal intent) and reports it through
   * the outbox. A retry with the same `clientMessageId` returns the first attempt's session.
   */
  private async createAndStart(caller: ChannelCaller, call: Call, body: Record<string, unknown>): Promise<TunnelApiResponse> {
    if (text(body.connectorId) !== null && body.connectorId !== this.deps.deviceId) throw invalid('connectorId is not this device')
    const attachments = call.attachments !== null ? attachmentsOf(body, call.attachments) : []
    if (call.attachments === null && Array.isArray(body.attachments) && body.attachments.length > 0) {
      throw new TunnelHttpError(409, 'e2ee_attachments_unsupported', 'The first message of an end-to-end encrypted session cannot carry attachments yet.')
    }
    const runtimeType = text(body.runtime) ?? 'codex'
    const cwd = text(body.cwd)
    if (cwd === null) throw invalid('cwd is required')
    const clientMessageId = call.command?.commandId ?? text(body.clientMessageId) ?? this.newId('create_')
    const previous = await this.deps.store.commands.get(clientMessageId)
    const sessionId = call.sessionId ?? (typeof previous?.sessionId === 'string' ? previous.sessionId : `sess_${randomBytes(16).toString('hex')}`)
    const payload = {
      sessionId,
      runtimeId: text(body.runtimeId) ?? runtimeType,
      runtimeType,
      cwd,
      ...(text(body.projectId) !== null ? { projectId: body.projectId } : {}),
      ...(text(body.title) !== null ? { title: body.title } : {}),
      ...(Object.keys(record(body.selections)).length > 0 ? { selections: record(body.selections) } : {}),
      clientMessageId,
      content: typeof body.content === 'string' ? body.content : '',
      ...(attachments.length > 0 ? { attachments } : {}),
      takeover: true,
      ...(body.planningIntent != null ? { planningIntent: body.planningIntent } : {}),
      ...(body.goalIntent != null ? { goalIntent: body.goalIntent } : {}),
    }
    let result: Record<string, unknown>
    try {
      result = await this.settle(caller, call, CREATE_AND_START_METHOD, payload, clientMessageId, (command, actor) => this.deps.inbox.createAndStart(command, actor))
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error
      throw new TunnelHttpError(statusOf(error.code), error.code, error.message)
    }
    const session = await this.requireSession(sessionId)
    return { status: 200, body: { session: sessionView(this.deps.deviceId, session, text(body.title)), connectorResult: result, attachments } }
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
    const params = { terminalId, sessionId: `browse_${this.deps.deviceId}`, fromSeq }
    const snapshot = await terminals.attach(params, sink)
    if (typeof snapshot.dataBase64 === 'string') emit({ type: 'replay', data: snapshot.dataBase64, seq: typeof snapshot.seq === 'number' ? snapshot.seq : fromSeq })
    const terminal = record(snapshot.terminal)
    if (terminal.status === 'exited') emit({ type: 'exit', exitCode: typeof terminal.exitCode === 'number' ? terminal.exitCode : null, reason: 'exit' })
    return () => void terminals.release(params, sink).catch(() => undefined)
  }
}

