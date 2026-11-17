import { createHash } from 'node:crypto'

import { ConversationError } from '../../domain/conversation/index.js'
import { GoalConflict, GoalInvalid } from '../../domain/goals/index.js'
import { PlanningConflict, PlanningInvalid } from '../../domain/planning/index.js'
import type { CommandAck } from '../../generated/device-meshcall/v1_0/command-ack.js'
import type { CommandCall } from '../../generated/device-meshcall/v1_0/command-call.js'
import { COMMAND_ROUTES, type CommandMethod } from '../../generated/device-meshcall/v1_0/payloads.js'
import { PreparationError } from '../../domain/creation/index.js'
import { UseCaseError, type AttachmentRef, type ConversationService } from '../conversation-service.js'
import type { PreparationService } from '../creation/index.js'
import type { Clock, CommandHandlerContext, CommandHandlers, CommandReceipt, CommandRecord, ConversationStore, InteractionAnswer } from '../ports/index.js'
import { parseRequest, type CommandRequest, type CommandResponse, type ParsedRequest } from './command-requests.js'

export type { CommandHandler, CommandHandlerContext, CommandHandlers } from '../ports/index.js'
export { parseRequest, REQUEST_PARSERS, type CommandRequest, type CommandResponse, type ParsedRequest } from './command-requests.js'

/** Business method name (`session.queue.sendNow`) → MeshCall method (`sessionQueueSendNow`), as the contract says. */
export function commandRoute(method: string): string {
  const route = (COMMAND_ROUTES as Readonly<Record<string, string>>)[method]
  if (route !== undefined) return route.slice(route.indexOf('/') + 1)
  return method.split(/[._]/u).map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))).join('')
}

/** What the inbox runs for `M`: the parsed request in, the generated response out. */
type InboxHandler<M extends CommandMethod> = (payload: ParsedRequest<M>, context: CommandHandlerContext) => Promise<CommandResponse<M>>

/** The answer of a use case that builds its contract body untyped (planning, goal, workspace preparation), as `M`'s response. */
function untyped<M extends CommandMethod>(body: Promise<object>): Promise<CommandResponse<M>> {
  return body as Promise<never>
}

interface Entry {
  readonly method: CommandMethod
  readonly handler: (payload: unknown, context: CommandHandlerContext) => Promise<unknown>
}

/** The error code a client sees for a rejected command. */
export function errorCode(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof UseCaseError) return { code: error.code, message: error.message }
  if (error instanceof ConversationError) return { code: error.code, message: error.message }
  if (error instanceof PlanningConflict || error instanceof GoalConflict) return { code: 'conflict', message: error.message }
  if (error instanceof PlanningInvalid || error instanceof GoalInvalid) return { code: 'invalid_argument', message: error.message }
  if (error instanceof PreparationError) return { code: error.code, message: error.message }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return { code, message: (error as Error).message }
  return { code: 'internal', message: (error as Error)?.message ?? String(error), retryable: true }
}

/**
 * `aa.device.v1.Commands/*` (06-protocols.md §2.4): durable receipts by `commandId`. A replay with the same input
 * digest returns the recorded ack without running anything; a different digest is a conflict. The ack is
 * `accepted` only after the use case's effect and the receipt are on disk. The device never re-executes a
 * command on its own; `Commands/status` only reads receipts.
 *
 * Commands whose effect is a local write (sending and creating messages, queue operations, planning and goal
 * state) commit the receipt in that write's transaction (`CommandReceipt`), so a crash between the two cannot
 * make a retry run the command a second time. Effects outside the store (a Runtime call: interrupt, select,
 * steer, answering a notice, a planning or goal action) cannot share a transaction; a crash after such a call
 * and before its write leaves the retry to run it again, and those use cases rely on the Runtime's or the
 * natural key's idempotency (`responseId`, `clientMessageId`).
 */
export class CommandInbox {
  private readonly handlers = new Map<string, Entry>()
  private readonly running = new Map<string, Promise<CommandAck>>()

