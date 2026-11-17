// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/sessions.py @98dd0e6e5 (prepare, _open_preparation, preparation_view, reserve, begin, creation_view, expire_preparations, restore)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/runtime.py @98dd0e6e5 (execute_workflow)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/interactions.py @98dd0e6e5 (InteractionService.respond, views)
//
// Workspace preparation use cases (runtime-workflows 1.2: `workspace.prepare`, `workspace.preparation.*` and the
// prepared side of `session.creation.*`). Preparing opens the Agent session in the background and the client polls
// for the real model catalog and options; on the first message the Server reserves the preparation and then begins
// the creation, which consumes the session already open. The creation is an ordinary session creation (delivery,
// queue, planning intent), so its first message outcome is the delivery's, and requests the Agent makes after it
// began are session notices. The state machine is domain/creation, the native session the Runtime adapter.

import {
  PreparationError,
  begin as beginCreation,
  cancel as cancelPreparation,
  cancelCreation,
  configurationChanged,
  creationWire,
  expire,
  fingerprint,
  interrupted,
  isTerminal,
  openFailed,
  openPreparation,
  opened,
  preparationWire,
  prepareDigest,
  requireSameInput,
  reserve as reservePreparation,
  type Configuration,
  type PlanningIntentRef,
  type Preparation,
  type Selections,
  type WorkflowFailure,
} from '../../domain/creation/index.js'
import { UseCaseError, type AttachmentRef, type CommandContext, type ConversationService } from '../conversation-service.js'
import type { Clock, ConfigOption, ConversationStore, IdSource, InteractionAnswer, NewSessionSpec, PreparedSession, PrepareOptions, RuntimeError, RuntimeHandles } from '../ports/index.js'
import { LivePreparation, type PreparationInteraction } from './live-preparation.js'

/** How many preparations may hold an Agent session at once. */
export const MAX_LIVE_PREPARATIONS = 8
/** How long settled preparations are kept (a client may still query their creation). */
const KEEP_SETTLED_MS = 7 * 24 * 60 * 60_000

export interface PreparationDeps {
  readonly store: ConversationStore
  readonly runtimes: RuntimeHandles
  readonly clock: Clock
  readonly ids: IdSource
  readonly conversation: ConversationService
  /** Whether a directory is an existing absolute path (`invalid_cwd`); from the workspace adapter. Unchecked when absent. */
  readonly directoryExists?: (cwd: string) => Promise<boolean>
  readonly onError?: (preparationId: string, error: unknown) => void
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new UseCaseError('invalid_argument', `${field} is required`)
  return value
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function selectionsOf(value: unknown): Selections {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new UseCaseError('invalid_argument', 'selections must be an object')
  const out: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry !== 'string') throw new UseCaseError('invalid_argument', `selection ${key} must be a string`)
    out[key] = entry
  }
  return out
}

function configurationOf(value: unknown): Configuration {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new UseCaseError('invalid_argument', 'configuration must be an object')
  const out: Record<string, string | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' && typeof entry !== 'boolean') throw new UseCaseError('invalid_argument', `configuration ${key} must be a string or a boolean`)
    out[key] = entry
  }
  return out
}

function planningIntentOf(value: unknown): PlanningIntentRef | null {
  if (value === undefined || value === null) return null
  const intent = value as Record<string, unknown>
  if (typeof value !== 'object' || (intent.mode !== undefined && intent.mode !== 'plan')) throw new UseCaseError('invalid_argument', 'planningIntent.mode must be plan')
  return { mode: 'plan', operationId: text(intent.operationId, 'planningIntent.operationId') }
}

/** A Runtime failure's code and message, and whether the Agent definitely never got the session request. */
function failureOf(error: unknown): { failure: WorkflowFailure; definite: boolean } {
  const reported = (error as { error?: RuntimeError } | null)?.error
  const code = reported?.code ?? (typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : null)
  const message = reported?.message ?? (error instanceof Error ? error.message : String(error))
  if (code === null) return { failure: { code: 'agent_open_failed', message: 'Agent 初始化未完成，请查询原操作。' }, definite: false }
  return { failure: { code, message }, definite: reported?.details?.definite === true }
}

