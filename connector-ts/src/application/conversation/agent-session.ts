import { createHash } from 'node:crypto'

import { ownerGeneration, runtimeStateWire, type Session } from '../../domain/conversation/index.js'
import { UseCaseError } from '../errors.js'
import type { Capability, ConfigOption, JsonObject } from '../ports/index.js'
import type { RuntimeBindings, SessionBinding } from '../session/bindings.js'
import type { SessionKernel } from '../session/kernel.js'

/** Agent operation -> the session capability the Agent declares for it (runtime-workflows `AgentOperationRequest`). */
const OPERATIONS: Readonly<Record<string, string>> = {
  'authentication.status': 'session.authentication.read',
  'resources.get': 'session.resources.read',
  'resources.reload': 'session.resources.update',
  'queue.get': 'session.queue.read',
  'queue.clear': 'session.queue.update',
  'message.follow_up': 'session.follow_up',
  'session.rename': 'session.rename',
  'session.fork': 'session.fork',
  'directories.add': 'session.directories.update',
  'tools.set': 'session.tools.update',
}

/** Read-only operations the configuration panel offers as actions, with their titles. */
const ACTIONS: readonly (readonly [operation: string, title: string])[] = [
  ['authentication.status', '认证状态'],
  ['resources.get', '资源状态'],
  ['queue.get', '排队消息'],
]

export interface AgentConfigurationUpdate {
  readonly operationId: string
  readonly expectedRevision: number
  readonly values: Readonly<Record<string, string | boolean>>
}

export interface AgentOperation {
  readonly operation: string
  readonly operationId: string
  readonly expectedGeneration: string
  readonly values: JsonObject
}

/** A number that changes whenever the options or their values change (`AgentConfiguration.revision`). */
export function configurationRevision(options: readonly ConfigOption[]): number {
  const digest = createHash('sha256').update(JSON.stringify(options.map(optionWire))).digest()
  return digest.readUIntBE(0, 6)
}

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

/**
 * A Runtime's refusal (a port error under `error`, or a coded error) as the use case's own error, so the client gets
 * its code; anything else is rethrown as it is.
 */
async function runtimeCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof UseCaseError) throw error
    const port = (error as { error?: { code?: unknown; message?: unknown } } | null)?.error
    const coded = typeof port?.code === 'string' ? port : (error as { code?: unknown; message?: unknown } | null)
    if (typeof coded?.code === 'string') throw new UseCaseError(coded.code, typeof coded.message === 'string' ? coded.message : coded.code)
    throw error
  }
}

function supports(binding: SessionBinding, capabilityId: string): boolean {
  return binding.session.capabilities.items.some(item => item.id === capabilityId && item.supported && item.available !== false)
}

/**
 * The Agent session behind a session, beyond the conversation: its own options (the configuration panel), the
 * Agent's optional operations, its session tree, and releasing or reopening it.
 */
export class AgentSessionControls {
  public constructor(private readonly kernel: SessionKernel, private readonly bindings: RuntimeBindings) {}

  /**
   * `session.close` and `session.recover` of a session: it can be released while its Agent session is open, and
   * reopened at once after the Runtime lost it (otherwise the next operation reopens it anyway).
   */
  public async lifecycleCapabilities(sessionId: string): Promise<Capability[]> {
    const session = await this.kernel.deps.store.sessions.get(sessionId)
    if (session === null) return []
    const open = this.bindings.isBound(sessionId)
    const resumable = session.externalSessionId !== null
    return [
      { id: 'session.close', supported: true, available: open, ...(open ? {} : { unavailableReason: 'agent_session_not_open' }) },
      {
        id: 'session.recover',
        supported: resumable,
        available: resumable && this.bindings.wasLost(sessionId),
        ...(resumable && !this.bindings.wasLost(sessionId) ? { unavailableReason: 'agent_session_attached' } : {}),
      },
    ]
  }

  /** `GET configuration`: the options of the open Agent session and the read-only operations it offers. */
  public async configuration(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.kernel.requireSession(sessionId)
    const binding = await this.live(session)
    return this.view(session, binding)
  }

  /** `session.configuration.update`: applies Agent options while the client's revision is current. */
  public async configure(sessionId: string, update: AgentConfigurationUpdate): Promise<Record<string, unknown>> {
    return this.kernel.serial(sessionId, async () => {
      const session = await this.kernel.requireSession(sessionId)
      const binding = await runtimeCall(() => this.bindings.binding(sessionId))
      const options = binding.session.configOptions ?? []
      if (configurationRevision(options) !== update.expectedRevision) throw new UseCaseError('configuration_changed', '配置已变化，请刷新后重新确认。')
      const planning = binding.session.planningOptionId ?? null
      for (const [optionId, value] of Object.entries(update.values)) {
        if (optionId === planning) throw new UseCaseError('invalid_argument', '请使用会话计划命令切换规划模式。')
        const option = options.find(item => item.id === optionId)
        if (option === undefined) throw new UseCaseError('configuration_changed', '配置选项已不可用。')
        if (!acceptable(option, value)) throw new UseCaseError('invalid_configuration_value', '配置值不在当前可用范围。')
      }
      let changed: readonly ConfigOption[] | null = null
      for (const [optionId, value] of Object.entries(update.values)) changed = (await runtimeCall(() => binding.session.configure({ optionId, value }))).options
      if (changed !== null) this.kernel.emitSessionStatus(sessionId, { event: 'config.updated', options: changed as unknown as Record<string, unknown>[] })
      return { operationId: update.operationId, phase: 'completed', ...this.view(session, binding) }
    })
  }

