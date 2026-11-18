// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/prompts.py @98dd0e6e5 (acceptance rules)
// ported from effi-crew cloud/agentd/src/conv/conversation.ts @30f8334 (steer loop, first-answer-wins interactions)
//
// Generic ACP session engine: wraps one ACP session as the RuntimeSession port.
//
// Acceptance: the first assistant, thought, tool, plan or interaction event after the prompt, or a normal return of
// session/prompt, counts as accepted; a definite JSON-RPC error before that counts as rejected; a dropped connection
// or an exited process counts as outcome unknown (never resent). Steering, plan review, Goals and other differences
// all go through dialect hooks.

import { randomUUID } from 'node:crypto'

import type {
  Capability,
  CommandResult,
  ConfigChange,
  ConfigOption,
  ConfigResult,
  DeliveryRef,
  GoalPort,
  InteractionAnswer,
  InteractionRefusal,
  InteractionKind,
  InteractionOption,
  PlanningPort,
  PromptAcceptance,
  PromptAttachment,
  PromptInput,
  RuntimeError,
  RuntimeEvent,
  RuntimeSession,
  SessionCapabilities,
  SteerResult,
} from '../../application/ports/runtime-session.js'
import { parseGoalObservation } from './goal.js'
import { AcpProjectionIdentity, acpFingerprint, type JsonValue } from '../../domain/identity/index.js'
import { asRecord, describeAcpError, isMethodNotFound, type AcpClient, type AgentInfo, type JsonRecord } from './client.js'
import { choiceError, findOption, normalizeConfig, replaceConfig, withCurrent, type ConfigApply, type NormalizedConfig } from './config.js'
import type { AcpDialect, DialectSessionHooks, ItemIdentity, SessionContext } from './dialect.js'
import { ConnectionClosedError, JsonRpcError, RequestTimeoutError, type RequestContext } from './jsonrpc.js'
import { isAcceptanceEvidence, isContentUpdate, translateUpdate } from './mapping.js'
import { RuntimeFailure } from './errors.js'
import { EventQueue } from './queue.js'

/** Item identity under the generic ACP rules (AcpProjectionIdentity); user messages use a fingerprint of clientMessageId. */
export function defaultIdentity(context: SessionContext): ItemIdentity {
  const projection = new AcpProjectionIdentity(context.sessionId, context.epoch)
  const verified = Array.isArray(asRecord(context.info.meta.aa).guarantees)
    && (asRecord(context.info.meta.aa).guarantees as unknown[]).includes('stable_native_identity')
  return {
    itemFor: update => projection.apply((verified ? { ...update, aaProjectionVerified: true } : update) as Parameters<AcpProjectionIdentity['apply']>[0]),
    userItemId: clientMessageId => acpFingerprint([context.sessionId, 'user_message_chunk', clientMessageId]),
    finish: () => projection.finish(),
  }
}

export function runtimeError(error: unknown, fallbackCode = 'runtime_error'): RuntimeError {
  if (error instanceof RuntimeFailure) return error.error
  if (error instanceof RequestTimeoutError) return { code: 'runtime_timeout', message: error.message, retryable: true }
  if (error instanceof ConnectionClosedError) return { code: 'runtime_disconnected', message: error.message, retryable: true }
  if (error instanceof JsonRpcError) {
    if (error.code === -32000) return { code: 'runtime_auth_required', message: describeAcpError(error) }
    if (error.code === -32602) return { code: 'invalid_argument', message: describeAcpError(error) }
    if (error.code === -32601) return { code: 'runtime_unsupported', message: describeAcpError(error) }
    return { code: fallbackCode, message: describeAcpError(error) }
  }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) }
}

/** Outcome unknown: the request was sent but the peer gave no definite answer (timeout, disconnect, process exit). */
function isUnknownOutcome(error: unknown): boolean {
  return error instanceof RequestTimeoutError || error instanceof ConnectionClosedError
    || (error instanceof Error && /agent process exited|failed to start/.test(error.message))
}

const STOP_REASONS = new Set(['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'])

function stopReason(raw: unknown): Extract<RuntimeEvent, { type: 'turn.ended' }>['reason'] {
  return typeof raw === 'string' && STOP_REASONS.has(raw) ? raw as Extract<RuntimeEvent, { type: 'turn.ended' }>['reason'] : 'unknown'
}