/** An Agent option on the wire (ACP `SessionConfigOption` shape); the caller leaves out the plan mode switch. */
function optionWire(option: ConfigOption): Record<string, unknown> {
  return {
    id: option.id,
    name: option.name,
    ...(option.description !== undefined ? { description: option.description } : {}),
    category: option.category,
    type: option.type,
    currentValue: option.currentValue,
    ...(option.values !== undefined ? { options: option.values.map(value => ({ value: value.value, name: value.name, ...(value.description !== undefined ? { description: value.description } : {}) })) } : {}),
  }
}

/** A request made during the preparation, as the client's workflow panel shows it. */
function interactionWire(interaction: PreparationInteraction, generation: string, expiresAt: number): Record<string, unknown> {
  const event = interaction.event
  const approval = event.kind === 'approval'
  const actions = approval
    ? (event.options ?? []).map(option => ({ actionId: option.id, label: option.label, style: option.kind.startsWith('reject') ? 'danger' : 'primary' }))
    : [['accept', '提交', 'primary'], ['decline', '拒绝', 'secondary'], ['cancel', '取消', 'secondary']].map(([actionId, label, style]) => ({ actionId, label, style }))
  return {
    interactionId: event.interactionId,
    ownerGeneration: generation,
    requestRevision: interaction.revision,
    revision: interaction.revision,
    kind: approval ? 'approval' : 'form',
    status: interaction.status,
    title: event.title,
    ...(event.body !== undefined ? { message: event.body } : {}),
    actions,
    metadata: { formSchema: event.schema ?? null, toolCall: null },
    expiresAt: expiresAt / 1000,
  }
}

export class PreparationService {
  /** Preparations whose Agent session this process holds, by preparation id. */
  private readonly lives = new Map<string, LivePreparation>()
  /** Preparations of this process still opening or ready (expiry). */
  private readonly tracked = new Set<string>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly tasks = new Set<Promise<unknown>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopping = false

  public constructor(private readonly deps: PreparationDeps) {}

