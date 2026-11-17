import type { GoalRequest, GoalState } from '../domain/goals/index.js'
import { InteractionService } from './conversation/interactions.js'
import { MessageService, type CreateSessionCommand, type SendMessageCommand, type SendResult } from './conversation/messages.js'
import { Recovery } from './conversation/recovery.js'
import { SessionControls } from './conversation/controls.js'
import { GoalService } from './goals/goal-service.js'
import { PlanningService, type PlanningRequest } from './planning/planning-service.js'
import type { CommandReceipt, ConversationStore, RuntimeEvent, RuntimeSession, SessionCommit } from './ports/index.js'
import type { LiveFact } from './session/bindings.js'
import { QueueService, type ClientQueueOp } from './queue/queue-service.js'
import { RuntimeBindings, type PreparedHandOver, type SessionBinding, type SessionEventSink } from './session/bindings.js'
import { DeliveryRecords } from './session/deliveries.js'
import { SessionKernel, type ConversationDeps, type SessionChange } from './session/kernel.js'
import type { CommandContext } from './session/receipts.js'
import { TurnLifecycle } from './session/turns.js'

export { UseCaseError } from './errors.js'
export type { CreateSessionCommand, SendMessageCommand, SendResult } from './conversation/messages.js'
export type { CreationIntent, PreparedHandOver, SessionBinding } from './session/bindings.js'
export { platformUserItemId } from './session/deliveries.js'
export type { AttachmentRef, ConversationDeps } from './session/kernel.js'
export type { CommandContext } from './session/receipts.js'

/**
 * The session contexts of this device behind one entry point: every state-changing use case (06-protocols.md §2.4
 * `Commands/*`) and the reaction to Runtime events. It wires the use cases of each context (messages, controls and
 * interactions; queue; planning; goals) onto the shared session engine and forwards to them.
 */
export class ConversationService implements SessionEventSink {
  private readonly kernel: SessionKernel
  private readonly bindings: RuntimeBindings
  private readonly deliveries: DeliveryRecords
  private readonly turns: TurnLifecycle
  private readonly queue: QueueService
  private readonly plans: PlanningService
  private readonly goals: GoalService
  private readonly messages: MessageService
  private readonly controls: SessionControls
  private readonly interactions: InteractionService
  private readonly recovery: Recovery

  public constructor(deps: ConversationDeps) {
    this.kernel = new SessionKernel(deps)
    this.bindings = new RuntimeBindings(this.kernel, this)
    this.deliveries = new DeliveryRecords(this.kernel, this.bindings)
    // The queue reacts to a turn's end, and a queued dispatch starts a turn: the turn side reaches the queue late.
    this.turns = new TurnLifecycle(this.kernel, this.bindings, this.deliveries, {
      apply: (sessionId, op) => this.queue.apply(sessionId, op),
      dispatchNext: sessionId => this.queue.dispatchNext(sessionId),
    })
    this.queue = new QueueService(this.kernel, this.bindings, this.deliveries, this.turns)
    this.plans = new PlanningService(this.kernel, this.bindings)
    this.goals = new GoalService(this.kernel, this.bindings)
    this.messages = new MessageService(this.kernel, this.bindings, this.deliveries, this.turns, this.queue, this.plans, this.goals)
    this.controls = new SessionControls(this.kernel, this.bindings, this.deliveries)
    this.interactions = new InteractionService(this.kernel, this.bindings, this.plans)
    this.recovery = new Recovery(this.kernel, this.deliveries, this.turns, this.queue, this.messages)
  }

  /** Errors swallowed by background work (event loops, dispatch); exposed for logs and tests. */
  public get backgroundErrors(): readonly { sessionId: string; error: unknown }[] {
    return this.kernel.backgroundErrors
  }

  public reportError(sessionId: string, error: unknown): void {
    this.kernel.reportError(sessionId, error)
  }

  /** Commits a timeline change and publishes it on the ChangeFeed. */
  public commit(sessionId: string, change: SessionChange): Promise<SessionCommit> {
    return this.kernel.commit(sessionId, change)
  }

  public patchSession(sessionId: string, patch: Parameters<ConversationStore['sessions']['update']>[1]): Promise<SessionCommit> {
    return this.kernel.patchSession(sessionId, patch)
  }

  // ---------------------------------------------------------------- runtime binding

  /** The open Runtime session, opening (or resuming) it on first use. */
  public binding(sessionId: string): Promise<SessionBinding> {
    return this.bindings.binding(sessionId)
  }

  /** A workspace preparation hands its Runtime session over to the session it creates (opened on first use). */
  public offerPrepared(sessionId: string, handOver: PreparedHandOver): void {
    this.bindings.offerPrepared(sessionId, handOver)
  }

  /** The creation did not go ahead: close the prepared Runtime session nobody adopted. */
  public withdrawPrepared(sessionId: string): Promise<void> {
    return this.bindings.withdrawPrepared(sessionId)
  }