  public constructor(
    private readonly store: ConversationStore,
    private readonly clock: Clock,
    service: ConversationService,
    extra: CommandHandlers = {},
    /** Workspace preparation (runtime-workflows 1.2); absent: `workspace.*` commands are not served. */
    preparations?: PreparationService,
  ) {
    const register = <M extends CommandMethod>(method: M, handler: InboxHandler<M>): void => {
      this.handlers.set(commandRoute(method), { method, handler: handler as Entry['handler'] })
    }
    register('session.sendMessage', async (p, context) => untyped<'session.sendMessage'>(service.sendMessage({
      sessionId: p.sessionId,
      clientMessageId: p.clientMessageId,
      content: p.content,
      attachments: p.attachments as AttachmentRef[],
      queue: p.queue,
    }, context)))
    register('session.steer', async (p, context) => service.steer({ sessionId: p.sessionId, clientMessageId: p.clientMessageId, content: p.content }, context))
    // The Server sends v2 `session.selections.update` here: `{selections: {model: ..., permission: ...}}`. A
    // single `{optionId, value}` (the secure channel's route) is still accepted.
    register('session.select', async p => {
      if (p.selections != null) return service.updateSelections(p.sessionId, p.selections)
      return service.select(p.sessionId, { optionId: p.optionId, value: p.value })
    })
    register('session.interrupt', async p => service.interrupt(p.sessionId))
    register('session.respondNotice', async (p, context) => service.respondNotice(p.sessionId, p.noticeId, p.responseId ?? context.commandId, answerOf(p)))
    register('session.creation.begin', async (p, context) => {
      // From a prepared workspace (the Server's creation workflow): the prepared Agent session is consumed.
      if (p.preparationId != null) {
        if (preparations === undefined) throw new UseCaseError('workflow_unsupported', 'Workspace preparation is not available on this device.')
        return untyped<'session.creation.begin'>(preparations.begin(p, context))
      }
      const direct = p as Exclude<typeof p, { preparationId: string }>
      const created = await service.createSession({
        sessionId: direct.sessionId,
        runtimeId: direct.runtimeId,
        runtimeType: direct.runtimeType,
        cwd: direct.cwd,
        ...(direct.projectId != null ? { projectId: direct.projectId } : {}),
        title: direct.title ?? null,
        ...(direct.selections != null ? { selections: direct.selections } : {}),
        clientMessageId: direct.clientMessageId,
        content: direct.content,
        attachments: direct.attachments as AttachmentRef[],
        ...(direct.takeover != null ? { takeover: direct.takeover } : {}),
        planningIntent: direct.planningIntent,
        goalIntent: direct.goalIntent,
      }, context)
      return { sessionId: direct.sessionId, ...created } as CommandResponse<'session.creation.begin'>
    })
    if (preparations !== undefined) {
      // PreparationService answers runtime-workflows 1.2 views (`WorkflowState`) and checks its own requests.
      const workflow = <M extends CommandMethod>(run: (values: Record<string, unknown>) => Promise<Record<string, unknown>>): InboxHandler<M> =>
        async p => untyped<M>(run(p as Record<string, unknown>))
      register('workspace.prepare', workflow(values => preparations.prepare(values)))
      register('workspace.preparation.reserve', workflow(values => preparations.reserve(values)))
      register('workspace.preparation.cancel', workflow(values => preparations.cancel(values)))
      register('workspace.preparation.respond', workflow(values => preparations.respond(values)))
      register('session.creation.respond', workflow(values => preparations.respondCreation(values)))
      register('session.creation.cancel', workflow(values => preparations.cancelCreation(values)))
    }
    register('session.planning', async (p, context) => untyped<'session.planning'>(service.planning(p.sessionId, {
      command: p.command,
      operationId: p.operationId,
      ...(p.reviewId !== undefined ? { reviewId: p.reviewId } : {}),
      ...(p.planId !== undefined ? { planId: p.planId } : {}),
      ...(p.planRevision != null ? { planRevision: p.planRevision } : {}),
      ...(p.contentHash !== undefined ? { contentHash: p.contentHash } : {}),
      ...(p.expectedRevision != null ? { expectedRevision: p.expectedRevision } : {}),
      ...(p.epoch !== undefined ? { epoch: p.epoch } : {}),
      ...(p.feedback !== undefined ? { feedback: p.feedback } : {}),
    }, context.receipt)))
    register('session.goal', async (p, context) => untyped<'session.goal'>(service.goal(p.sessionId, {
      action: p.action,
      expectedRevision: p.expectedRevision,
      objective: p.objective ?? null,
      operationId: p.operationId,
    }, context.receipt)))
    const queue = (kind: 'update' | 'remove' | 'retry' | 'sendNow'): InboxHandler<'session.queue.update'> => async (p, context) => service.queueOp(p.sessionId, {
      kind,
      messageId: p.messageId,
      ...(kind === 'update' && p.content !== undefined ? { content: p.content } : {}),
      ...(kind === 'update' && p.attachments !== undefined ? { attachments: p.attachments as AttachmentRef[] } : {}),
    } as never, context.receipt)
    register('session.queue.update', queue('update'))
    register('session.queue.delete', queue('remove'))
    register('session.queue.retry', queue('retry'))
    register('session.queue.sendNow', queue('sendNow'))
    register('session.queue.resume', async (p, context) => service.queueOp(p.sessionId, { kind: 'resume' }, context.receipt))
    register('session.queue.reorder', async (p, context) => service.queueOp(p.sessionId, { kind: 'reorder', messageIds: p.messageIds }, context.receipt))
    register('session.queue.clear', async (p, context) => service.queueOp(p.sessionId, { kind: 'clear' }, context.receipt))
    register('session.sync', async p => {
      const commit = await service.patchSession(p.sessionId, {
        ...(p.takeover != null ? { takeover: p.takeover } : {}),
        ...(p.archived != null ? { archived: p.archived } : {}),
      })
      void service.dispatchNext(p.sessionId).catch(error => service.reportError(p.sessionId, error))
      return { headSeq: commit.session.clock.headSeq }
    })
    for (const method of Object.keys(extra) as CommandMethod[]) {
      const handler = extra[method]
      if (handler !== undefined) register(method, handler as InboxHandler<typeof method>)
    }
  }

