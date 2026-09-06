import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { modelSelectionId } from '../projection/identity.js'
import { RUNTIME_ID } from '../wire/protocol.js'
import { BridgeError } from '../wire/errors.js'
import type { RuntimeStatus, SessionState } from './types.js'

export type ControllerStateListener = (controller: SessionController) => void | Promise<void>

export class SessionController {
  readonly selection: ModelSelectionRef
  readonly pendingInteractionIds = new Set<string>()
  handle: AgentHandle | undefined
  lastObservedRevision: SessionPersistenceRevision | undefined
  localAppendsSinceRevision = 0
  error: { code: string; message: string } | undefined
  private borrowedAgent: Agent | undefined
  private serialTail: Promise<void> = Promise.resolve()
  private stateRevision = 1
  private currentStatus: RuntimeStatus = 'idle'

  constructor(
    readonly externalSessionId: SessionId,
    public platformSessionId: string | undefined,
    initialSelection: ModelSelection,
    public permissionSelectionId: string,
    private readonly onState: ControllerStateListener,
  ) {
    this.selection = { current: initialSelection, assembled: undefined }
  }

  get status(): RuntimeStatus {
    return this.currentStatus
  }

  get agent(): Agent | undefined {
    return this.handle?.agent ?? this.borrowedAgent
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.serialTail.then(operation, operation)
    this.serialTail = run.then(() => undefined, () => undefined)
    return run
  }

  async drain(): Promise<void> {
    await this.serialTail
  }

  attach(handle: AgentHandle): void {
    if (this.agent !== undefined) throw new Error(`Session ${this.externalSessionId} already has a live Agent`)
    this.handle = handle
  }

  attachBorrowed(agent: Agent): void {
    if (this.agent === agent) return
    if (this.agent !== undefined) throw new Error(`Session ${this.externalSessionId} already has a different live Agent`)
    this.borrowedAgent = agent
  }

  requireLive(getAgent: (id: SessionId) => Agent | undefined): Agent {
    const agent = this.agent
    if (agent === undefined || getAgent(agent.id) !== agent) {
      throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'The retained DSH Agent is no longer live.', {
        retryable: true,
        externalSessionId: String(this.externalSessionId),
      })
    }
    return agent
  }

  async updateModel(selection: ModelSelection): Promise<void> {
    this.selection.current = selection
    await this.publishState()
  }

  async updatePermission(selectionId: string): Promise<void> {
    this.permissionSelectionId = selectionId
    await this.publishState()
  }

  async transition(status: RuntimeStatus, error?: { code: string; message: string }): Promise<void> {
    const changed = this.currentStatus !== status
      || this.error?.code !== error?.code
      || this.error?.message !== error?.message
    if (!changed) return
    this.currentStatus = status
    this.error = error
    await this.publishState()
  }

  async openInteraction(id: string): Promise<void> {
    this.pendingInteractionIds.add(id)
    await this.transition('waiting_approval')
  }

  async closeInteraction(id: string): Promise<void> {
    this.pendingInteractionIds.delete(id)
    if (this.pendingInteractionIds.size > 0) return
    await this.transition(this.agent?.status === 'running' ? 'running' : 'idle')
  }

  state(): SessionState | undefined {
    if (this.platformSessionId === undefined || this.selection.current === undefined) return undefined
    return {
      sessionId: this.platformSessionId,
      externalSessionId: String(this.externalSessionId),
      runtime: RUNTIME_ID,
      status: this.currentStatus,
      selections: {
        model: modelSelectionId(this.selection.current),
        permission: this.permissionSelectionId,
      },
      revision: this.stateRevision,
      ...(this.error === undefined ? {} : { error: this.error, statusReason: this.error.message }),
    }
  }

  async dispose(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    this.detachBorrowed()
    await handle?.dispose()
  }

  detachStale(): void {
    this.handle = undefined
    this.detachBorrowed()
  }

  private detachBorrowed(): void {
    this.borrowedAgent = undefined
  }

  private async publishState(): Promise<void> {
    this.stateRevision += 1
    await this.onState(this)
  }
}