interface ActiveTurn {
  readonly turnId: string
  readonly origin: 'user' | 'autonomous' | 'external'
  readonly clientMessageId?: string
  accepted: boolean
  resolveAcceptance?: ((acceptance: PromptAcceptance) => void) | undefined
  /** Without a prompt, an autonomous turn ends on a silence timer. */
  quietTimer?: ReturnType<typeof setTimeout> | undefined
}

interface PendingInteraction {
  readonly kind: InteractionKind
  readonly method: string
  readonly params: JsonRecord
  readonly options: JsonRecord[]
  readonly resolve: (result: unknown) => void
}

export interface AcpSessionOptions {
  readonly client: AcpClient
  readonly dialect: AcpDialect
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly info: AgentInfo
  readonly config: NormalizedConfig
  /** Whether session/close is available. */
  readonly canClose: boolean
  /** How long an autonomous turn can go without updates before it counts as ended (ms). */
  readonly autonomousQuietMs?: number
}

export class AcpRuntimeSession implements RuntimeSession {
  /** The AA session id; a prepared session starts with its preparation id and `rebind` gives it the real one. */
  sessionId: string
  readonly nativeSessionId: string
  readonly events = new EventQueue<RuntimeEvent>()
  readonly goal?: GoalPort
  readonly planning?: PlanningPort
  steer?: (input: PromptInput, delivery: DeliveryRef) => Promise<SteerResult>
  private readonly client: AcpClient
  private readonly dialect: AcpDialect
  private context: SessionContext
  private identity: ItemIdentity
  private config: NormalizedConfig
  private capabilityRevision = 1
  private turn: ActiveTurn | undefined
  private readonly idleWaiters: Array<() => void> = []
  /** toolCallId -> tool items already on the Timeline. Approvals link only to these (Hermes approval card ids are not tool calls). */
  private readonly toolItems = new Map<string, string>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private readonly detach: () => void
  private closed = false
  private readonly autonomousQuietMs: number
  private planModeBefore: string | undefined

  constructor(private readonly options: AcpSessionOptions) {
    this.client = options.client
    this.dialect = options.dialect
    this.sessionId = options.sessionId
    this.nativeSessionId = options.nativeSessionId
    this.config = { ...options.config, options: this.adapt(options.config.options) }
    this.autonomousQuietMs = options.autonomousQuietMs ?? 30_000
    this.context = { sessionId: options.sessionId, nativeSessionId: options.nativeSessionId, epoch: randomUUID(), info: options.info }
    this.identity = this.dialect.identity?.(this.context) ?? defaultIdentity(this.context)
    if (this.dialect.steer !== 'none') this.steer = (input, delivery) => this.steerTurn(input, delivery)
    const goalSnapshots = this.dialect.goalSnapshots?.(options.info)
    const goalMethod = goalSnapshots?.method ?? this.dialect.goalMethod?.(options.info)
    if (goalMethod) this.goal = this.goalPort(goalMethod, goalSnapshots)
    if (this.dialect.planMode) this.planning = this.planningPort()
    this.detach = this.client.attach(options.nativeSessionId, {
      onUpdate: update => this.onUpdate(update),
      onRequest: (method, params, context) => this.onRequest(method, params, context),
    })
  }

  get capabilities(): SessionCapabilities {
    const items: Capability[] = this.dialect.sessionCapabilities?.(this.options.info, this.config.options) ?? this.dialect.capabilities(this.options.info)
    // A session whose configuration has a model or permission option can switch it (the session's
    // `catalog.model` / `catalog.permission`); the Server checks these before `session.select`.
    // A dialect that turned one off with a reason (DSH's direct route) keeps it off.
    for (const category of ['model', 'permission'] as const) {
      if (!this.config.options.some(option => option.category === category)) continue
      const id = `catalog.${category}` as const
      const index = items.findIndex(item => item.id === id)
      const item = items[index]
      if (item === undefined) items.push({ id, supported: true })
      else if (item.supported !== true && item.unavailableReason === undefined) items[index] = { ...item, supported: true }
    }
    return { revision: this.capabilityRevision, items }
  }

  get configOptions(): readonly ConfigOption[] {
    return this.config.options
  }

  /** The option that carries plan mode, as the dialect declares it; null when there is none. */
  get planningOptionId(): string | null {
    return this.dialect.planMode?.(this.config.options)?.optionId ?? null
  }

