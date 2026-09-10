import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { InteractionNotice } from './types.js'
import type { SessionController } from './session-controller.js'
import { BridgeError } from '../wire/errors.js'

type NoticeEmitter = (notice: InteractionNotice) => Promise<void>
type ControllerResolver = (agent: Agent) => SessionController | undefined

interface PendingApproval {
  notice: InteractionNotice
  controller: SessionController
  closed: boolean
  resolve(outcome: ApprovalOutcome): void
  abortCleanup(): void
}

export class InteractionManager {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly closed = new Set<string>()
  private readonly closedOrder: string[] = []

  constructor(
    private readonly ctx: Context,
    private readonly maxPending: number,
    private readonly controllerForAgent: ControllerResolver,
    private readonly connectorAvailable: () => boolean,
    private readonly emit: NoticeEmitter,
  ) {}

  register(): () => void {
    return this.ctx.on('approval/request', async (request, next) => {
      const controller = this.controllerForAgent(request.agent)
      if (controller === undefined || !this.connectorAvailable() || this.pending.size >= this.maxPending) {
        return await next()
      }
      return await this.askApproval(controller, request, next)
    })
  }

  notices(platformSessionId: string): InteractionNotice[] {
    return [...this.pending.values()]
      .filter(item => item.notice.sessionId === platformSessionId && !item.closed)
      .map(item => item.notice)
  }

  async respond(
    platformSessionId: string,
    noticeId: string,
    actionId: string,
  ): Promise<{ ok: true; duplicate: false }> {
    const pending = this.pending.get(noticeId)
    if (pending === undefined || pending.closed || pending.notice.sessionId !== platformSessionId) {
      throw new BridgeError('INTERACTION_ALREADY_CLOSED', 'The interaction is already closed or belongs to another Session.', {
        retryable: false,
        sessionId: platformSessionId,
      })
    }
    if (actionId !== 'allow_once' && actionId !== 'reject') {
      throw new BridgeError('INVALID_PARAMS', 'Approval action must be allow_once or reject.', { retryable: false })
    }
    const outcome: ApprovalOutcome = actionId === 'allow_once' ? 'allowed-once' : 'rejected'
    await this.close(pending, 'closed')
    pending.resolve(outcome)
    return { ok: true, duplicate: false }
  }

  async cancelFor(controller: SessionController): Promise<void> {
    await Promise.all([...this.pending.values()]
      .filter(item => item.controller === controller)
      .map(item => this.cancel(item)))
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.pending.values()].map(item => this.cancel(item)))
  }

  private async askApproval(
    controller: SessionController,
    request: ApprovalRequest,
    fallback: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const platformSessionId = controller.platformSessionId
    if (platformSessionId === undefined) return await fallback()
    const noticeId = `dsh-approval-${randomUUID()}`
    const deferred = promiseWithResolvers<ApprovalOutcome>()
    const notice: InteractionNotice = {
      noticeId,
      sessionId: platformSessionId,
      externalSessionId: String(controller.externalSessionId),
      runtime: 'dsh',
      type: 'interaction',
      interactionKind: 'approval',
      title: `Approve ${request.toolName}`,
      severity: 'warning',
      status: 'open',
      responseRequired: true,
      actions: [
        { id: 'allow_once', label: 'Allow once', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
      details: {
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      },
    }
    let pending: PendingApproval
    const onAbort = (): void => { void this.cancel(pending) }
    pending = {
      notice,
      controller,
      closed: false,
      resolve: deferred.resolve,
      abortCleanup: () => request.signal?.removeEventListener('abort', onAbort),
    }
    this.pending.set(noticeId, pending)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted === true) onAbort()
    try {
      await controller.openInteraction(noticeId)
      await this.emit(notice)
    } catch {
      await this.close(pending, 'cancelled')
      return await fallback()
    }
    return await deferred.promise
  }

  private async cancel(pending: PendingApproval): Promise<void> {
    if (pending.closed) return
    await this.close(pending, 'cancelled')
    pending.resolve('cancelled')
  }

  private async close(pending: PendingApproval, status: 'closed' | 'cancelled'): Promise<void> {
    if (pending.closed) return
    pending.closed = true
    pending.abortCleanup()
    this.pending.delete(pending.notice.noticeId)
    this.rememberClosed(pending.notice.noticeId)
    await pending.controller.closeInteraction(pending.notice.noticeId)
    await this.emit({
      ...pending.notice,
      status,
      responseRequired: false,
    }).catch(() => undefined)
  }

  private rememberClosed(id: string): void {
    this.closed.add(id)
    this.closedOrder.push(id)
    const expired = this.closedOrder.length > 4_096 ? this.closedOrder.shift() : undefined
    if (expired !== undefined) this.closed.delete(expired)
  }
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(innerResolve => { resolve = innerResolve })
  return { promise, resolve }
}