  /** `session.agent.operate`: an operation the Agent declares a capability for, run by the Runtime. */
  public async operate(sessionId: string, request: AgentOperation): Promise<Record<string, unknown>> {
    const capabilityId = OPERATIONS[request.operation]
    if (capabilityId === undefined) throw new UseCaseError('unsupported_operation', 'Agent 操作未登记。')
    const session = await this.kernel.requireSession(sessionId)
    this.requireGeneration(session, request.expectedGeneration)
    const binding = await this.live(session)
    const result = await this.run(binding, capabilityId, request.operation, request.values)
    return { operationId: request.operationId, phase: 'completed', result }
  }

  /** `GET tree`: the Agent's own session tree (branches it can continue from). */
  public async tree(sessionId: string, values: JsonObject): Promise<JsonObject> {
    const session = await this.kernel.requireSession(sessionId)
    return this.run(await this.live(session), 'session.execution_position.read', 'session.tree', values)
  }

  /** `session.position.select`: the branch of the Agent's session tree the next turn continues from. */
  public async selectPosition(sessionId: string, operationId: string, values: JsonObject): Promise<Record<string, unknown>> {
    return this.kernel.serial(sessionId, async () => {
      await this.kernel.requireSession(sessionId)
      const binding = await runtimeCall(() => this.bindings.binding(sessionId))
      const result = await this.run(binding, 'session.execution_position.select', 'session.position.select', values)
      return { operationId, phase: 'completed', result }
    })
  }

  /** `session.close`: releases the Agent session between turns; the next operation opens it again. */
  public async close(sessionId: string, expectedGeneration: string): Promise<{ closed: boolean }> {
    return this.kernel.serial(sessionId, async () => {
      const session = await this.kernel.requireSession(sessionId)
      this.requireGeneration(session, expectedGeneration)
      if (session.activeTurn !== null) throw new UseCaseError('session_busy', '会话正在运行，请先中断或等待本轮结束。')
      await this.bindings.release(sessionId)
      return { closed: true }
    })
  }

  /** `session.recover`: opens the Agent session again now (resuming the native session) instead of on the next message. */
  public async recover(sessionId: string, operationId: string, expectedGeneration: string): Promise<Record<string, unknown>> {
    const session = await this.kernel.requireSession(sessionId)
    this.requireGeneration(session, expectedGeneration)
    await runtimeCall(() => this.bindings.binding(sessionId))
    const current = await this.kernel.requireSession(sessionId)
    return { operationId, phase: 'completed', state: runtimeStateWire(current, null) }
  }

  private requireGeneration(session: Session, expected: string): void {
    const current = ownerGeneration(session)
    if (current === null) throw new UseCaseError('agent_session_not_open', '会话还没有 Agent 会话。')
    if (current !== expected) throw new UseCaseError('owner_changed', '执行者已变化，请刷新后重试。')
  }

  /**
   * The open Agent session; a session the platform drives is opened (resumed) on first use, one it does not drive
   * is never opened by a read.
   */
  private async live(session: Session): Promise<SessionBinding> {
    const open = this.bindings.get(session.sessionId)
    if (open !== undefined) return open
    if (!session.takeover) throw new UseCaseError('agent_session_not_open', 'Agent 会话未打开，请先接管会话。')
    return runtimeCall(() => this.bindings.binding(session.sessionId))
  }

  private async run(binding: SessionBinding, capabilityId: string, operation: string, values: JsonObject): Promise<JsonObject> {
    if (binding.session.operate === undefined || !supports(binding, capabilityId)) throw new UseCaseError('agent_capability_unsupported', 'Agent 未提供此能力。')
    const operate = binding.session.operate.bind(binding.session)
    return runtimeCall(() => operate(operation, values))
  }

  private view(session: Session, binding: SessionBinding): Record<string, unknown> {
    const options = binding.session.configOptions ?? []
    const planning = binding.session.planningOptionId ?? null
    return {
      configuration: { revision: configurationRevision(options), options: options.filter(option => option.id !== planning).map(optionWire) },
      ownerGeneration: ownerGeneration(session),
      actions: ACTIONS.filter(([operation]) => binding.session.operate !== undefined && supports(binding, OPERATIONS[operation] as string)).map(([operation, title]) => ({ operation, title })),
    }
  }
}

function acceptable(option: ConfigOption, value: string | boolean): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && (option.values === undefined || option.values.some(choice => choice.value === value))
}
