import type { Agent, AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { RuntimeStatus, SessionState } from '../wire/protocol.js'
import { RUNTIME_ID } from '../wire/protocol.js'
import { modelSelectionId } from '../projection/identity.js'
import { BridgeError } from '../wire/errors.js'

/** State change callback owned by the Session registry. */
export type ControllerStateListener = (controller: SessionController) => void | Promise<void>

/** Process-local owner of one DSH Session's serialization and live Agent handle. */
export class SessionController {
  readonly selection: ModelSelectionRef
  readonly pendingInteractionIds = new Set<string>()
  handle: AgentHandle | undefined
  private borrowedAgent: Agent | undefined
  lastObservedRevision: SessionPersistenceRevision | undefined
  localAppendsSinceRevision = 0
  error: { code: string; message: string } | undefined
  private serialTail: Promise<void> = Promise.resolve()
  private stateRevision = 0
  private currentStatus: RuntimeStatus = 'idle'

  /**
   * @param externalSessionId - Branded DSH Session identity.
   * @param platformSessionId - Bound AA Session identity when known.
   * @param initialSelection - Model route restored or selected for this Session.
   * @param permissionSelectionId - Effective permission selection ID.
   * @param onState - Notification callback after every semantic state change.
   */
  constructor(
    readonly externalSessionId: SessionId,
    public platformSessionId: string | undefined,
    initialSelection: ModelSelection,
    public permissionSelectionId: string,
    private readonly onState: ControllerStateListener,
  ) {
    this.selection = { current: initialSelection, assembled: undefined }
  }

  /** Current AA runtime status. */
  get status(): RuntimeStatus {
    return this.currentStatus
  }

  /** Run one Session operation after all earlier operations settle. */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.serialTail.then(operation, operation)
    this.serialTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Wait until every accepted serialized operation has settled. */
  async drain(): Promise<void> {
    await this.serialTail
  }

  /** Attach the exact Agent handle whose ownership lease is held by AgentRegistry. */
  attach(handle: AgentHandle): void {
    if (this.handle !== undefined || this.borrowedAgent !== undefined) {
      throw new Error(`Session ${this.externalSessionId} already has a live Agent`)
    }
    this.handle = handle
  }

  /** Observe an Agent owned by another Consumer in this same process. */
  attachBorrowed(agent: Agent): void {
    if (this.handle?.agent === agent || this.borrowedAgent === agent) return
    if (this.handle !== undefined || this.borrowedAgent !== undefined) {
      throw new Error(`Session ${this.externalSessionId} already has a different live Agent`)
    }
    this.borrowedAgent = agent
  }

  /** Exact live Agent currently controlled in this process. */
  get agent(): Agent | undefined {
    return this.handle?.agent ?? this.borrowedAgent
  }

  /** Return the exact retained live Agent or fail safely when it became stale. */
  requireLive(getAgent: (id: SessionId) => AgentHandle['agent'] | undefined): AgentHandle['agent'] {
    const agent = this.agent
    if (agent === undefined || getAgent(agent.id) !== agent) {
      throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'The retained DSH Agent is no longer live.', {
        retryable: true,
        externalSessionId: String(this.externalSessionId),
      })
    }
    return agent
  }

  /** Update model routing for the next step. */
  async updateModel(selection: ModelSelection): Promise<void> {
    this.selection.current = selection
    await this.publishState()
  }

  /** Update the permission selection after the canonical DSH setter succeeds. */
  async updatePermission(selectionId: string): Promise<void> {
    this.permissionSelectionId = selectionId
    await this.publishState()
  }

  /** Enter a new state and publish only when it changed. */
  async transition(status: RuntimeStatus, error?: { code: string; message: string }): Promise<void> {
    const changed = this.currentStatus !== status
      || this.error?.code !== error?.code
      || this.error?.message !== error?.message
    if (!changed) return
    this.currentStatus = status
    this.error = error
    await this.publishState()
  }

  /** Add one pending interaction and expose its blocking status. */
  async openInteraction(id: string, kind: 'approval' | 'user_question'): Promise<void> {
    this.pendingInteractionIds.add(id)
    await this.transition(kind === 'approval' ? 'waiting_approval' : 'blocked')
  }

  /** Close a pending interaction and return to the Agent's effective state. */
  async closeInteraction(id: string): Promise<void> {
    this.pendingInteractionIds.delete(id)
    if (this.pendingInteractionIds.size > 0) return
    await this.transition(this.agent?.status === 'running' ? 'running' : 'idle')
  }

  /** Materialize the public state DTO when the AA binding is known. */
  state(): SessionState | undefined {
    if (this.platformSessionId === undefined) return undefined
    return {
      sessionId: this.platformSessionId,
      externalSessionId: String(this.externalSessionId),
      runtime: RUNTIME_ID,
      status: this.currentStatus,
      selections: {
        model: modelSelectionId(this.selection.current as ModelSelection),
        permission: this.permissionSelectionId,
      },
      revision: this.stateRevision,
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  /** Dispose the owned handle; AgentRegistry releases its exact ownership lease. */
  async dispose(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    this.borrowedAgent = undefined
    await handle?.dispose()
  }

  /** Forget a handle after an external lifecycle owner removed the Agent. */
  async detachStale(): Promise<void> {
    this.handle = undefined
    this.borrowedAgent = undefined
  }

  private async publishState(): Promise<void> {
    this.stateRevision += 1
    await this.onState(this)
  }
}