  /** The open Runtime session of a Conversation, if any (snapshot capabilities come from it). */
  public boundSession(sessionId: string): RuntimeSession | null {
    return this.bindings.boundSession(sessionId)
  }

  /** Whether a Conversation has an open Runtime session (native history then comes from live events). */
  public isBound(sessionId: string): boolean {
    return this.bindings.isBound(sessionId)
  }

  // ---------------------------------------------------------------- conversation

  public createSession(command: CreateSessionCommand, context: CommandContext): Promise<SendResult> {
    return this.messages.createSession(command, context)
  }

  public sendMessage(command: SendMessageCommand, context: CommandContext): Promise<SendResult> {
    return this.messages.sendMessage(command, context)
  }

  public steer(command: SendMessageCommand, context: CommandContext): Promise<{ outcome: string }> {
    return this.controls.steer(command, context)
  }

  public select(sessionId: string, change: { optionId: string; value: string | boolean }): Promise<Record<string, unknown>> {
    return this.controls.select(sessionId, change)
  }

  public updateSelections(sessionId: string, selections: Readonly<Record<string, string | boolean | null>>): Promise<Record<string, unknown>> {
    return this.controls.updateSelections(sessionId, selections)
  }

  public interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
    return this.controls.interrupt(sessionId)
  }

  public respondNotice(sessionId: string, noticeId: string, responseId: string, answer: Parameters<RuntimeSession['respond']>[1]): Promise<{ status: string }> {
    return this.interactions.respondNotice(sessionId, noticeId, responseId, answer)
  }

  // ---------------------------------------------------------------- queue, planning, goals

  public queueOp(sessionId: string, op: ClientQueueOp, receipt?: CommandReceipt | null): Promise<Record<string, unknown>> {
    return this.queue.queueOp(sessionId, op, receipt)
  }

  public dispatchNext(sessionId: string): Promise<void> {
    return this.queue.dispatchNext(sessionId)
  }

  public planning(sessionId: string, request: PlanningRequest, receipt?: CommandReceipt | null): Promise<Record<string, unknown>> {
    return this.plans.planning(sessionId, request, receipt)
  }

  public goal(sessionId: string, request: GoalRequest, receipt?: CommandReceipt | null): Promise<Record<string, unknown>> {
    return this.goals.goal(sessionId, request, receipt)
  }

  // ---------------------------------------------------------------- runtime events

  public settleDeliveryStarted(sessionId: string, clientMessageId: string, userItemId: string | null): Promise<void> {
    return this.deliveries.settleDeliveryStarted(sessionId, clientMessageId, userItemId)
  }

  public adoptUserEcho(sessionId: string, clientMessageId: string, itemId: string): Promise<void> {
    return this.deliveries.adoptUserEcho(sessionId, clientMessageId, itemId)
  }

  public onTurnStarted(sessionId: string, turnId: string, clientMessageId: string | null): Promise<void> {
    return this.turns.onTurnStarted(sessionId, turnId, clientMessageId)
  }

  public onTurnEnded(sessionId: string, turnId: string, outcome: 'completed' | 'interrupted' | 'failed', message: string | null): Promise<void> {
    return this.turns.onTurnEnded(sessionId, turnId, outcome, message)
  }

  public onInteractionOpened(sessionId: string, event: Extract<RuntimeEvent, { type: 'interaction.opened' }>): Promise<void> {
    return this.interactions.onInteractionOpened(sessionId, event)
  }

  public onInteractionResolved(sessionId: string, interactionId: string, resolution: 'answered' | 'withdrawn' | 'expired'): Promise<void> {
    return this.interactions.onInteractionResolved(sessionId, interactionId, resolution)
  }

  public onPlanUpdated(sessionId: string, event: Extract<RuntimeEvent, { type: 'plan.updated' }>): Promise<void> {
    return this.plans.onPlanUpdated(sessionId, event)
  }

  public onPlanningMode(sessionId: string, mode: 'plan' | 'normal'): Promise<void> {
    return this.plans.onPlanningMode(sessionId, mode)
  }

  public onGoalUpdated(sessionId: string, wire: Record<string, unknown> | null, receiptFor?: (state: GoalState) => CommandReceipt | null): Promise<void> {
    return this.goals.onGoalUpdated(sessionId, wire, receiptFor)
  }

  public onLiveFact(sessionId: string, event: LiveFact): void {
    this.turns.onLiveFact(sessionId, event)
  }

  public onSessionLost(sessionId: string, error: { code: string; message: string }): Promise<void> {
    return this.turns.onSessionLost(sessionId, error)
  }

  // ---------------------------------------------------------------- lifecycle

  /** Settles what a restart left behind; see `Recovery.recover`. */
  public recover(): Promise<void> {
    return this.recovery.recover()
  }

  public close(): Promise<void> {
    return this.bindings.close()
  }
}