  /** MeshCall method names this inbox serves (for registration). */
  public routes(): string[] {
    return [...this.handlers.keys()]
  }

  public async handle(route: string, call: CommandCall, actor = 'server'): Promise<CommandAck> {
    const entry = this.handlers.get(route)
    if (entry === undefined) return { outcome: 'rejected', e: { code: 'method_not_found', message: `unknown command ${route}` } }
    const inputDigest = call.inputDigest ?? `sha256:${createHash('sha256').update(JSON.stringify(call.p ?? {})).digest('hex')}`
    // Concurrent duplicates (MeshCall retries, a second worker) share one execution.
    const inFlight = this.running.get(call.commandId)
    if (inFlight !== undefined) return inFlight
    const work = this.execute(entry, call, inputDigest, actor)
    this.running.set(call.commandId, work)
    try {
      return await work
    } finally {
      this.running.delete(call.commandId)
    }
  }

  private async execute({ method, handler }: Entry, call: CommandCall, inputDigest: string, actor: string): Promise<CommandAck> {
    const recorded = await this.store.commands.get(call.commandId)
    if (recorded !== null) {
      if (recorded.inputDigest !== null && recorded.inputDigest !== inputDigest) {
        return { outcome: 'rejected', e: { code: 'command_conflict', message: 'This commandId was already used with different input.' } }
      }
      return ackOf(recorded)
    }
    const payload = (call.p ?? {}) as Record<string, unknown>
    const createdAt = this.clock.nowIso()
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
    const receipt: CommandReceipt = { commandId: call.commandId, method, sessionId, inputDigest, createdAt, result: null }
    let record: CommandRecord
    try {
      // The payload is checked here, once: a payload that does not fit the contract is a rejected command.
      const result = (await handler(parseRequest(method, payload), { commandId: call.commandId, inputDigest: call.inputDigest ?? null, actor, receipt })) as Record<string, unknown>
      record = { commandId: call.commandId, method, sessionId, inputDigest, outcome: 'accepted', result, error: null, createdAt, updatedAt: this.clock.nowIso() }
    } catch (error) {
      const coded = errorCode(error)
      if (coded.code === 'internal') {
        // Not a business rejection. A receipt committed with the effect stands; otherwise the effect may or may not
        // have happened: record nothing durable, and the Server classifies the call failure as an unknown outcome.
        const committed = await this.store.commands.get(call.commandId)
        if (committed !== null && committed.outcome !== 'unknown') return ackOf(committed)
        throw error
      }
      record = { commandId: call.commandId, method, sessionId, inputDigest, outcome: 'rejected', result: null, error: coded, createdAt, updatedAt: this.clock.nowIso() }
    }
    // A receipt already committed with the effect stands (settle returns it unchanged).
    return ackOf(await this.store.commands.settle(record))
  }
}

function ackOf(record: CommandRecord): CommandAck {
  if (record.outcome === 'accepted') return { outcome: 'accepted', r: record.result }
  return {
    outcome: 'rejected',
    e: record.error === null ? { code: 'unknown' } : { code: record.error.code, ...(record.error.message !== undefined ? { message: record.error.message } : {}), ...(record.error.retryable !== undefined ? { retryable: record.error.retryable } : {}) },
  }
}

/** v2 notice responses: an action id (approval option), form input, or a cancellation. */
function answerOf(p: CommandRequest<'session.respondNotice'>): InteractionAnswer {
  if (p.cancel === true || p.actionId === 'cancel') return { kind: 'cancelled' }
  if (p.input != null) return { kind: 'form', action: p.actionId === 'decline' ? 'decline' : 'accept', values: p.input as never }
  // The parser requires an action id when there is neither a cancellation nor input.
  return { kind: 'option', optionId: p.actionId as string }
}