  /**
   * A prepared session becomes its AA session: item ids are computed from the new session id from now on. Called
   * before the first message, when no item has reached the timeline yet.
   */
  rebind(sessionId: string): void {
    if (sessionId === this.sessionId) return
    if (this.turn !== undefined) throw new RuntimeFailure({ code: 'session_busy', message: 'a prepared session cannot change its identity during a turn' })
    this.sessionId = sessionId
    this.context = { ...this.context, sessionId, epoch: randomUUID() }
    this.identity = this.dialect.identity?.(this.context) ?? defaultIdentity(this.context)
  }

  get busy(): boolean {
    return this.turn !== undefined || this.interactions.size > 0
  }

  /** Pushes updates out as history replay (replay: 'full' on attach). */
  replay(updates: readonly JsonRecord[]): void {
    for (const update of updates) {
      for (const event of this.translate(update, true)) this.events.push(event)
    }
  }

  async prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance> {
    if (this.closed) return { outcome: 'rejected', error: { code: 'session_closed', message: 'session is closed' } }
    if (this.turn !== undefined) return { outcome: 'rejected', error: { code: 'session_busy', message: 'a turn is already running' } }
    // Handing over the write lock: reject explicitly (nothing runs); the caller resends after switching to the new route.
    if (this.releasing) return { outcome: 'rejected', error: { code: 'runtime_route_switching', message: 'the session is being handed over to another route', retryable: true } }
    // Build params before taking the turn: the dialect may throw synchronously while converting attachments (DSH cannot read an attachment file); then the Runtime received nothing, so reject explicitly and keep the session idle.
    let params: JsonRecord
    try {
      params = {
        sessionId: this.nativeSessionId,
        prompt: (this.dialect.promptBlocks?.(input) ?? promptBlocks(input)) as JsonRecord[],
        ...(this.dialect.promptParams?.(delivery) ?? {}),
      }
    } catch (error) {
      return { outcome: 'rejected', error: this.dialect.classifyError?.(error) ?? runtimeError(error, 'invalid_argument') }
    }
    const turnId = `turn_${randomUUID()}`
    let resolveAcceptance!: (acceptance: PromptAcceptance) => void
    const acceptance = new Promise<PromptAcceptance>(resolve => (resolveAcceptance = resolve))
    const turn: ActiveTurn = { turnId, origin: 'user', clientMessageId: delivery.clientMessageId, accepted: false, resolveAcceptance }
    this.turn = turn
    const userItemId = this.identity.userItemId(delivery.clientMessageId)
    this.events.push({ type: 'turn.started', turnId, origin: 'user', clientMessageId: delivery.clientMessageId })
    this.events.push({
      type: 'message.completed', turnId, itemId: userItemId, role: 'user', text: input.text, clientMessageId: delivery.clientMessageId,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    })
    this.client.request('session/prompt', params).then(
      result => {
        this.accept(turn, userItemId)
        this.endTurn(turn, stopReason(asRecord(result).stopReason))
      },
      error => {
        if (!turn.accepted) {
          const outcome = isUnknownOutcome(error) ? 'unknown' : 'rejected'
          turn.resolveAcceptance?.({ outcome, error: this.classify(error) })
          turn.resolveAcceptance = undefined
          this.endTurn(turn, 'failed', this.classify(error))
          return
        }
        this.endTurn(turn, 'failed', this.classify(error))
      },
    )
    return acceptance.then(result => (result.outcome === 'accepted' ? { ...result, userItemId } : result))
  }