  /** One change at a time per preparation (the background open, a reservation, a cancel). */
  private serial<T>(preparationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(preparationId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.catch(() => undefined)
    this.chains.set(preparationId, tail)
    void tail.then(() => {
      if (this.chains.get(preparationId) === tail) this.chains.delete(preparationId)
    })
    return next
  }

  private async require(preparationId: string): Promise<Preparation> {
    const preparation = await this.deps.store.preparations.get(preparationId)
    if (preparation === null) throw new UseCaseError('preparation_not_found', '工作区准备不存在。')
    return preparation
  }

  private async save(preparation: Preparation): Promise<Preparation> {
    await this.deps.store.preparations.save(preparation)
    if (isTerminal(preparation)) this.tracked.delete(preparation.preparationId)
    return preparation
  }

  // ---------------------------------------------------------------- views

  /** `workspace.preparation.get`. */
  public async view(preparationId: string): Promise<Record<string, unknown>> {
    return this.wire(await this.require(preparationId))
  }

  private async wire(preparation: Preparation): Promise<Record<string, unknown>> {
    const live = this.lives.get(preparation.preparationId)
    const prepared = live?.prepared
    const catalogs = prepared !== undefined && live?.alive === true ? await prepared.catalogs().catch(() => null) : null
    const options = prepared === undefined ? [] : prepared.configOptions.filter(option => option.id !== prepared.planningOptionId).map(optionWire)
    return preparationWire(preparation, {
      catalog: { ...(catalogs?.models ?? { runtime: preparation.runtimeType, models: [] }), revision: preparation.catalogRevision },
      options,
      interactions: [...(live?.interactions.values() ?? [])].map(interaction => interactionWire(interaction, preparation.generation, preparation.expiresAt)),
      canRespond: live?.alive === true,
    })
  }

  /** `session.creation.get`: the first message outcome comes from the session's delivery record. */
  public async creationView(createOperationId: string): Promise<Record<string, unknown>> {
    const preparation = await this.deps.store.preparations.byCreation(createOperationId)
    if (preparation === null || preparation.creation === null || preparation.creation.createOperationId !== createOperationId) {
      throw new UseCaseError('creation_not_found', '创建操作不存在。')
    }
    const creation = preparation.creation
    const delivery = creation.clientMessageId === null ? null : await this.deps.store.deliveries.get(creation.sessionId, creation.clientMessageId)
    return creationWire(preparation, delivery, { agentSessionCreated: preparation.nativeSessionId !== null ? true : null })
  }

  // ---------------------------------------------------------------- use cases

  /** `workspace.prepare`: idempotent; another directory or client id under the same preparationId is a conflict. The Agent opens in the background. */
  public async prepare(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const preparationId = text(values.preparationId, 'preparationId')
    const runtimeId = text(values.runtimeId, 'runtimeId')
    const cwd = text(values.cwd, 'cwd')
    const clientPreparationId = optionalText(values.clientPreparationId)
    return this.serial(preparationId, async () => {
      const previous = await this.deps.store.preparations.get(preparationId)
      if (previous !== null) {
        requireSameInput(previous.inputDigest, prepareDigest({ cwd, clientPreparationId }))
        return this.wire(previous)
      }
      if (this.stopping) throw new UseCaseError('runtime_stopping', 'Connector 正在关闭。')
      if (this.deps.directoryExists !== undefined && !(await this.deps.directoryExists(cwd))) throw new UseCaseError('invalid_cwd', '请选择存在的绝对工作目录。')
      const handle = await this.deps.runtimes.handle(runtimeId)
      if (handle === null) throw new UseCaseError('runtime_unavailable', `runtime ${runtimeId} is not available on this device`)
      if (handle.prepare === undefined) throw new UseCaseError('workflow_unsupported', '该 Runtime 不支持工作区准备。')
      if (this.tracked.size >= MAX_LIVE_PREPARATIONS) throw new UseCaseError('worker_capacity', 'Agent 执行进程已达到上限。')
      const preparation = openPreparation({
        preparationId,
        runtimeId,
        runtimeType: handle.type,
        cwd,
        projectId: optionalText(values.projectId),
        clientPreparationId,
        generation: this.deps.ids.newId('gen_'),
      }, this.deps.clock.nowMs(), this.deps.clock.nowIso())
      await this.save(preparation)
      this.tracked.add(preparationId)
      this.background(this.open(preparation, handle.prepare.bind(handle)))
      return this.wire(preparation)
    })
  }

  private background(work: Promise<unknown>): void {
    const task = work.catch(() => undefined)
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task))
  }

  /** Opens the Agent session: failing before the launch is failed, after it outcome_unknown; a preparation cancelled or expired meanwhile closes the new session. */
  private async open(preparation: Preparation, prepare: (spec: NewSessionSpec, options: PrepareOptions) => Promise<PreparedSession>): Promise<void> {
    const id = preparation.preparationId
    let live: LivePreparation | null = null
    try {
      const prepared = await prepare({ cwd: preparation.cwd }, { preparationId: id })
      live = new LivePreparation(prepared, {
        configurationChanged: () => void this.serial(id, async () => {
          const current = await this.deps.store.preparations.get(id)
          if (current !== null && current.phase === 'ready') await this.save(configurationChanged(current, this.deps.clock.nowIso()))
        }).catch(error => this.deps.onError?.(id, error)),
        lost: () => {
          if (this.lives.get(id) === live) this.lives.delete(id)
        },
      })
      const settled = await this.serial(id, async () => {
        const current = await this.require(id)
        if (current.phase !== 'opening' || this.stopping) return false
        this.lives.set(id, live!)
        await this.save(opened(current, { nativeSessionId: prepared.nativeSessionId, hasOptions: prepared.configOptions.length > 0 }, this.deps.clock.nowIso()))
        return true
      })
      if (!settled) await live.close()
    } catch (error) {
      this.deps.onError?.(id, error)
      if (live !== null) await live.close()
      const { failure, definite } = failureOf(error)
      await this.serial(id, async () => {
        const current = await this.deps.store.preparations.get(id)
        if (current !== null) await this.save(openFailed(current, failure, definite, this.deps.clock.nowIso()))
      })
    }
  }

  /** `workspace.preparation.reserve`: `{reserved: true}`, or `{reserved: false, failure}` with the definite reason. */
  public async reserve(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const preparationId = text(values.preparationId, 'preparationId')
    const request = {
      createOperationId: text(values.createOperationId, 'createOperationId'),
      platformSessionId: text(values.platformSessionId, 'platformSessionId'),
      expectedRevision: typeof values.expectedRevision === 'number' ? values.expectedRevision : -1,
      catalogRevision: typeof values.catalogRevision === 'number' ? values.catalogRevision : -1,
      selections: selectionsOf(values.selections),
      configuration: configurationOf(values.configuration),
      planningIntent: planningIntentOf(values.planningIntent),
    }
    return this.serial(preparationId, async () => {
      try {
        const preparation = await this.deps.store.preparations.get(preparationId)
        if (preparation === null) throw new PreparationError('preparation_not_found', '工作区准备不存在。')
        const live = this.lives.get(preparationId)
        const prepared = live?.alive === true ? live.prepared : null
        let problem: WorkflowFailure | null = null
        if (prepared !== null) {
          if (prepared.planningOptionId !== null && prepared.planningOptionId in request.configuration) {
            problem = { code: 'planning_unavailable', message: '请使用会话规划意图设置规划模式。' }
          } else {
            const checked = prepared.check({ selections: request.selections, configuration: request.configuration })
            if (checked !== null) problem = { code: checked.code, message: checked.message }
          }
        }
        const result = reservePreparation(preparation, request, this.deps.clock.nowMs(), {
          agentAlive: prepared !== null,
          canPlan: prepared?.canPlan === true,
          configurationProblem: problem,
        }, this.deps.clock.nowIso())
        if (!result.replayed) await this.save(result.preparation)
        return { reserved: true }
      } catch (error) {
        if (!(error instanceof PreparationError)) throw error
        return { reserved: false, failure: { code: error.code, message: error.message } }
      }
    })
  }

  /**
   * `session.creation.begin` with a `preparationId`: consumes the reserved preparation, hands its native
   * session to the session engine, then creates the session and accepts the first message like a direct creation.
   * Answers the creation's view; a replay answers the same view.
   */
  public async begin(values: Record<string, unknown>, context: CommandContext): Promise<Record<string, unknown>> {
    const preparationId = text(values.preparationId, 'preparationId')
    const createOperationId = text(values.createOperationId, 'createOperationId')
    const sessionId = text(values.sessionId, 'sessionId')
    const clientMessageId = text(values.clientMessageId, 'clientMessageId')
    const selections = selectionsOf(values.selections)
    const configuration = configurationOf(values.configuration)
    const planningIntent = planningIntentOf(values.planningIntent)
    const content = typeof values.content === 'string' ? values.content : ''
    const attachments = Array.isArray(values.attachments) ? (values.attachments as AttachmentRef[]) : []
    const title = optionalText(values.title)
    const { runtime: _runtime, runtimeId: _runtimeId, runtimeType: _runtimeType, ...input } = values
    const inputDigest = fingerprint(input)
    return this.serial(preparationId, async () => {
      const preparation = await this.require(preparationId)
      const at = this.deps.clock.nowIso()
      const { preparation: consumed, replayed } = beginCreation(preparation, { createOperationId, sessionId, clientMessageId, selections, configuration, planningIntent, inputDigest }, at)
      if (replayed) return this.creationView(createOperationId)
      await this.save(consumed)
      this.tracked.delete(preparationId)
      const live = this.lives.get(preparationId)
      this.lives.delete(preparationId)
      if (live !== undefined) {
        this.deps.conversation.offerPrepared(sessionId, {
          adopt: id => live.adopt(id, { selections, configuration }),
          discard: () => live.close(),
        })
      }
      try {
        // The receipt carries this view (the command handler's result), not the delivery's ack.
        await this.deps.conversation.createSession({
          sessionId,
          runtimeId: consumed.runtimeId,
          runtimeType: consumed.runtimeType,
          cwd: consumed.cwd,
          projectId: consumed.projectId,
          title,
          selections: { ...selections },
          configuration: { ...configuration },
          clientMessageId,
          content,
          attachments,
          takeover: true,
          planningIntent: planningIntent === null ? null : { mode: 'plan', operationId: planningIntent.operationId },
          goalIntent: null,
        }, { ...context, receipt: null })
      } catch (error) {
        await this.deps.conversation.withdrawPrepared(sessionId)
        const failure = { code: (error as { code?: unknown })?.code === undefined ? 'creation_failed' : String((error as { code: unknown }).code), message: (error as Error)?.message ?? String(error) }
        const current = await this.require(preparationId)
        if (current.creation !== null && current.creation.settled === null) {
          await this.save({ ...current, updatedAt: this.deps.clock.nowIso(), creation: { ...current.creation, settled: { phase: 'rejected', messageAccepted: false, failure } } })
        }
        throw error
      }
      return this.creationView(createOperationId)
    })
  }

  /** `workspace.preparation.cancel`: closes the held Agent session. */
  public async cancel(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const preparationId = text(values.preparationId, 'preparationId')
    return this.serial(preparationId, async () => {
      const preparation = await this.save(cancelPreparation(await this.require(preparationId), this.deps.clock.nowIso()))
      this.tracked.delete(preparationId)
      const live = this.lives.get(preparationId)
      this.lives.delete(preparationId)
      await live?.close()
      return this.wire(preparation)
    })
  }

  /** `workspace.preparation.respond`: answers a request the Agent made during the preparation. */
  public async respond(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const preparationId = text(values.preparationId, 'preparationId')
    const interactionId = text(values.interactionId, 'interactionId')
    const responseOperationId = text(values.responseOperationId, 'responseOperationId')
    const actionId = text(values.actionId, 'actionId')
    const preparation = await this.require(preparationId)
    const live = this.lives.get(preparationId)
    const interaction = live?.interactions.get(interactionId)
    if (live === undefined || interaction === undefined) throw new UseCaseError('interaction_not_found', '该交互不属于这次准备。')
    if (values.ownerGeneration !== preparation.generation) throw new UseCaseError('owner_changed', '交互所属执行者已变化。')
    if (interaction.status !== 'open') {
      if (interaction.responseOperationId === responseOperationId) return { disposition: 'already_applied', responseOperationId }
      throw new UseCaseError('interaction_closed', '该交互已结束。')
    }
    if (values.requestRevision !== interaction.revision) throw new UseCaseError('interaction_changed', '交互已变化，请刷新。')
    const answer = answerOf(interaction, actionId, values.input)
    await live.respond(interactionId, answer)
    interaction.status = 'answered'
    interaction.revision += 1
    interaction.responseOperationId = responseOperationId
    return { disposition: 'applied', responseOperationId }
  }

  /** `session.creation.respond`: once a creation began, the Agent's requests are session notices; nothing is open in its scope. */
  public async respondCreation(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.creationView(text(values.createOperationId, 'createOperationId'))
    throw new UseCaseError('interaction_not_found', '创建操作没有待回答的请求；请在会话里回答。')
  }

  /**
   * `session.creation.cancel`: a first message without an outcome ends as outcome_unknown (the Agent may still
   * receive it), never as not sent. The cancel is recorded at once; the session stays and its turn is interrupted
   * once the session is open, without holding the answer until then.
   */
  public async cancelCreation(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const createOperationId = text(values.createOperationId, 'createOperationId')
    const view = await this.creationView(createOperationId)
    const preparation = (await this.deps.store.preparations.byCreation(createOperationId))!
    const creation = preparation.creation
    if (view.messageAccepted === null && creation !== null && creation.settled === null) {
      await this.serial(preparation.preparationId, async () => {
        const current = await this.require(preparation.preparationId)
        const fresh = await this.creationView(createOperationId)
        await this.save(cancelCreation(current, fresh.messageAccepted as boolean | null, this.deps.clock.nowIso()))
      })
      void this.deps.conversation.interrupt(creation.sessionId).catch(() => undefined)
    }
    return this.creationView(createOperationId)
  }

  // ---------------------------------------------------------------- lifecycle

  /** Expires preparations nobody reserved in time and closes their Agent sessions. */
  public async expireDue(): Promise<void> {
    for (const preparationId of [...this.tracked]) {
      await this.serial(preparationId, async () => {
        const current = await this.deps.store.preparations.get(preparationId)
        if (current === null) {
          this.tracked.delete(preparationId)
          return
        }
        const next = expire(current, this.deps.clock.nowMs(), this.deps.clock.nowIso())
        if (next === null) {
          if (isTerminal(current)) this.tracked.delete(preparationId)
          return
        }
        await this.save(next)
        const live = this.lives.get(preparationId)
        this.lives.delete(preparationId)
        await live?.close()
      }).catch(error => this.deps.onError?.(preparationId, error))
    }
  }

  public start(intervalMs = 1000): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.expireDue(), intervalMs)
    this.timer.unref?.()
  }

  /**
   * After a restart: the Agent sessions died with the previous process, so every preparation not
   * consumed, cancelled or expired expires, and a reserved one whose creation never started gets a definite
   * rejection. A creation that consumed its preparation but whose session never took the first message (the
   * process stopped in between) is rejected too. Old settled preparations are pruned.
   */
  public async recover(): Promise<void> {
    const at = this.deps.clock.nowIso()
    for (const preparation of await this.deps.store.preparations.unsettled()) {
      const creation = preparation.creation
      if (preparation.phase === 'consumed') {
        if (creation === null || creation.settled !== null || creation.clientMessageId === null) continue
        if ((await this.deps.store.deliveries.get(creation.sessionId, creation.clientMessageId)) !== null) continue
        await this.save({ ...preparation, updatedAt: at, creation: { ...creation, settled: { phase: 'rejected', messageAccepted: false, failure: { code: 'initialization_interrupted', message: '初始化执行者已退出，首条消息尚未提交。' } } } })
        continue
      }
      const next = interrupted(preparation, at)
      if (next !== null) await this.save(next)
    }
    await this.deps.store.preparations.prune(new Date(this.deps.clock.nowMs() - KEEP_SETTLED_MS).toISOString())
  }

  /** Stops expiring and closes every Agent session a preparation still holds (no orphan processes). */
  public async close(): Promise<void> {
    this.stopping = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    const lives = [...this.lives.values()]
    this.lives.clear()
    await Promise.all(lives.map(live => live.close()))
    await Promise.all([...this.tasks])
  }

  /** Preparations whose Agent session is held now (tests, diagnostics). */
  public get held(): number {
    return this.lives.size
  }
}

/** An approval picks an option (`dismiss` cancels); a form is accepted, declined or cancelled. */
function answerOf(interaction: PreparationInteraction, actionId: string, input: unknown): InteractionAnswer {
  if (interaction.event.kind === 'approval') {
    if (actionId === 'dismiss') return { kind: 'cancelled' }
    if (!(interaction.event.options ?? []).some(option => option.id === actionId)) throw new UseCaseError('invalid_permission_choice', '审批选项已变化。')
    return { kind: 'option', optionId: actionId }
  }
  if (actionId !== 'accept' && actionId !== 'decline' && actionId !== 'cancel') throw new UseCaseError('invalid_form_action', '表单操作无效。')
  if (actionId !== 'accept') return { kind: 'form', action: actionId }
  let values = input
  if (values !== null && typeof values === 'object' && (values as { kind?: unknown }).kind === 'form') values = (values as { values?: unknown }).values
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new UseCaseError('invalid_form_response', '表单回答不符合请求要求。')
  return { kind: 'form', action: 'accept', values: values as never }
}
