/**
 * The plugin's ACP Agent for contracts/dsh-bridge/3.0: host sessions exposed to one
 * Connector connection. The Agent only attaches to host sessions; it never disposes a
 * user's Agent, cancels a turn on disconnect, or holds anything the host would not
 * hold without it (invariant I1).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { PromptContentPart, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import * as acp from '@agentclientprotocol/sdk'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { IMAGE_MIME_TYPES } from '../dsh-runtime/attachments.js'
import { BRIDGE_PROTOCOL, DSH_METHODS, type DshAgentMeta, type DshFeatures, type DshLoadResultMeta, type DshPromptMeta,
  type DshSessionInfoMeta, type DshTurnNotification, type Writer } from '../../contracts/bridge-v3.js'
import { admitted, type NativeChange, type NativeRuntime } from '../dsh-runtime/native.js'
import { BridgeError } from '../dsh-runtime/errors.js'
import { continuationRequestId, latestTurnOutcome } from '../dsh-runtime/turn-outcome.js'
import { permissionSelectionId } from '../dsh-runtime/selections.js'
import type { QuestionForm } from '../dsh-runtime/question-form.js'
import { record } from '../dsh-runtime/types.js'
import { abandonedUpdate, eventUpdates, stopReasonOf, streamUpdate, turnUpdate, userSource, writerUpdate, type ProjectedUpdate } from './projection.js'

export interface HostFacts {
  hostInstance: string
  dshVersion: string
  pluginVersion: string
  /** Files named by `_meta.dsh.upload` must lie under this directory (the Connector's data directory). */
  uploadRoot?: string
}

interface PromptPlan {
  text: string
  images: { mediaType: ImageMediaType, data: string }[]
  uploads: { path: string, name: string, size: number }[]
}

const LIST_PAGE = 100
const MAX_REQUEST_ID = 512

function acpError(code: number, message: string, data: Record<string, unknown>): acp.RequestError {
  return new acp.RequestError(code, message, data)
}
const notFound = () => acpError(-32002, 'The session is not visible in DSH.', { code: 'session_not_found' })
const writerHeld = () => acpError(-32002, 'Another process holds this DSH session.', { code: 'writer_held' })
const invalid = (message: string) => acpError(-32602, message, { code: 'invalid_params' })

/** Map plugin errors onto contracts §11. */
function toAcpError(error: unknown): unknown {
  if (error instanceof acp.RequestError) return error
  if (error instanceof BridgeError) {
    if (error.code === 'SESSION_NOT_FOUND') return notFound()
    if (error.code === 'INVALID_PARAMS') return invalid(error.message)
    if (error.code === 'UNSUPPORTED_OPERATION') return acpError(-32601, error.message, { code: 'unsupported' })
    return acpError(-32603, error.message, { code: 'dsh_unavailable', retryable: error.retryable })
  }
  if (record(error).code === 'session/writer-held') return writerHeld()
  return error
}

interface TurnState { turn: number, startSeq: number, requestIds: string[] }
interface Pending { requestId: string, resolve: (value: acp.PromptResponse) => void, reject: (error: unknown) => void }
interface Attached {
  /** Events with seq <= this were already sent; replay and live delivery never repeat one. */
  sentThrough: number
  /** Live changes queued while a replay is in flight. */
  buffer: NativeChange[] | undefined
  turn: TurnState | undefined
  attempt: { attemptId: string, turn: number, step: number } | undefined
}

/** Model option values follow DSH's own automation ACP: JSON.stringify([provider, model]). */
const modelValue = (provider: string, model: string) => JSON.stringify([provider, model])