  private async steerTurn(input: PromptInput, delivery: DeliveryRef): Promise<SteerResult> {
    const turn = this.turn
    if (turn === undefined) return { outcome: 'prompt_required' }
    const userItemId = this.identity.userItemId(delivery.clientMessageId)
    if (this.dialect.steer === 'text-command') {
      // Hermes: the `/steer <text>` text command while running.
      if (input.attachments?.length && this.dialect.steerAttachments !== true) {
        return { outcome: 'rejected', error: { code: 'invalid_argument', message: '运行中插话不支持附件，请等本轮结束后再发送。' } }
      }
      const command = this.dialect.steerCommand ?? '/steer'
      try {
        await this.client.request('session/prompt', { sessionId: this.nativeSessionId, prompt: [{ type: 'text', text: `${command} ${input.text}` }] }, { timeoutMs: 30_000 })
      } catch (error) {
        return isUnknownOutcome(error) ? { outcome: 'unknown', error: this.classify(error) } : { outcome: 'rejected', error: this.classify(error) }
      }
      this.events.push({ type: 'message.completed', turnId: turn.turnId, itemId: userItemId, role: 'user', text: input.text, clientMessageId: delivery.clientMessageId })
      return { outcome: 'injected', turnId: turn.turnId, userItemId }
    }
    let result: JsonRecord
    try {
      result = asRecord(await this.client.request('_session/steering', {
        sessionId: this.nativeSessionId,
        prompt: (this.dialect.promptBlocks?.(input) ?? promptBlocks(input)) as JsonRecord[],
        _meta: { steering: { idleBehavior: 'promptRequired' }, ...asRecord(this.dialect.promptParams?.(delivery)?._meta) },
      }, { timeoutMs: 60_000 }))
    } catch (error) {
      if (isMethodNotFound(error)) return { outcome: 'rejected', error: { code: 'runtime_unsupported', message: 'agent does not support steering' } }
      return isUnknownOutcome(error) ? { outcome: 'unknown', error: this.classify(error) } : { outcome: 'rejected', error: this.classify(error) }
    }
    switch (result.outcome) {
      case 'injected':
        this.events.push({ type: 'message.completed', turnId: turn.turnId, itemId: userItemId, role: 'user', text: input.text, clientMessageId: delivery.clientMessageId })
        return { outcome: 'injected', turnId: turn.turnId, userItemId }
      case 'startedNewTurn':
        return { outcome: 'started_new_turn', userItemId }
      case 'promptRequired':
        return { outcome: 'prompt_required' }
      default:
        return { outcome: 'rejected', error: { code: 'steer_failed', message: `steering returned ${String(result.outcome)}` } }
    }
  }

