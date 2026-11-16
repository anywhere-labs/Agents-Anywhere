import { createHash } from 'node:crypto'

import { ConversationError } from '../../domain/conversation/index.js'
import { GoalConflict, GoalInvalid } from '../../domain/goals/index.js'
import { PlanningConflict, PlanningInvalid } from '../../domain/planning/index.js'
import type { CommandAck } from '../../generated/device-meshcall/v1_0/command-ack.js'
import type { CommandCall } from '../../generated/device-meshcall/v1_0/command-call.js'
import { UseCaseError, type AttachmentRef, type ConversationService } from '../conversation-service.js'
import type { Clock, CommandRecord, ConversationStore, InteractionAnswer } from '../ports/index.js'

/** A command handler returns its result body (`CommandAck.r`); throwing a coded error rejects the command. */
export type CommandHandler = (payload: Record<string, unknown>, context: { commandId: string; inputDigest: string | null; actor: string }) => Promise<Record<string, unknown>>

/** Business method name (`session.queue.sendNow`) → MeshCall method (`sessionQueueSendNow`), as the contract says. */
export function commandRoute(method: string): string {
  return method.split(/[._]/u).map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))).join('')
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new UseCaseError('invalid_argument', `${field} is required`)
  return value
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The error code a client sees for a rejected command. */
export function errorCode(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof UseCaseError) return { code: error.code, message: error.message }
  if (error instanceof ConversationError) return { code: error.code, message: error.message }
  if (error instanceof PlanningConflict || error instanceof GoalConflict) return { code: 'conflict', message: error.message }
  if (error instanceof PlanningInvalid || error instanceof GoalInvalid) return { code: 'invalid_argument', message: error.message }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return { code, message: (error as Error).message }
  return { code: 'internal', message: (error as Error)?.message ?? String(error), retryable: true }
}

/**
 * `aa.device.v1.Commands/*` (06-protocols.md §2.4): durable receipts by `commandId`. A replay with the same input
 * digest returns the recorded ack without running anything; a different digest is a conflict. The ack is
 * `accepted` only after the use case's effect and the receipt are on disk. The device never re-executes a
 * command on its own; `Commands/status` only reads receipts.
 */
export class CommandInbox {
  private readonly handlers = new Map<string, { method: string; handler: CommandHandler }>()
  private readonly running = new Map<string, Promise<CommandAck>>()