export class DshAcpAgent implements acp.Agent {
  private readonly attached = new Map<string, Attached>()
  /** Per-session turn state, kept for every session with a pending prompt even when not attached. */
  private readonly turns = new Map<string, TurnState>()
  private readonly pending = new Map<string, Pending[]>()
  private readonly approvals = new Map<string, { sessionId: string, abort: AbortController, answered: boolean }>()
  private readonly questions = new Map<string, { sessionId: string, abort: AbortController, answered: boolean }>()
  /** Sessions this connection created; DSH hides them until their first user message. */
  private readonly created = new Set<string>()
  private listSubscribed = false
  /** The Connector declared `clientCapabilities.elicitation`: questions go to it (§10). */
  private elicitation = false
  private readonly listed = new Set<string>()
  private readonly listTimers = new Map<string, NodeJS.Timeout>()
  private readonly unwatch: () => void
  private closed = false
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly conn: acp.AgentSideConnection, private readonly native: NativeRuntime,
    private readonly facts: HostFacts) {
    this.unwatch = native.watch(change => { this.chain = this.chain.then(() => this.onChange(change)).catch(() => undefined) })
  }

  private get ctx(): Context { return this.native.ctx }

  features(): DshFeatures {
    const controller = this.ctx.get('sessionController')
    return {
      queue: Boolean(controller),
      steer: Boolean(controller),
      continue: typeof controller?.projections === 'function',
      planning: Boolean(this.native.planning.service()),
      // Questions need client elicitation (§10); without it they stay in the DSH UI.
      questions: this.elicitation && this.native.questions.available,
      attachments: Boolean(this.ctx.get('attachments')),
      fileUploads: Boolean(this.ctx.get('fileUploads')),
      agentPresets: Boolean(this.ctx.get('agentPresets')),
      permissionPresets: this.native.configuration.canSelectPermission,
    }
  }

  meta(): DshAgentMeta {
    return { bridgeProtocol: BRIDGE_PROTOCOL, hostInstance: this.facts.hostInstance, dshVersion: this.facts.dshVersion, features: this.features() }
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    if (params.protocolVersion < 1) throw invalid('ACP protocol version 1 is required.')
    this.elicitation = record(params.clientCapabilities).elicitation !== undefined && record(params.clientCapabilities).elicitation !== null
    return {
      protocolVersion: 1,
      agentInfo: { name: 'agents-anywhere-dsh-bridge', version: this.facts.pluginVersion },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: Boolean(this.ctx.get('attachments')), audio: false, embeddedContext: false },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      authMethods: [],
      _meta: { dsh: this.meta() },
    }
  }

  async authenticate(): Promise<void> {}

  // ---------------------------------------------------------------- list

  private writer(id: string): Writer {
    return this.ctx.get('agents')?.get(id as SessionId) ? 'host' : 'none'
  }

  private async sessionInfos(ids: readonly string[], signal?: AbortSignal): Promise<acp.SessionInfo[]> {
    const titles = await this.ctx.sessionQuery.readTitleSnapshots(ids as readonly SessionId[], signal)
    const titleById = new Map(titles.map(item => [item.sessionId as string, item]))
    const infos: acp.SessionInfo[] = []
    for (const id of ids) {
      const record = this.native.source.records.get(id)
      const live = this.ctx.sessions.get(id as SessionId)
      const header = live?.header ?? record?.header
      if (!header?.cwd) continue
      const title = titleById.get(id)
      const lastSeq = live ? Math.max(0, Number(live.seq) - 1) : 0
      const meta: DshSessionInfoMeta = {
        createdAt: new Date(header.createdAt).toISOString(), running: this.native.status(id as SessionId) === 'running',
        lastSeq, writer: this.writer(id),
      }
      infos.push({ sessionId: id, cwd: header.cwd,
        title: title?.status === 'fulfilled' ? title.value.title?.title ?? null : null,
        updatedAt: null, _meta: { dsh: meta } })
    }
    return infos
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const records = (await this.native.inventory()).filter(item => !params.cwd || item.header.cwd === params.cwd)
    records.sort((a, b) => b.header.createdAt - a.header.createdAt)
    const start = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    if (!Number.isInteger(start) || start < 0) throw invalid('Invalid cursor.')
    const page = records.slice(start, start + LIST_PAGE)
    const sessions = await this.sessionInfos(page.map(item => item.header.id))
    for (const info of sessions) this.listed.add(info.sessionId)
    return { sessions, nextCursor: start + LIST_PAGE < records.length ? String(start + LIST_PAGE) : null }
  }

  private scheduleListChange(id: string): void {
    if (!this.listSubscribed || this.listTimers.has(id)) return
    this.listTimers.set(id, setTimeout(() => {
      this.listTimers.delete(id)
      void this.pushListChange(id).catch(() => undefined)
    }, 50))
  }

  private async pushListChange(id: string): Promise<void> {
    if (this.closed || !this.listSubscribed) return
    if (await this.native.visible(id)) {
      const [info] = await this.sessionInfos([id])
      if (!info) return
      this.listed.add(id)
      await this.conn.notify(DSH_METHODS.listChanges, { upserts: [info], removals: [] })
    } else if (this.listed.delete(id)) {
      await this.conn.notify(DSH_METHODS.listChanges, { upserts: [], removals: [id] })
    }
  }

  // ---------------------------------------------------------------- sessions

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const meta = record(record(params._meta).dsh)
    const id = meta.sessionId
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw invalid('_meta.dsh.sessionId is required.')
    if (!isAbsolute(params.cwd)) throw invalid('cwd must be absolute.')
    let path: string
    try {
      path = await realpath(params.cwd)
      if (!(await stat(path)).isDirectory()) throw new Error('not a directory')
    } catch { throw invalid('The workspace must be an accessible directory on the DSH device.') }
    try {
      await this.native.source.initialize()
      const existing = this.ctx.sessions.get(id as SessionId)?.header ?? this.native.source.records.get(id)?.header
      if (existing) {
        if (existing.cwd !== path) throw invalid('The session already uses a different workspace.')
      } else {
        const controller = this.native.configuration.controller()
        const preset = typeof meta.agentPreset === 'string' ? await this.native.configuration.validatePreset(meta.agentPreset) : undefined
        await controller.create({ sessionId: id as SessionId, cwd: path, ...(preset ? { agentPreset: preset } : {}) } as never)
        const workspace = await this.ctx.workspaceRegistry.create(path)
        await workspace.attachSession(id as SessionId)
      }
      this.created.add(id)
      this.attach(id, Math.max(-1, this.currentSeq(id)))
      return { sessionId: id, configOptions: await this.configOptions(id), _meta: { dsh: await this.loadMeta(id) } }
    } catch (error) { throw toAcpError(error) }
  }

  private currentSeq(id: string): number {
    const live = this.ctx.sessions.get(id as SessionId)
    return live ? Number(live.seq) - 1 : -1
  }

  private attach(id: string, sentThrough: number, buffer?: NativeChange[]): Attached {
    const entry: Attached = { sentThrough, buffer, turn: this.turns.get(id), attempt: undefined }
    this.attached.set(id, entry)
    return entry
  }

  private async loadMeta(id: string, truncated = false): Promise<DshLoadResultMeta> {
    const events = this.ctx.sessions.get(id as SessionId)?.snapshotEvents() ?? (await this.native.read(id as SessionId)).events
    const outcome = latestTurnOutcome(events)
    const continuable = outcome?.kind === 'failed' && await this.native.continuable(id as SessionId, outcome.endSeq) ? outcome.endSeq : null
    return { lastSeq: Math.max(0, Number(events.at(-1)?.seq ?? 0)), running: this.native.status(id as SessionId) === 'running',
      continuable, writer: this.writer(id), ...(truncated ? { replayTruncated: true } : {}) }
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const from = Number(record(record(params._meta).dsh).replayFromSeq ?? 0)
    if (!Number.isInteger(from) || from < 0) throw invalid('replayFromSeq must be a non-negative integer.')
    return this.open(params.sessionId, from)
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    return this.open(params.sessionId, Number.MAX_SAFE_INTEGER)
  }

  private async open(id: string, from: number): Promise<acp.LoadSessionResponse> {
    try {
      await this.native.ensureKnown(id)
      if (!await this.native.visible(id)) throw notFound()
      // Buffer live changes while replaying so nothing is lost or reordered.
      const entry = this.attach(id, from - 1, [])
      const live = this.ctx.sessions.get(id as SessionId)
      const events = live?.snapshotEvents() ?? (await this.native.read(id as SessionId)).events
      const turn = this.replayTurnState(events)
      if (turn && !this.turns.has(id)) this.turns.set(id, turn)
      entry.turn = this.turns.get(id)
      for (const event of events) {
        if (Number(event.seq) < from) continue
        await this.sendEvent(id, entry, event, true)
      }
      entry.turn = this.turns.get(id)
      const buffered = entry.buffer ?? []
      entry.buffer = undefined
      for (const change of buffered) await this.deliver(id, entry, change)
      // Requests already waiting when the Connector attached are asked now.
      void this.syncApprovals(id).then(() => this.syncQuestions(id)).catch(() => undefined)
      const truncated = from > 0 && from !== Number.MAX_SAFE_INTEGER && events.length > 0 && Number(events[0]!.seq) > from
      return { configOptions: await this.configOptions(id), _meta: { dsh: await this.loadMeta(id, truncated) } }
    } catch (error) {
      this.attached.delete(id)
      throw toAcpError(error)
    }
  }

  /** The open turn at the end of a log, if a turn started and has not ended. */
  private replayTurnState(events: readonly SessionEvent[]): TurnState | undefined {
    let state: TurnState | undefined
    for (const event of events) {
      if (event.type === 'turn/start') state = { turn: event.data.turn, startSeq: Number(event.seq), requestIds: [] }
      else if (event.type === 'turn/end') state = undefined
      else if (event.type === 'user/message' && state) {
        const source = userSource(event)
        if (source.requestId && source.kind !== 'other') state.requestIds.push(source.requestId)
      }
    }
    return state
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    // Detach only (contracts §5, invariant I1).
    this.attached.delete(params.sessionId)
    for (const [eventId, approval] of this.approvals) if (approval.sessionId === params.sessionId) {
      approval.abort.abort(); this.approvals.delete(eventId)
    }
    for (const [eventId, question] of this.questions) if (question.sessionId === params.sessionId) {
      question.abort.abort(); this.questions.delete(eventId)
    }
    return {}
  }

  // ---------------------------------------------------------------- live changes

  private async onChange(change: NativeChange): Promise<void> {
    if (this.closed) return
    if (change.type === 'event') this.trackTurn(change.id, change.event)
    if (change.type === 'session' || change.type === 'status' || change.type === 'visibility'
      || (change.type === 'event' && (change.event.type === 'session/title' || change.event.type === 'turn/start' || change.event.type === 'turn/end'))) {
      if (change.type === 'visibility') for (const id of this.listed) this.scheduleListChange(id)
      else this.scheduleListChange(change.id)
    }
    if (change.type === 'approval') await this.syncApprovals(change.id)
    if (change.type === 'question') await this.syncQuestions(change.id)
    if ('id' in change) {
      const entry = this.attached.get(change.id)
      if (entry) {
        if (entry.buffer) entry.buffer.push(change)
        else await this.deliver(change.id, entry, change)
      }
    }
  }

  /** Turn bookkeeping that settles `delivery: "turn"` prompts, attached or not. */
  private trackTurn(id: string, event: SessionEvent): void {
    if (event.type === 'turn/start') this.turns.set(id, { turn: event.data.turn, startSeq: Number(event.seq), requestIds: [] })
    else if (event.type === 'user/message') {
      const source = userSource(event)
      const turn = this.turns.get(id)
      if (turn && source.requestId && source.kind !== 'other' && !turn.requestIds.includes(source.requestId)) turn.requestIds.push(source.requestId)
    } else if (event.type === 'turn/end') {
      const turn = this.turns.get(id)
      this.turns.delete(id)
      const waiting = this.pending.get(id)
      if (!waiting || !turn) return
      const stopReason = stopReasonOf(event.data.reason.kind)
      const remaining = waiting.filter(item => {
        if (!turn.requestIds.includes(item.requestId)) return true
        item.resolve({ stopReason })
        return false
      })
      if (remaining.length) this.pending.set(id, remaining)
      else this.pending.delete(id)
    }
  }

  private async deliver(id: string, entry: Attached, change: NativeChange): Promise<void> {
    if (change.type === 'event') await this.sendEvent(id, entry, change.event, false)
    else if (change.type === 'stream') {
      const attemptId = change.attemptId ?? `${change.turn}:${change.step}`
      if (entry.attempt?.attemptId !== attemptId) entry.attempt = { attemptId, turn: change.turn, step: change.step }
      const update = streamUpdate(id, change.chunk, entry.attempt.attemptId, change.throughSeq, change.turn, change.step)
      if (update) await this.update(id, update)
    } else if (change.type === 'refresh' && change.interrupted && entry.attempt) {
      await this.update(id, abandonedUpdate(entry.attempt.attemptId, entry.sentThrough, entry.attempt.turn))
      entry.attempt = undefined
    }
  }

  private async sendEvent(id: string, entry: Attached, event: SessionEvent, replay: boolean): Promise<void> {
    const seq = Number(event.seq)
    if (seq <= entry.sentThrough) return
    entry.sentThrough = seq
    if (replay) this.replayTurn(entry, event)
    const turn = entry.turn?.turn ?? (event.type === 'turn/end' ? event.data.turn : undefined)
    const attempt = event.type === 'assistant/message' ? entry.attempt?.attemptId : undefined
    if (event.type === 'assistant/message') entry.attempt = undefined
    for (const update of await eventUpdates(this.ctx, id, event, turn, attempt)) await this.update(id, update)
    if (event.type === 'turn/start') {
      await this.notifyTurn({ sessionId: id, phase: 'started', turn: event.data.turn, seq })
    } else if (event.type === 'turn/end') {
      const reason = event.data.reason as { kind: string, error?: { message?: string } }
      const continuable = reason.kind === 'error' && !replay ? await this.native.continuable(id as SessionId, seq) : false
      const requestIds = replay ? entry.turn?.requestIds ?? [] : this.endedRequestIds(id, entry)
      await this.notifyTurn({ sessionId: id, phase: 'ended', turn: event.data.turn, seq, requestIds,
        stopReason: stopReasonOf(reason.kind),
        reason: { kind: reason.kind, ...(typeof reason.error?.message === 'string' ? { message: reason.error.message } : {}) }, continuable })
      if (replay) entry.turn = undefined
    }
    if (!replay) entry.turn = this.turns.get(id)
  }

  private replayTurn(entry: Attached, event: SessionEvent): void {
    if (event.type === 'turn/start') entry.turn = { turn: event.data.turn, startSeq: Number(event.seq), requestIds: [] }
    else if (event.type === 'user/message' && entry.turn) {
      const source = userSource(event)
      if (source.requestId && source.kind !== 'other' && !entry.turn.requestIds.includes(source.requestId)) entry.turn.requestIds.push(source.requestId)
    }
  }

  /** trackTurn already removed the ended turn; the attached copy still holds its inputs. */
  private endedRequestIds(_id: string, entry: Attached): string[] { return entry.turn?.requestIds ?? [] }

  private async update(sessionId: string, update: ProjectedUpdate): Promise<void> {
    if (this.closed) return
    await this.conn.sessionUpdate({ sessionId, update })
  }

  private async notifyTurn(params: DshTurnNotification): Promise<void> {
    // Turn boundaries ride the ordered session/update stream: the SDK dispatches extension
    // notifications on a separate path, so they may overtake updates and responses.
    await this.update(params.sessionId, turnUpdate(params))
  }

  // ---------------------------------------------------------------- prompt

  private promptMeta(value: unknown): DshPromptMeta {
    const meta = record(record(value).dsh)
    const requestId = meta.requestId
    if (typeof requestId !== 'string' || !requestId || Buffer.byteLength(requestId) > MAX_REQUEST_ID) {
      throw invalid('_meta.dsh.requestId is required (at most 512 bytes).')
    }
    const delivery = meta.delivery === 'queue' ? 'queue' : 'turn'
    return { requestId, delivery, selections: record(meta.selections) as DshPromptMeta['selections'] & object }
  }

  /** Validates a prompt (§8) before anything is admitted; uploads happen only for a new admission. */
  private promptPlan(prompt: readonly acp.ContentBlock[]): PromptPlan {
    let text = ''
    const images: PromptPlan['images'] = []
    const uploads: PromptPlan['uploads'] = []
    for (const block of prompt) {
      if (block.type === 'text') text += block.text
      else if (block.type === 'image') {
        if (!this.ctx.get('attachments')) throw acpError(-32601, 'This DSH host cannot receive images.', { code: 'unsupported' })
        if (!IMAGE_MIME_TYPES.includes(block.mimeType as ImageMediaType) || typeof block.data !== 'string' || !block.data) throw invalid(`Image type ${block.mimeType} is not supported.`)
        images.push({ mediaType: block.mimeType as ImageMediaType, data: block.data })
      } else if (block.type === 'resource_link') {
        const upload = record(record(record((block as { _meta?: unknown })._meta).dsh).upload)
        if (typeof upload.path === 'string') {
          if (!this.ctx.get('fileUploads')) throw acpError(-32601, 'This DSH host cannot receive files.', { code: 'unsupported' })
          const size = Number(upload.size)
          if (!isAbsolute(upload.path) || !Number.isSafeInteger(size) || size < 0) throw invalid('_meta.dsh.upload needs an absolute path and a size.')
          uploads.push({ path: upload.path, name: typeof upload.name === 'string' && upload.name ? upload.name : block.name, size })
        } else text += `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
      } else throw invalid(`Prompt content ${block.type} is not supported by this host.`)
    }
    if (!text.trim() && !images.length && !uploads.length) throw invalid('empty prompt')
    if (images.length) {
      const limits = this.ctx.get('attachments')!.imageLimits
      const sizes = images.map(image => Buffer.byteLength(image.data, 'base64'))
      if (images.length > limits.maxImagesPerMessage || sizes.some(size => size > limits.maxImageBytes)
        || sizes.reduce((total, size) => total + size, 0) > limits.maxMessageImageBytes) throw invalid('Images exceed the DSH attachment size or count limits.')
    }
    return { text, images, uploads }
  }

  /** The DSH prompt parts of a plan; files under the Connector's data directory are uploaded to DSH first. */
  private async promptParts(id: string, plan: PromptPlan, signal: AbortSignal): Promise<PromptContentPart[]> {
    const parts: PromptContentPart[] = plan.text ? [{ type: 'text', text: plan.text }] : []
    plan.images.forEach((image, index) => parts.push({ type: 'image', name: `image-${index + 1}`, mediaType: image.mediaType, data: image.data }))
    for (const upload of plan.uploads) {
      const root = this.facts.uploadRoot
      if (!root) throw acpError(-32601, 'File uploads are not configured on this host.', { code: 'unsupported' })
      let path: string
      try { path = await realpath(upload.path) } catch { throw invalid('The uploaded file is gone.') }
      const base = await realpath(root).catch(() => root)
      if (!path.startsWith(`${base}${sep}`)) throw invalid('Uploads must come from the Connector data directory.')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size !== upload.size) throw invalid('The uploaded file does not match its size.')
        const result = await this.ctx.get('fileUploads')!.uploadStream({ sessionId: id as SessionId, name: upload.name,
          data: file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }) as AsyncIterable<Buffer>, signal })
        parts.push({ type: 'file', receiptId: result.receiptId })
      } finally { await file.close() }
    }
    return parts
  }

  private async agentFor(id: string) {
    const controller = this.native.configuration.controller()
    const found = await controller.resolveAgent(id as SessionId)
    if ('error' in found) {
      if (record(found.error).code === 'session/writer-held') {
        if (this.attached.has(id)) await this.update(id, writerUpdate('external')).catch(() => undefined)
        else await this.conn.notify(DSH_METHODS.writer, { sessionId: id, writer: 'external' }).catch(() => undefined)
        throw writerHeld()
      }
      if (record(found.error).code === 'session/not-found') throw notFound()
      throw acpError(-32603, 'DSH could not activate this session.', { code: 'dsh_unavailable', retryable: true })
    }
    return found.agent
  }

  private async admit(id: string, meta: DshPromptMeta, mode: 'queue' | 'steer', plan: PromptPlan,
    signal: AbortSignal): Promise<{ duplicate: boolean }> {
    await this.native.ensureKnown(id)
    if (!this.created.has(id) && !await this.native.visible(id)) throw notFound()
    const live = this.ctx.sessions.get(id as SessionId)
    const events = live?.snapshotEvents() ?? (this.created.has(id) ? [] : (await this.native.read(id as SessionId)).events)
    if (admitted(events, meta.requestId)) return { duplicate: true }
    const agent = await this.agentFor(id)
    await this.applySelections(id, meta.selections ?? {}, signal)
    const content = await this.promptParts(id, plan, signal)
    await this.native.configuration.controller().prompt({ sessionId: id as SessionId,
      requestId: meta.requestId as SessionPromptRequest['requestId'], mode, content }, signal)
    await this.ctx.sessions.flush(agent.session)
    return { duplicate: false }
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const meta = this.promptMeta(params._meta)
    const content = this.promptPlan(params.prompt)
    const id = params.sessionId
    let settle: Promise<acp.PromptResponse> | undefined
    if (meta.delivery !== 'queue') {
      // Register before admission: a fast turn may end before admit returns.
      settle = new Promise((resolve, reject) => {
        const list = this.pending.get(id) ?? []
        list.push({ requestId: meta.requestId, resolve, reject })
        this.pending.set(id, list)
      })
    }
    let result: { duplicate: boolean }
    try { result = await this.admit(id, meta, 'queue', content, this.conn.signal) }
    catch (error) {
      this.dropPending(id, meta.requestId)
      throw toAcpError(error)
    }
    if (!settle) return { stopReason: 'end_turn', _meta: { dsh: { admitted: true, ...(result.duplicate ? { duplicate: true } : {}) } } }
    if (result.duplicate && !this.turns.get(id)?.requestIds.includes(meta.requestId) && this.native.status(id as SessionId) !== 'running') {
      // Already admitted and its turn is long over.
      this.dropPending(id, meta.requestId)
      return { stopReason: 'end_turn', _meta: { dsh: { admitted: true, duplicate: true } } }
    }
    return settle
  }

  private dropPending(id: string, requestId: string): void {
    const list = this.pending.get(id)?.filter(item => item.requestId !== requestId)
    if (list?.length) this.pending.set(id, list)
    else this.pending.delete(id)
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    try {
      await this.native.interrupt(params.sessionId as SessionId)
    } catch { /* Cancelling an unknown or idle session is a no-op. */ }
  }

  // ---------------------------------------------------------------- config

  private async configOptions(id: string): Promise<acp.SessionConfigOption[]> {
    const options: acp.SessionConfigOption[] = []
    let state: Awaited<ReturnType<NativeRuntime['configuration']['state']>> | undefined
    try { state = await this.native.configuration.state(id as SessionId) } catch { state = undefined }
    const current = state?.metadata.modelSelection
    if (this.native.configuration.canSelectModel) {
      try {
        const catalog = await this.native.catalogs.models()
        const groups = new Map<string, { group: string, name: string, options: acp.SessionConfigSelectOption[] }>()
        for (const item of catalog.models) {
          if (!item.enabled) continue
          const provider = String(item.metadata.provider)
          const group = groups.get(provider) ?? { group: provider, name: String(item.metadata.providerName ?? provider), options: [] }
          group.options.push({ value: modelValue(provider, String(item.metadata.model)), name: item.title })
          groups.set(provider, group)
        }
        const value = current ? modelValue(current.provider, current.model) : groups.values().next().value?.options[0]?.value
        if (value) options.push({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: [...groups.values()] })
        const model = current && catalog.models.find(item => item.metadata.provider === current.provider && item.metadata.model === current.model)
        if (model?.reasoningItems.length) {
          options.push({ id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
            currentValue: current?.reasoningEffort ?? model.reasoningItems[0]!.id,
            options: model.reasoningItems.map(item => ({ value: item.id, name: item.title })) })
        }
      } catch { /* The model catalog is optional; DSH may have no routable provider yet. */ }
    }
    if (this.native.configuration.canSelectPermission) {
      try {
        const permissions = this.native.catalogs.permissions().permissions
        const preset = record(state?.metadata.permissionPreset).id
        if (permissions.length) options.push({ id: 'permission', name: 'Permissions', category: 'mode', type: 'select',
          currentValue: typeof preset === 'string' ? preset : String(permissions[0]!.metadata.preset),
          options: permissions.map(item => ({ value: String(item.metadata.preset), name: item.title, ...(item.description ? { description: item.description } : {}) })) })
      } catch { /* Permission presets are optional. */ }
    }
    return options
  }

  private async applySelections(id: string, selections: NonNullable<DshPromptMeta['selections']>, signal: AbortSignal): Promise<void> {
    if (selections.model || selections.reasoningEffort) {
      const current = (await this.native.configuration.state(id as SessionId)).metadata.modelSelection
      let provider = current?.provider
      let model = current?.model
      if (selections.model) {
        const parsed = JSON.parse(selections.model) as unknown
        if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw invalid('Invalid model value.')
        ;[provider, model] = parsed as [string, string]
      }
      if (!provider || !model) throw invalid('Choose a model first.')
      await this.native.configuration.controller().selectModel({ sessionId: id as SessionId, provider, model,
        ...(selections.reasoningEffort ? { reasoningEffort: selections.reasoningEffort } : {}) } as never)
    }
    if (selections.permission) {
      const agent = await this.agentFor(id)
      await this.native.configuration.apply(agent, { permission: permissionSelectionId(selections.permission) }, false, signal)
    }
  }

  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const value = String((params as { value: unknown }).value)
    const key = params.configId === 'model' ? 'model' : params.configId === 'reasoning_effort' ? 'reasoningEffort'
      : params.configId === 'permission' ? 'permission' : undefined
    if (!key) throw invalid(`Unknown config option ${params.configId}.`)
    try {
      await this.native.ensureKnown(params.sessionId)
      if (!await this.native.visible(params.sessionId)) throw notFound()
      await this.applySelections(params.sessionId, { [key]: value }, this.conn.signal)
      return { configOptions: await this.configOptions(params.sessionId) }
    } catch (error) { throw toAcpError(error) }
  }

  // ---------------------------------------------------------------- approvals

  private async syncApprovals(id: string): Promise<void> {
    const pending = new Set(this.native.approvals.pendingEntries(id).map(entry => entry.eventId))
    // Settled elsewhere: withdraw our request and tell the Connector who answered.
    for (const [eventId, approval] of this.approvals) {
      if (approval.sessionId !== id || pending.has(eventId)) continue
      this.approvals.delete(eventId)
      approval.abort.abort()
      if (!approval.answered && this.attached.has(id)) {
        const status = this.native.approvals.entryStatus(eventId)
        await this.conn.notify(DSH_METHODS.interactionResolved, { sessionId: id, interactionId: eventId,
          by: status === 'expired' ? 'timeout' : status === 'closed' ? 'cancelled' : 'dsh' }).catch(() => undefined)
      }
    }
    if (!this.attached.has(id)) return
    for (const entry of this.native.approvals.pendingEntries(id)) {
      if (this.approvals.has(entry.eventId)) continue
      const approval = { sessionId: id, abort: new AbortController(), answered: false }
      this.approvals.set(entry.eventId, approval)
      void this.askPermission(entry, approval)
    }
  }

  private async askPermission(entry: ReturnType<NativeRuntime['approvals']['pendingEntries']>[number],
    approval: { sessionId: string, abort: AbortController, answered: boolean }): Promise<void> {
    let response: acp.RequestPermissionResponse
    try {
      response = await this.conn.request('session/request_permission', {
        sessionId: entry.agentId,
        toolCall: { toolCallId: entry.callId ?? entry.eventId, title: entry.toolName, status: 'pending', kind: 'other' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        _meta: { dsh: { interactionId: entry.eventId, ...(entry.reason ? { reason: entry.reason } : {}) } },
      }, { cancellationSignal: approval.abort.signal })
    } catch { return }
    if (approval.abort.signal.aborted) return // The DSH UI answered first; this late answer is ignored (§10).
    const outcome = response.outcome
    if (outcome.outcome !== 'selected') return
    if (outcome.optionId !== 'allow-once' && outcome.optionId !== 'reject') return
    approval.answered = true
    await this.native.approvals.answer(entry.eventId, outcome.optionId)
  }

  // ---------------------------------------------------------------- questions and plan review (§10)

  private async syncQuestions(id: string): Promise<void> {
    const pending = new Set(this.native.questions.pendingEntries(id).map(entry => entry.eventId))
    for (const [eventId, question] of this.questions) {
      if (question.sessionId !== id || pending.has(eventId)) continue
      this.questions.delete(eventId)
      question.abort.abort()
      if (!question.answered && this.attached.has(id)) {
        const status = this.native.questions.entryStatus(eventId)
        await this.conn.notify(DSH_METHODS.interactionResolved, { sessionId: id, interactionId: eventId,
          by: status === 'expired' ? 'timeout' : status === 'closed' ? 'cancelled' : 'dsh' }).catch(() => undefined)
      }
    }
    if (!this.attached.has(id)) return
    for (const entry of this.native.questions.pendingEntries(id)) {
      if (this.questions.has(entry.eventId)) continue
      const review = entry.form.questions.length === 1 ? entry.form.questions.find(q => q.intent?.kind === 'plan-review') : undefined
      // A plan review is a permission request the Connector shows as a review; other questions need elicitation.
      if (!review && !this.elicitation) continue
      const question = { sessionId: id, abort: new AbortController(), answered: false }
      this.questions.set(entry.eventId, question)
      void (review ? this.askPlanReview(entry, review, question) : this.askQuestion(entry, question))
    }
  }

  private async askQuestion(entry: { eventId: string, agentId: string, form: QuestionForm },
    question: { abort: AbortController, answered: boolean }): Promise<void> {
    const input = entry.form.input()
    let response: Record<string, unknown>
    try {
      response = record(await this.conn.request('elicitation/create', {
        sessionId: entry.agentId,
        message: entry.form.questions.map(q => q.header ?? q.question).join(' / '),
        requestedSchema: input.schema,
        _meta: { dsh: { interactionId: entry.eventId, uiSchema: input.uiSchema } },
      }, { cancellationSignal: question.abort.signal }))
    } catch { return }
    if (question.abort.signal.aborted) return
    question.answered = true
    try {
      await this.native.questions.answerEvent(entry.eventId, response.action === 'accept' ? { kind: 'submit', input: response.content } : { kind: 'cancel' })
    } catch { question.answered = false }
  }

  private async askPlanReview(entry: { eventId: string, agentId: string, planCallId?: string },
    review: QuestionForm['questions'][number], question: { abort: AbortController, answered: boolean }): Promise<void> {
    const options = (review.options ?? []).map((option, index) => ({ optionId: `o_${index}`, name: option.label, label: option.label }))
    const approve = review.intent?.kind === 'plan-review' ? review.intent.approve : undefined
    const firstOther = options.find(option => option.label !== approve)
    let response: acp.RequestPermissionResponse
    try {
      response = await this.conn.request('session/request_permission', {
        sessionId: entry.agentId,
        toolCall: { toolCallId: entry.planCallId ?? entry.eventId, title: review.header ?? '请审阅计划', status: 'pending', kind: 'think',
          rawInput: { plan: review.detail ?? '' } },
        options: options.map(option => ({ optionId: option.optionId, name: option.name,
          kind: option.label === approve ? 'allow_once' : option === firstOther ? 'reject_once' : 'reject_always' })),
        _meta: { dsh: { interactionId: entry.eventId, planningReview: { markdown: review.detail ?? '', questionId: review.id,
          approveOptionId: options.find(option => option.label === approve)?.optionId ?? null } } },
      }, { cancellationSignal: question.abort.signal })
    } catch { return }
    if (question.abort.signal.aborted) return
    question.answered = true
    const outcome = response.outcome
    const answer = outcome.outcome === 'selected' && options.some(option => option.optionId === outcome.optionId)
      ? { kind: 'submit' as const, input: { answers: { [review.id]: { optionIds: [outcome.optionId] } } } } : { kind: 'cancel' as const }
    try { await this.native.questions.answerEvent(entry.eventId, answer) } catch { question.answered = false }
  }

  // ---------------------------------------------------------------- extensions

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      switch (method) {
        case DSH_METHODS.listSubscribe: this.listSubscribed = true; return {}
        case DSH_METHODS.listUnsubscribe: this.listSubscribed = false; return {}
        case DSH_METHODS.continue: return await this.continueTurn(String(params.sessionId), Number(params.turnEndSeq))
        case DSH_METHODS.steering: return await this.steer(params)
        case DSH_METHODS.planningGet: {
          if (typeof params.sessionId !== 'string') return { available: Boolean(this.native.planning.service()) }
          return await this.native.planning.read(params.sessionId as SessionId)
        }
        case DSH_METHODS.planningSet: {
          if (typeof params.sessionId !== 'string' || typeof params.active !== 'boolean') throw invalid('sessionId and active are required.')
          return { available: true, ...await this.native.planning.set(params.sessionId as SessionId, params.active) }
        }
        default: throw acp.RequestError.methodNotFound(method)
      }
    } catch (error) { throw toAcpError(error) }
  }

  async extNotification(): Promise<void> {}

  private async steer(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(params.sessionId)
    const meta = this.promptMeta(params._meta)
    const content = this.promptPlan(Array.isArray(params.prompt) ? params.prompt as acp.ContentBlock[] : [])
    if (this.native.status(id as SessionId) !== 'running') return { outcome: 'promptRequired' }
    try {
      await this.admit(id, meta, 'steer', content, this.conn.signal)
      return { outcome: 'injected' }
    } catch (error) {
      if (record(error).code === 'session/agent-busy') return { outcome: 'promptRequired' }
      throw error
    }
  }

  private async continueTurn(id: string, endSeq: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(endSeq) || endSeq < 0) throw invalid('turnEndSeq must be a non-negative integer.')
    if (!await this.native.visible(id)) throw notFound()
    const events = this.ctx.sessions.get(id as SessionId)?.snapshotEvents() ?? (await this.native.read(id as SessionId)).events
    const requestId = continuationRequestId(id, endSeq)
    if (admitted(events, requestId)) return { outcome: 'accepted' }
    const outcome = latestTurnOutcome(events)
    if (outcome?.kind !== 'failed' || outcome.endSeq !== endSeq || !await this.native.continuable(id as SessionId, endSeq)) return { outcome: 'unavailable' }
    const agent = await this.agentFor(id)
    try {
      await this.native.configuration.controller().prompt({ sessionId: id as SessionId,
        requestId: requestId as SessionPromptRequest['requestId'], mode: 'queue', content: [] }, this.conn.signal)
    } catch (error) {
      if (record(error).code === 'session/agent-busy') return { outcome: 'unavailable' }
      throw error
    }
    await this.ctx.sessions.flush(agent.session)
    return { outcome: 'accepted' }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Detach everything. Host sessions keep running (invariant I1). */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unwatch()
    for (const timer of this.listTimers.values()) clearTimeout(timer)
    for (const approval of this.approvals.values()) approval.abort.abort()
    for (const question of this.questions.values()) question.abort.abort()
    for (const list of this.pending.values()) for (const item of list) item.reject(new Error('Connector disconnected'))
    this.pending.clear()
    this.attached.clear()
  }
}