  async cancel(expectedTurnId?: string): Promise<void> {
    const turn = this.turn
    if (turn === undefined) return
    if (expectedTurnId !== undefined && turn.turnId !== expectedTurnId) return
    // ACP: on cancel the client must answer every pending permission request with cancelled.
    for (const [id, pending] of this.interactions) {
      if (pending.method === 'session/request_permission') {
        pending.resolve({ outcome: { outcome: 'cancelled' } })
        this.interactions.delete(id)
        this.events.push({ type: 'interaction.resolved', turnId: turn.turnId, interactionId: id, resolution: 'expired' })
      }
    }
    try {
      this.client.notify('session/cancel', { sessionId: this.nativeSessionId })
    } catch {
      // connection dropped: the turn ends with session.lost
    }
  }

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void | InteractionRefusal> {
    const pending = this.interactions.get(interactionId)
    if (!pending) {
      const card = this.dialect.respondCard?.(interactionId, answer, {
        nativeSessionId: this.nativeSessionId,
        request: (method, params) => this.client.request(method, params, { timeoutMs: 60_000 }),
        emit: event => this.events.push(event),
      })
      if (card) return card
      throw new JsonRpcError(-32602, `no pending interaction ${interactionId}`)
    }
    const turnId = this.turn?.turnId
    // Compute and validate the answer first (invalid option, dialect error); only when everything passes is the pending interaction removed: on a validation failure the interaction stays, the Agent keeps waiting and the user can answer again.
    let result: unknown
    let after: (() => void) | undefined
    let registerFollowUp: (() => void) | undefined
    if (pending.method === 'session/request_permission') {
      if (answer.kind === 'option') {
        if (!pending.options.some(o => o.optionId === answer.optionId)) throw new JsonRpcError(-32602, `option ${answer.optionId} was not offered`)
        result = { outcome: { outcome: 'selected', optionId: answer.optionId } }
      } else if (answer.kind === 'plan_review') {
        const decision = this.dialect.planReview?.(answer, pending.options, { ...(this.planModeBefore !== undefined ? { modeBeforePlan: this.planModeBefore } : {}) }) ?? genericPlanReview(answer, pending.options)
        result = decision.optionId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: decision.optionId } }
        const then = decision.then
        if (then?.action === 'steer') {
          after = () => void this.steer?.({ text: then.text }, { deliveryId: `plan-feedback-${interactionId}`, clientMessageId: `plan-feedback-${interactionId}` })
        } else if (then?.action === 'prompt') {
          // Registered right after answering: sent as soon as the current turn ends (rejecting the plan ends it).
          registerFollowUp = () => void this.whenIdle().then(() => this.prompt({ text: then.text }, { deliveryId: `plan-feedback-${interactionId}`, clientMessageId: `plan-feedback-${interactionId}` }))
        } else if (then?.action === 'cancel') {
          after = () => void this.cancel(turnId)
        }
      } else {
        result = { outcome: { outcome: 'cancelled' } }
      }
    } else {
      result = answer.kind === 'form' ? { action: answer.action, ...(answer.values ? { content: answer.values } : {}) } : { action: 'cancel' }
    }
    this.interactions.delete(interactionId)
    pending.resolve(result)
    registerFollowUp?.()
    this.events.push({ type: 'interaction.resolved', ...(turnId ? { turnId } : {}), interactionId, resolution: 'answered', answeredBy: 'self' })
    if (after) setTimeout(after, 50)
  }

  async configure(change: ConfigChange): Promise<ConfigResult> {
    const option = findOption(this.config.options, change.optionId)
    const problem = choiceError(this.config.options, change.optionId, change.value)
    if (problem !== undefined || option === undefined) throw new JsonRpcError(-32602, problem ?? `unknown setting ${change.optionId}`)
    const apply = this.config.apply[option.id] ?? 'option'
    const appliesFrom = this.turn === undefined ? 'now' : 'next_turn'
    let response: unknown
    switch (apply) {
      case 'boolean':
        response = await this.client.request('session/set_config_option', { sessionId: this.nativeSessionId, configId: option.id, type: 'boolean', value: change.value === true || change.value === 'true' })
        break
      case 'set_mode':
        response = await this.client.request('session/set_mode', { sessionId: this.nativeSessionId, modeId: String(change.value) })
        break
      case 'set_model':
        response = await this.client.request('session/set_model', { sessionId: this.nativeSessionId, modelId: String(change.value) })
        break
      default:
        response = await this.client.request('session/set_config_option', { sessionId: this.nativeSessionId, configId: option.id, value: String(change.value) })
    }
    const returned = asRecord(response).configOptions
    if (Array.isArray(returned)) {
      const normalized = normalizeConfig({ configOptions: returned })
      const next = replaceConfig(this.config, normalized)
      this.setConfig({ ...next, options: this.adapt(next.options) })
    } else {
      this.setConfig({ ...this.config, options: withCurrent(this.config.options, option.id, option.type === 'boolean' ? change.value === true || change.value === 'true' : change.value) })
    }
    this.emitConfig()
    return { options: this.config.options, appliesFrom }
  }

  async command(name: string, args?: string): Promise<CommandResult> {
    const text = `/${name}${args ? ` ${args}` : ''}`
    const id = `command-${randomUUID()}`
    const acceptance = await this.prompt({ text }, { deliveryId: id, clientMessageId: id })
    return acceptance.outcome === 'accepted' ? { ok: true } : { ok: false, error: acceptance.error }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const pending of this.interactions.values()) pending.resolve(pending.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' })
    this.interactions.clear()
    if (this.options.canClose && !this.client.peer.isClosed) {
      await this.client.request('session/close', { sessionId: this.nativeSessionId }, { timeoutMs: 15_000 }).catch(() => undefined)
    }
    this.detach()
    this.events.close()
  }

  /**
   * Releases the session between turns (04 §5.6 "route switches hand over the write lock"): `session/close` at once
   * when there is no turn, otherwise after the turn ends. No new prompts are accepted while waiting, so a new turn
   * cannot start after this one and keep holding the write lock. When this returns the session is closed.
   */
  async releaseBetweenTurns(): Promise<void> {
    if (this.closed) return
    this.releasing = true
    await this.whenIdle()
    await this.close()
  }

  private releasing = false

  /** The connection dropped (process exited): ends the current turn and signals that the session must be reopened. */
  lost(reason: string): void {
    if (this.closed) return
    const error: RuntimeError = { code: 'runtime_disconnected', message: reason, retryable: true }
    if (this.turn) {
      if (!this.turn.accepted) this.turn.resolveAcceptance?.({ outcome: 'unknown', error })
      // An accepted turn dropped midway: outcome unknown (part of it may have run); the caller synthesizes a failure card, with no automatic resend.
      this.endTurn(this.turn, 'failed', this.turn.accepted ? { ...error, retryable: false, details: { outcome: 'unknown' } } : error)
    }
    for (const [id, pending] of this.interactions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      this.events.push({ type: 'interaction.resolved', interactionId: id, resolution: 'expired' })
    }
    this.interactions.clear()
    this.events.push({ type: 'session.lost', error })
    this.closed = true
    this.detach()
    this.events.close()
  }

  // ------------------------------------------------------------------------------------------

  private adapt(options: ConfigOption[]): ConfigOption[] {
    return this.dialect.adaptConfig?.(options) ?? options
  }

  private emitConfig(): void {
    this.events.push({ type: 'config.updated', options: this.config.options })
    const plan = this.dialect.planMode?.(this.config.options)
    if (plan) {
      const current = findOption(this.config.options, plan.optionId)?.currentValue
      this.events.push({ type: 'planning.mode_changed', mode: current === plan.planValue ? 'plan' : 'normal' })
    }
  }

  private classify(error: unknown): RuntimeError {
    return this.dialect.classifyError?.(error) ?? runtimeError(error)
  }

  private accept(turn: ActiveTurn, userItemId?: string): void {
    if (turn.accepted) return
    turn.accepted = true
    turn.resolveAcceptance?.({ outcome: 'accepted', turnId: turn.turnId, ...(userItemId ? { userItemId } : {}) })
    turn.resolveAcceptance = undefined
  }

  private endTurn(turn: ActiveTurn, reason: Extract<RuntimeEvent, { type: 'turn.ended' }>['reason'], error?: RuntimeError): void {
    if (this.turn !== turn) return
    if (turn.quietTimer) clearTimeout(turn.quietTimer)
    this.turn = undefined
    this.identity.finish?.()
    for (const [id, pending] of this.interactions) {
      pending.resolve(pending.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' })
      this.events.push({ type: 'interaction.resolved', turnId: turn.turnId, interactionId: id, resolution: 'expired' })
    }
    this.interactions.clear()
    this.events.push({ type: 'turn.ended', turnId: turn.turnId, reason, ...(error ? { error } : {}) })
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  /** Returns at once when there is no turn, otherwise waits for it to end. */
  private whenIdle(): Promise<void> {
    if (this.turn === undefined) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  private translate(update: JsonRecord, replay = false): RuntimeEvent[] {
    const turnId = this.turn?.turnId
    const state = { ...(turnId !== undefined ? { turnId } : {}), ...(this.turn ? { origin: this.turn.origin } : {}), ...(replay ? { replay: true } : {}) }
    return this.dialect.translateUpdate?.(update, this.context, state) ?? translateUpdate(update, {
      identity: this.identity,
      ...(turnId !== undefined ? { turnId } : {}),
      replay,
      suppressUserEcho: !replay && this.turn?.origin === 'user' && this.dialect.echoesUserPrompt !== false,
      config: this.config.options,
      modesOptionId: Object.entries(this.config.apply).find(([, apply]) => apply === 'set_mode')?.[0] ?? 'mode',
    })
  }

  private replaying = false

  private hooks(): DialectSessionHooks {
    return {
      emit: event => this.events.push(event),
      beginReplay: () => {
        this.replaying = true
        this.identity.reset?.()
      },
      endReplay: () => { this.replaying = false },
    }
  }

  /** Session-level notifications the dialect declares (routed here by the handle by sessionId). */
  dialectNotification(method: string, params: JsonRecord): void {
    if (!this.closed) this.dialect.onNotification?.(method, params, this.hooks())
  }

  private onUpdate(update: JsonRecord): void {
    if (this.closed) return
    if (this.replaying) {
      for (const event of this.translate(update, true)) this.events.push(event)
      return
    }
    // Content outside a turn: the Agent started a turn on its own (scheduled wakeup, background task finished, external writer).
    if (this.turn === undefined && isContentUpdate(update)) {
      const turnId = `turn_${randomUUID()}`
      this.turn = { turnId, origin: 'autonomous', accepted: true }
      this.events.push({ type: 'turn.started', turnId, origin: 'autonomous' })
    }
    const turn = this.turn
    if (turn && !turn.accepted && (isAcceptanceEvidence(update) || this.dialect.acceptanceEvidence?.(update) === true)) this.accept(turn)
    const events = this.translate(update)
    for (const event of events) {
      if ((event.type === 'tool.started' || event.type === 'tool.updated') && typeof update.toolCallId === 'string') this.toolItems.set(update.toolCallId, event.itemId)
      if (event.type === 'config.updated') {
        const apply: Record<string, ConfigApply> = {}
        for (const option of event.options) apply[option.id] = this.config.apply[option.id] ?? (option.type === 'boolean' ? 'boolean' : 'option')
        const next = replaceConfig(this.config, { options: [...event.options], apply, native: this.config.native })
        this.setConfig({ ...next, options: this.adapt(next.options) })
        this.emitConfig()
        continue
      }
      this.events.push(event)
    }
    if (turn && turn.origin !== 'user') {
      if (turn.quietTimer) clearTimeout(turn.quietTimer)
      if (this.dialect.endsAutonomousTurn?.(update) === true) {
        this.endTurn(turn, 'end_turn')
        return
      }
      turn.quietTimer = setTimeout(() => this.endTurn(turn, 'end_turn'), this.autonomousQuietMs)
      turn.quietTimer.unref?.()
    }
  }

  private async onRequest(method: string, params: JsonRecord, context: RequestContext): Promise<unknown> {
    const handled = this.dialect.handleRequest?.(method, params, this.hooks())
    if (handled !== undefined) return handled
    if (method !== 'session/request_permission' && method !== 'elicitation/create') throw JsonRpcError.methodNotFound(method)
    if (this.turn && !this.turn.accepted) this.accept(this.turn)
    this.dialect.observeRequest?.(method, params, this.context)
    const kind = this.dialect.interactionKind?.(method, params) ?? (method === 'elicitation/create' ? 'form' : 'approval')
    const interactionId = `interaction_${randomUUID()}`
    const options = Array.isArray(params.options) ? params.options.map(asRecord) : []
    return new Promise(resolve => {
      this.interactions.set(interactionId, { kind, method, params, options, resolve })
      context.signal.addEventListener('abort', () => {
        if (!this.interactions.delete(interactionId)) return
        this.events.push({ type: 'interaction.resolved', ...(this.turn ? { turnId: this.turn.turnId } : {}), interactionId, resolution: 'withdrawn' })
        resolve(method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' })
      }, { once: true })
      this.events.push(this.interactionEvent(interactionId, kind, method, params, options))
    })
  }

  private interactionEvent(interactionId: string, kind: InteractionKind, method: string, params: JsonRecord, options: JsonRecord[]): RuntimeEvent {
    const turnId = this.turn?.turnId
    const toolCall = asRecord(params.toolCall)
    const toolItem = typeof toolCall.toolCallId === 'string' ? this.toolItems.get(toolCall.toolCallId) : undefined
    const mapped: InteractionOption[] = options.map(o => ({
      id: String(o.optionId),
      label: String(o.name ?? o.optionId),
      kind: o.kind === 'allow_once' || o.kind === 'allow_always' || o.kind === 'reject_once' || o.kind === 'reject_always' ? o.kind : 'other',
    }))
    const plan = typeof asRecord(toolCall.rawInput).plan === 'string' ? String(asRecord(toolCall.rawInput).plan) : undefined
    return {
      type: 'interaction.opened',
      ...(turnId ? { turnId } : {}),
      interactionId,
      kind,
      title: method === 'elicitation/create' ? String(params.message ?? 'Input requested') : String(toolCall.title ?? 'Permission requested'),
      ...(toolItem ? { itemId: toolItem } : {}),
      ...(mapped.length ? { options: mapped } : {}),
      ...(method === 'elicitation/create' && params.requestedSchema !== undefined ? { schema: asRecord(params.requestedSchema) } : {}),
      ...(kind === 'plan_review' && plan !== undefined ? {
        plan: { planId: `plan:${interactionId}`, markdown: plan, title: 'Plan', revision: 1, contentHash: `sha256:${sha256(plan)}`, contentState: 'ready', createdAt: null, sourceTurnId: turnId ?? null },
      } : {}),
    }
  }

  private goalPort(method: string, snapshots: ReturnType<NonNullable<AcpDialect['goalSnapshots']>>): GoalPort {
    const request = async (action: string, extra: JsonRecord = {}) =>
      asRecord(await this.client.request(method, { sessionId: this.nativeSessionId, action, ...extra }, { timeoutMs: 30_000 }))
    const legacyRead = async () => {
      const result = await request('get')
      const state = result.goal ?? result.state
      const goal = asRecord(state).goal
      return parseGoalObservation(goal ?? null)
    }
    const observed = async (action: string, extra: JsonRecord = {}) => {
      const result = await request(action, extra)
      return snapshots === undefined ? legacyRead() : parseGoalObservation(result.goal, snapshots.actions, true)
    }
    return {
      get: () => snapshots === undefined ? legacyRead() : observed('get'),
      set: (objective, options) => observed('set', { objective, ...(options?.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}) }),
      pause: () => observed('pause'),
      resume: () => observed('resume'),
      clear: () => observed('clear'),
    }
  }

  /** Replaces the config; when plan mode is entered from another value, records the original (restored after the plan is approved). */
  private setConfig(next: NormalizedConfig): void {
    const spec = this.dialect.planMode?.(next.options)
    if (spec) {
      const before = findOption(this.config.options, spec.optionId)?.currentValue
      const after = findOption(next.options, spec.optionId)?.currentValue
      if (after === spec.planValue && before !== spec.planValue && typeof before === 'string') this.planModeBefore = before
    }
    this.config = next
  }

  private planningPort(): PlanningPort {
    return {
      setMode: async mode => {
        const spec = this.dialect.planMode?.(this.config.options)
        if (!spec) throw new JsonRpcError(-32601, 'planning is not supported')
        const current = findOption(this.config.options, spec.optionId)?.currentValue
        if (mode === 'plan') {
          if (current !== spec.planValue && typeof current === 'string') this.planModeBefore = current
          await this.configure({ optionId: spec.optionId, value: spec.planValue })
        } else {
          const back = spec.normalValue ?? this.planModeBefore
          if (back === undefined) throw new JsonRpcError(-32602, 'no mode to return to')
          await this.configure({ optionId: spec.optionId, value: back })
        }
      },
      current: async () => {
        const spec = this.dialect.planMode?.(this.config.options)
        if (!spec) return { mode: 'unknown' }
        return { mode: findOption(this.config.options, spec.optionId)?.currentValue === spec.planValue ? 'plan' : 'normal' }
      },
    }
  }
}

function sha256(text: string): string {
  // Only for the content hash of plan documents (checked during review to confirm they were not edited); the domain/identity hash accepts strict UTF-8 only, so a lenient version is used here.
  return acpFingerprint(text as JsonValue)
}

/** Generic plan review: approve picks the first allow option, anything else answers reject; revising steers the feedback in, and not proceeding interrupts the turn. */
export function genericPlanReview(answer: Extract<InteractionAnswer, { kind: 'plan_review' }>, options: readonly JsonRecord[]): { optionId?: string; then?: { action: 'steer'; text: string } | { action: 'cancel' } } {
  const allow = options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind === 'allow_always')
  const reject = options.find(o => o.kind === 'reject_once') ?? options.find(o => o.kind === 'reject_always')
  if (answer.action === 'approve') return allow ? { optionId: String(allow.optionId) } : {}
  if (answer.action === 'revise') {
    return { ...(reject ? { optionId: String(reject.optionId) } : {}), ...(answer.feedback ? { then: { action: 'steer', text: answer.feedback } } : {}) }
  }
  return { ...(reject ? { optionId: String(reject.optionId) } : {}), then: { action: 'cancel' } }
}

/** Generic input conversion: text, inline images, and files as resource_link (file:// URIs). */
export function promptBlocks(input: PromptInput): JsonRecord[] {
  const blocks: JsonRecord[] = []
  if (input.text !== '') blocks.push({ type: 'text', text: input.text })
  for (const attachment of input.attachments ?? []) blocks.push(attachmentBlock(attachment))
  return blocks
}

function attachmentBlock(attachment: PromptAttachment): JsonRecord {
  switch (attachment.kind) {
    case 'inline':
      if (attachment.mimeType.startsWith('image/')) return { type: 'image', mimeType: attachment.mimeType, data: attachment.data }
      if (attachment.mimeType.startsWith('audio/')) return { type: 'audio', mimeType: attachment.mimeType, data: attachment.data }
      return { type: 'resource', resource: { uri: `attachment:${attachment.name ?? 'file'}`, mimeType: attachment.mimeType, blob: attachment.data } }
    case 'file':
      return { type: 'resource_link', uri: fileUri(attachment.path), name: attachment.name ?? attachment.path.split(/[\\/]/).pop() ?? 'file', mimeType: attachment.mimeType }
    case 'link':
      return { type: 'resource_link', uri: attachment.uri, name: attachment.name ?? attachment.uri, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) }
  }
}

function fileUri(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized.split('/').map(encodeURIComponent).join('/')}`
}