  public constructor(
    private readonly store: ConversationStore,
    private readonly clock: Clock,
    service: ConversationService,
    extra: Readonly<Record<string, CommandHandler>> = {},
  ) {
    const register = (method: string, handler: CommandHandler): void => {
      this.handlers.set(commandRoute(method), { method, handler })
    }
    register('session.sendMessage', async (p, context) => ({ ...(await service.sendMessage({
      sessionId: text(p.sessionId, 'sessionId'),
      clientMessageId: text(p.clientMessageId, 'clientMessageId'),
      content: typeof p.content === 'string' ? p.content : '',
      attachments: Array.isArray(p.attachments) ? (p.attachments as AttachmentRef[]) : [],
      queue: (optionalString(p.queue) as 'auto' | 'interrupt' | 'never' | null),
    }, context)) }))
    register('session.steer', async (p, context) => service.steer({
      sessionId: text(p.sessionId, 'sessionId'),
      clientMessageId: text(p.clientMessageId, 'clientMessageId'),
      content: typeof p.content === 'string' ? p.content : '',
    }, context))
    register('session.select', async p => service.select(text(p.sessionId, 'sessionId'), {
      optionId: text(p.optionId ?? p.kind, 'optionId'),
      value: typeof p.value === 'boolean' ? p.value : text(p.value ?? p.selectionId, 'value'),
    }))
    register('session.interrupt', async p => service.interrupt(text(p.sessionId, 'sessionId')))
    register('session.respondNotice', async (p, context) => service.respondNotice(
      text(p.sessionId, 'sessionId'),
      text(p.noticeId, 'noticeId'),
      optionalString(p.responseId) ?? context.commandId,
      answerOf(p),
    ))
    register('session.creation.begin', async (p, context) => ({ sessionId: text(p.sessionId, 'sessionId'), ...(await service.createSession({
      sessionId: text(p.sessionId, 'sessionId'),
      runtimeId: text(p.runtimeId, 'runtimeId'),
      runtimeType: text(p.runtimeType, 'runtimeType'),
      cwd: text(p.cwd, 'cwd'),
      title: optionalString(p.title),
      ...(p.selections !== null && typeof p.selections === 'object' ? { selections: p.selections as Record<string, string | null> } : {}),
      clientMessageId: text(p.clientMessageId, 'clientMessageId'),
      content: typeof p.content === 'string' ? p.content : '',
      attachments: Array.isArray(p.attachments) ? (p.attachments as AttachmentRef[]) : [],
      ...(typeof p.takeover === 'boolean' ? { takeover: p.takeover } : {}),
    }, context)) }))
    register('session.planning', async p => service.planning(text(p.sessionId, 'sessionId'), {
      command: text(p.command, 'command'),
      operationId: text(p.operationId, 'operationId'),
      ...(p.reviewId !== undefined ? { reviewId: optionalString(p.reviewId) } : {}),
      ...(p.planId !== undefined ? { planId: optionalString(p.planId) } : {}),
      ...(typeof p.planRevision === 'number' ? { planRevision: p.planRevision } : {}),
      ...(p.contentHash !== undefined ? { contentHash: optionalString(p.contentHash) } : {}),
      ...(typeof p.expectedRevision === 'number' ? { expectedRevision: p.expectedRevision } : {}),
      ...(p.epoch !== undefined ? { epoch: optionalString(p.epoch) } : {}),
      ...(p.feedback !== undefined ? { feedback: optionalString(p.feedback) } : {}),
    }))
    register('session.goal', async p => service.goal(text(p.sessionId, 'sessionId'), {
      action: text(p.action, 'action') as 'set',
      expectedRevision: typeof p.expectedRevision === 'number' ? p.expectedRevision : -1,
      objective: optionalString(p.objective),
      operationId: text(p.operationId, 'operationId'),
    }))
    const queue = (kind: 'update' | 'remove' | 'retry' | 'sendNow') => async (p: Record<string, unknown>) => service.queueOp(text(p.sessionId, 'sessionId'), {
      kind,
      messageId: text(p.messageId, 'messageId'),
      ...(kind === 'update' && typeof p.content === 'string' ? { content: p.content } : {}),
      ...(kind === 'update' && Array.isArray(p.attachments) ? { attachments: p.attachments as never } : {}),
    } as never)
    register('session.queue.update', queue('update'))
    register('session.queue.delete', queue('remove'))
    register('session.queue.retry', queue('retry'))
    register('session.queue.sendNow', queue('sendNow'))
    register('session.queue.resume', async p => service.queueOp(text(p.sessionId, 'sessionId'), { kind: 'resume' }))
    register('session.queue.reorder', async p => service.queueOp(text(p.sessionId, 'sessionId'), { kind: 'reorder', messageIds: Array.isArray(p.messageIds) ? p.messageIds.map(String) : [] }))
    register('session.queue.clear', async p => service.queueOp(text(p.sessionId, 'sessionId'), { kind: 'clear' }))
    register('session.sync', async p => {
      const sessionId = text(p.sessionId, 'sessionId')
      const commit = await service.patchSession(sessionId, {
        ...(typeof p.takeover === 'boolean' ? { takeover: p.takeover } : {}),
        ...(typeof p.archived === 'boolean' ? { archived: p.archived } : {}),
      })
      void service.dispatchNext(sessionId).catch(error => service.reportError(sessionId, error))
      return { headSeq: commit.session.clock.headSeq }
    })
    for (const [method, handler] of Object.entries(extra)) register(method, handler)
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
    const work = this.execute(entry.method, entry.handler, call, inputDigest, actor)
    this.running.set(call.commandId, work)
    try {
      return await work
    } finally {
      this.running.delete(call.commandId)
    }
  }

  private async execute(method: string, handler: CommandHandler, call: CommandCall, inputDigest: string, actor: string): Promise<CommandAck> {
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
    let record: CommandRecord
    try {
      const result = await handler(payload, { commandId: call.commandId, inputDigest: call.inputDigest ?? null, actor })
      record = { commandId: call.commandId, method, sessionId, inputDigest, outcome: 'accepted', result, error: null, createdAt, updatedAt: this.clock.nowIso() }
    } catch (error) {
      const coded = errorCode(error)
      if (coded.code === 'internal') {
        // Not a business rejection: the effect may or may not have happened. Record nothing durable as
        // accepted/rejected; the Server classifies the call failure as an unknown outcome.
        throw error
      }
      record = { commandId: call.commandId, method, sessionId, inputDigest, outcome: 'rejected', result: null, error: coded, createdAt, updatedAt: this.clock.nowIso() }
    }
    await this.store.commands.settle(record)
    return ackOf(record)
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
function answerOf(p: Record<string, unknown>): InteractionAnswer {
  if (p.cancel === true || p.actionId === 'cancel') return { kind: 'cancelled' }
  if (p.input !== undefined && p.input !== null && typeof p.input === 'object') {
    return { kind: 'form', action: p.actionId === 'decline' ? 'decline' : 'accept', values: p.input as never }
  }
  return { kind: 'option', optionId: text(p.actionId, 'actionId') }
}
