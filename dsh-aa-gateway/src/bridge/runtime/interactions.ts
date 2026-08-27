import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { sha256Hex } from '../projection/identity.js'
import { BridgeError } from '../wire/errors.js'
import type { InteractionNotice } from '../wire/protocol.js'
import { arrayField, isRecord, stringField } from '../wire/validation.js'
import type { SessionController } from './session-controller.js'
import {
  bridgeMuxEnvelope,
  type BridgeClientResponse,
  type BridgeMuxEnvelope,
  type BridgeRpcReceipt,
} from '../control/api-frames.js'

type NoticeEmitter = (notice: InteractionNotice) => void | Promise<void>
type ControllerResolver = (agent: Agent) => SessionController | undefined
type ReplicaEmitter = (sessionId: SessionController['externalSessionId'], envelope: BridgeMuxEnvelope) => void | Promise<void>
type UserQuestionObserver = (
  request: AskUserQuestionRequest,
  next: (request?: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

declare module '@deepseek-ai/dsh-user-questions' {
  interface UserQuestionService {
    registerObserver(observer: UserQuestionObserver): () => void
  }
}

interface PendingBase {
  notice: InteractionNotice
  controller: SessionController
  closed: boolean
  muxRpcId: string
  abortCleanup(): void
}

interface PendingApproval extends PendingBase {
  kind: 'approval'
  approvalId: string
  resolve(outcome: ApprovalOutcome): void
}

interface PendingQuestion extends PendingBase {
  kind: 'user_question'
  questions: AskUserQuestionItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: Error): void
}

type PendingInteraction = PendingApproval | PendingQuestion

interface RemoteInteraction {
  notice: InteractionNotice
  externalSessionId: SessionController['externalSessionId']
  muxRpcId: string
  kind: 'approval' | 'user_question'
  approvalId?: string
  questions?: AskUserQuestionItem[]
}

/** Prepared response for an interaction owned by another process. */
export interface RemoteInteractionResponse {
  message: BridgeClientResponse
  close(): Promise<void>
}

/** Owns approval and user-question notices and their first-valid responses. */
export class InteractionManager {
  private readonly pending = new Map<string, PendingInteraction>()
  private readonly remote = new Map<string, RemoteInteraction>()
  private readonly closed = new Set<string>()
  private readonly shutdownSignal = new AbortController()

  /**
   * @param ctx - Bridge context providing approval and userQuestions.
   * @param maxPending - Whole-process pending interaction bound.
   * @param controllerForAgent - Exact root Agent ownership lookup.
   * @param emit - Connector notice publisher.
   * @param replicate - Web mux publisher used when this process owns the Agent.
   */
  constructor(
    private readonly ctx: Context,
    private readonly maxPending: number,
    private readonly controllerForAgent: ControllerResolver,
    private readonly emit: NoticeEmitter,
    private readonly replicate: ReplicaEmitter,
  ) {}

  /** Register approval handling and question mirroring when the host exposes that extension. */
  register(): () => void {
    const disposeApproval = this.ctx.on('approval/request', async (request, next) => {
      const controller = this.controllerForAgent(request.agent)
      if (controller === undefined) return await next()
      return await this.askApproval(controller, request)
    })
    const observer: UserQuestionObserver = (request, next) => this.observeQuestion(request, next)
    const disposeQuestions = typeof this.ctx.userQuestions.registerObserver === 'function'
      ? this.ctx.userQuestions.registerObserver(observer)
      : () => {}
    return () => {
      disposeApproval()
      disposeQuestions()
    }
  }

  /** Report whether this DSH build can mirror user questions to more than one client. */
  supportsUserQuestions(): boolean {
    return typeof this.ctx.userQuestions.registerObserver === 'function'
  }

  /** Mirror a Web-owned question while preserving the Web UI provider as a competing answerer. */
  private async observeQuestion(
    request: AskUserQuestionRequest,
    next: (request?: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const controller = request.agent === undefined ? undefined : this.controllerForAgent(request.agent)
    if (controller === undefined || controller.platformSessionId === undefined) return await next()
    const localAbort = new AbortController()
    const localSignal = combinedSignal(request.signal, localAbort.signal)
    let winner: 'local' | 'bridge' | undefined
    const local = next({ ...request, signal: localSignal }).then(
      answer => { winner = 'local'; return answer },
      error => { winner = 'local'; throw error },
    )
    const mirrored = this.askQuestion(request).then(
      answer => { winner = 'bridge'; return answer },
      error => { winner = 'bridge'; throw error },
    )
    const pendingId = this.findQuestionPendingId(request, controller)
    try {
      return await Promise.race([local, mirrored])
    } finally {
      localAbort.abort()
      if (winner === 'local' && pendingId !== undefined) await this.cancel(pendingId)
    }
  }

  private findQuestionPendingId(
    request: AskUserQuestionRequest,
    controller: SessionController,
  ): string | undefined {
    return [...this.pending.values()].find(pending => (
      pending.kind === 'user_question' && pending.controller === controller && pending.questions === request.questions
    ))?.notice.id
  }

  /** Resolve one open interaction; invalid answers leave it open. */
  async respond(
    platformSessionId: string,
    noticeId: string,
    actionId: string,
    inputData: unknown,
  ): Promise<{ ok: true; duplicate: false }> {
    const pending = this.pending.get(noticeId)
    if (pending === undefined || pending.closed || pending.notice.sessionId !== platformSessionId) {
      throw new BridgeError('INTERACTION_ALREADY_CLOSED', 'The interaction is already closed or does not belong to this Session.', {
        retryable: false,
        sessionId: platformSessionId,
      })
    }
    if (pending.kind === 'approval') {
      if (actionId !== 'allow_once' && actionId !== 'reject') {
        throw new BridgeError('INVALID_PARAMS', 'Approval action must be allow_once or reject.', { retryable: false })
      }
      await this.close(pending, 'closed')
      const outcome = actionId === 'allow_once' ? 'allowed-once' : 'rejected'
      await this.replicateResolved(pending, outcome)
      pending.resolve(outcome)
      return { ok: true, duplicate: false }
    }
    if (actionId !== 'submit') {
      throw new BridgeError('INVALID_PARAMS', 'User-question action must be submit.', { retryable: false })
    }
    const answer = validateQuestionAnswer(inputData, pending.questions)
    await this.close(pending, 'closed')
    await this.replicateResolved(pending, 'answered')
    pending.resolve(answer)
    return { ok: true, duplicate: false }
  }

  /** Resolve one Web response forwarded from a follower process. */
  async respondWeb(message: BridgeClientResponse): Promise<BridgeRpcReceipt> {
    const pending = this.pending.get(message.rpcId)
    if (pending === undefined || pending.closed) return { accepted: false, reason: 'not-pending' }
    if (message.sessionId !== pending.controller.externalSessionId) return { accepted: false, reason: 'bad-response' }
    if (pending.kind === 'approval') {
      if (!message.result.ok || !isRecord(message.result.value)) return { accepted: false, reason: 'bad-response' }
      const value = message.result.value
      if (value.sessionId !== message.sessionId || value.approvalId !== pending.approvalId
        || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) {
        return { accepted: false, reason: 'bad-response' }
      }
      await this.close(pending, 'closed')
      await this.replicateResolved(pending, value.outcome)
      pending.resolve(value.outcome)
      return { accepted: true }
    }
    if (!message.result.ok) {
      if (message.result.error.code !== 'cancelled') return { accepted: false, reason: 'bad-response' }
      await this.close(pending, 'cancelled')
      await this.replicateResolved(pending, 'cancelled')
      pending.reject(new Error('The user cancelled the question.'))
      return { accepted: true }
    }
    if (!isRecord(message.result.value) || message.result.value.sessionId !== message.sessionId
      || !isRecord(message.result.value.answer)) return { accepted: false, reason: 'bad-response' }
    let answer: AskUserQuestionAnswer
    try {
      answer = validateQuestionAnswer(message.result.value.answer, pending.questions)
    } catch {
      return { accepted: false, reason: 'bad-response' }
    }
    await this.close(pending, 'closed')
    await this.replicateResolved(pending, 'answered')
    pending.resolve(answer)
    return { accepted: true }
  }

  /** Cancel every pending interaction during EOF, shutdown, or service disposal. */
  async cancelAll(): Promise<void> {
    if (!this.shutdownSignal.signal.aborted) this.shutdownSignal.abort(new Error('bridge shutdown'))
    await Promise.all([...this.pending.values()].map(async (pending) => {
      if (pending.closed) return
      await this.close(pending, 'cancelled')
      if (pending.kind === 'approval') pending.resolve('cancelled')
      else pending.reject(new Error('The bridge stopped before the user answered.'))
    }))
  }

  /** Cancel interactions owned by one Session before interrupt convergence. */
  async cancelFor(controller: SessionController): Promise<void> {
    await Promise.all([...this.pending.values()]
      .filter(pending => pending.controller === controller)
      .map(pending => this.cancel(pending.notice.id)))
  }

  /** Current open notices for one AA Session. */
  notices(platformSessionId: string): InteractionNotice[] {
    return [
      ...[...this.pending.values()]
        .filter(item => item.notice.sessionId === platformSessionId && !item.closed)
        .map(item => item.notice),
      ...[...this.remote.values()]
        .filter(item => item.notice.sessionId === platformSessionId)
        .map(item => item.notice),
    ]
  }

  /** Upsert or resolve one Web interaction replicated from a remote owner. */
  async consumeWebEnvelope(platformSessionId: string, envelope: BridgeMuxEnvelope): Promise<void> {
    const payload = envelope.payload
    if (payload.type === 'approval/requested') {
      const id = noticeId('remote-approval', String(payload.sessionId), envelope.rpcId)
      const notice: InteractionNotice = {
        id,
        sessionId: platformSessionId,
        externalSessionId: String(payload.sessionId),
        type: 'interaction',
        interactionKind: 'approval',
        responseRequired: true,
        status: 'open',
        title: `Approve ${payload.toolName}`,
        details: {
          toolName: payload.toolName,
          ...(payload.callId === undefined ? {} : { callId: payload.callId }),
          ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        },
        actions: [
          { id: 'allow_once', label: 'Allow once', style: 'primary' },
          { id: 'reject', label: 'Reject', style: 'danger' },
        ],
      }
      this.remote.set(id, {
        notice,
        externalSessionId: payload.sessionId,
        muxRpcId: envelope.rpcId,
        kind: 'approval',
        approvalId: payload.approvalId,
      })
      await this.emit(notice)
      return
    }
    if (payload.type === 'question/requested') {
      const id = noticeId('remote-question', String(payload.sessionId), envelope.rpcId)
      const notice: InteractionNotice = {
        id,
        sessionId: platformSessionId,
        externalSessionId: String(payload.sessionId),
        type: 'interaction',
        interactionKind: 'user_question',
        responseRequired: true,
        status: 'open',
        title: 'Question from DeepSeek Harness',
        details: { questions: payload.questions },
        actions: [{ id: 'submit', label: 'Submit', style: 'primary' }],
      }
      this.remote.set(id, {
        notice,
        externalSessionId: payload.sessionId,
        muxRpcId: envelope.rpcId,
        kind: 'user_question',
        questions: payload.questions,
      })
      await this.emit(notice)
      return
    }
    if (payload.type !== 'approval/resolved' && payload.type !== 'question/resolved') return
    const remote = [...this.remote.entries()].find(([, item]) => item.externalSessionId === payload.sessionId
      && (payload.type === 'approval/resolved'
        ? item.approvalId === payload.approvalId
        : item.muxRpcId === payload.questionRpcId))
    if (remote === undefined) return
    const [id, item] = remote
    this.remote.delete(id)
    await this.emit({ ...item.notice, responseRequired: false, status: 'closed' })
  }

  /** Validate an AA answer and prepare the corresponding Web response envelope. */
  prepareRemoteResponse(
    platformSessionId: string,
    externalSessionId: string,
    noticeIdValue: string,
    actionId: string,
    inputData: unknown,
  ): RemoteInteractionResponse | undefined {
    const pending = this.remote.get(noticeIdValue)
    if (pending === undefined) return undefined
    if (pending.notice.sessionId !== platformSessionId || pending.externalSessionId !== externalSessionId) {
      throw new BridgeError('INTERACTION_ALREADY_CLOSED', 'The interaction does not belong to this Session.', {
        retryable: false,
        sessionId: platformSessionId,
        externalSessionId,
      })
    }
    let value: unknown
    if (pending.kind === 'approval') {
      if (actionId !== 'allow_once' && actionId !== 'reject') {
        throw new BridgeError('INVALID_PARAMS', 'Approval action must be allow_once or reject.', { retryable: false })
      }
      value = {
        sessionId: pending.externalSessionId,
        approvalId: pending.approvalId,
        outcome: actionId === 'allow_once' ? 'allowed-once' : 'rejected',
      }
    } else {
      if (actionId !== 'submit') {
        throw new BridgeError('INVALID_PARAMS', 'User-question action must be submit.', { retryable: false })
      }
      value = {
        sessionId: pending.externalSessionId,
        answer: validateQuestionAnswer(inputData, pending.questions ?? []),
      }
    }
    return {
      message: {
        type: 'client-response',
        sessionId: pending.externalSessionId,
        rpcId: pending.muxRpcId,
        result: { ok: true, value },
      },
      close: async () => {
        if (!this.remote.delete(noticeIdValue)) return
        await this.emit({ ...pending.notice, responseRequired: false, status: 'closed' })
      },
    }
  }

  /** Current Web interaction envelopes for one follower baseline. */
  webBaselines(externalSessionId: SessionController['externalSessionId']): BridgeMuxEnvelope[] {
    return [...this.pending.values()]
      .filter(pending => !pending.closed && pending.controller.externalSessionId === externalSessionId)
      .map(pending => this.requestedEnvelope(pending))
  }

  private async askApproval(controller: SessionController, request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.pending.size >= this.maxPending) return 'unavailable'
    const platformSessionId = controller.platformSessionId
    if (platformSessionId === undefined) return 'unavailable'
    const id = noticeId('approval', String(controller.externalSessionId), String(request.callId ?? randomUUID()))
    const approvalId = this.approvalIdFor(controller, request)
    const notice: InteractionNotice = {
      id,
      sessionId: platformSessionId,
      externalSessionId: String(controller.externalSessionId),
      type: 'interaction',
      interactionKind: 'approval',
      responseRequired: true,
      status: 'open',
      title: `Approve ${request.toolName}`,
      details: {
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      },
      actions: [
        { id: 'allow_once', label: 'Allow once', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
    }
    return await new Promise<ApprovalOutcome>((resolve) => {
      const abort = () => void this.cancel(id)
      const signal = combinedSignal(request.signal, this.shutdownSignal.signal)
      signal.addEventListener('abort', abort, { once: true })
      const pending: PendingApproval = {
        kind: 'approval',
        notice,
        controller,
        closed: false,
        muxRpcId: id,
        approvalId,
        abortCleanup: () => signal.removeEventListener('abort', abort),
        resolve,
      }
      this.pending.set(id, pending)
      if (signal.aborted) {
        void this.cancel(id)
        return
      }
      void controller.openInteraction(id, 'approval')
        .then(() => Promise.all([this.emit(notice), this.replicateRequested(pending)]))
        .catch(() => this.cancel(id))
    })
  }

  private async askQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    const controller = agent === undefined ? undefined : this.controllerForAgent(agent)
    if (controller === undefined || controller.platformSessionId === undefined) {
      throw new Error('AA user questions require an owned root Agent')
    }
    if (this.pending.size >= this.maxPending) throw new Error('AA interaction limit reached')
    const id = noticeId('user_question', String(controller.externalSessionId), randomUUID())
    const notice: InteractionNotice = {
      id,
      sessionId: controller.platformSessionId,
      externalSessionId: String(controller.externalSessionId),
      type: 'interaction',
      interactionKind: 'user_question',
      responseRequired: true,
      status: 'open',
      title: 'Question from DeepSeek Harness',
      details: { questions: request.questions },
      actions: [{ id: 'submit', label: 'Submit', style: 'primary' }],
    }
    return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const abort = () => void this.cancel(id)
      const signal = combinedSignal(request.signal, this.shutdownSignal.signal)
      signal.addEventListener('abort', abort, { once: true })
      const pending: PendingQuestion = {
        kind: 'user_question',
        notice,
        questions: request.questions,
        controller,
        closed: false,
        muxRpcId: id,
        abortCleanup: () => signal.removeEventListener('abort', abort),
        resolve,
        reject,
      }
      this.pending.set(id, pending)
      if (signal.aborted) {
        void this.cancel(id)
        return
      }
      void controller.openInteraction(id, 'user_question')
        .then(() => Promise.all([this.emit(notice), this.replicateRequested(pending)]))
        .catch(() => this.cancel(id))
    })
  }

  private async cancel(id: string): Promise<void> {
    const pending = this.pending.get(id)
    if (pending === undefined || pending.closed) return
    await this.close(pending, 'cancelled')
    await this.replicateResolved(pending, 'cancelled')
    if (pending.kind === 'approval') pending.resolve('cancelled')
    else pending.reject(new Error('The question was cancelled.'))
  }

  private async close(pending: PendingInteraction, status: 'closed' | 'cancelled'): Promise<void> {
    if (pending.closed) return
    pending.closed = true
    pending.abortCleanup()
    this.pending.delete(pending.notice.id)
    this.closed.add(pending.notice.id)
    if (this.closed.size > 1024) this.closed.delete(this.closed.values().next().value as string)
    await pending.controller.closeInteraction(pending.notice.id)
    await this.emit({ ...pending.notice, responseRequired: false, status })
  }

  private approvalIdFor(controller: SessionController, request: ApprovalRequest): string {
    const claimed = new Set([...this.pending.values()]
      .filter((pending): pending is PendingApproval => pending.kind === 'approval')
      .map(pending => pending.approvalId))
    const decided = new Set<string>()
    const events = controller.agent?.session.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'approval/decided') decided.add(String(event.data.id))
      if (event?.type !== 'approval/asked') continue
      const id = String(event.data.id)
      if (decided.has(id) || claimed.has(id)) continue
      if (String(event.data.callId ?? '') !== String(request.callId ?? '')) continue
      return id
    }
    return noticeId('approval-audit', String(controller.externalSessionId), String(request.callId ?? randomUUID()))
  }

  private async replicateRequested(pending: PendingInteraction): Promise<void> {
    const sessionId = pending.controller.externalSessionId
    await this.publishReplica(sessionId, this.requestedEnvelope(pending))
  }

  private requestedEnvelope(pending: PendingInteraction): BridgeMuxEnvelope {
    const sessionId = pending.controller.externalSessionId
    const payload = pending.kind === 'approval'
      ? {
          type: 'approval/requested' as const,
          sessionId,
          approvalId: pending.approvalId,
          toolName: String(pending.notice.details.toolName),
          ...(typeof pending.notice.details.callId === 'string' ? { callId: pending.notice.details.callId } : {}),
          ...(typeof pending.notice.details.reason === 'string' ? { reason: pending.notice.details.reason } : {}),
        }
      : { type: 'question/requested' as const, sessionId, questions: pending.questions }
    return { rpcId: pending.muxRpcId, payload }
  }

  private async replicateResolved(
    pending: PendingInteraction,
    outcome: 'allowed-once' | 'rejected' | 'answered' | 'cancelled',
  ): Promise<void> {
    const sessionId = pending.controller.externalSessionId
    const payload = pending.kind === 'approval'
      ? {
          type: 'approval/resolved' as const,
          sessionId,
          approvalId: pending.approvalId,
          outcome: outcome === 'answered' ? 'cancelled' as const : outcome,
        }
      : {
          type: 'question/resolved' as const,
          sessionId,
          questionRpcId: pending.muxRpcId,
          outcome: outcome === 'answered' ? 'answered' as const : 'cancelled' as const,
        }
    await this.publishReplica(sessionId, bridgeMuxEnvelope(payload))
  }

  private async publishReplica(sessionId: SessionController['externalSessionId'], envelope: BridgeMuxEnvelope): Promise<void> {
    try {
      await this.replicate(sessionId, envelope)
    } catch (error: unknown) {
      this.ctx.logger.warn(`agents-anywhere bridge failed to replicate an interaction: ${String(error)}`)
    }
  }
}

function validateQuestionAnswer(input: unknown, questions: readonly AskUserQuestionItem[]): AskUserQuestionAnswer {
  if (!isRecord(input)) throw invalidAnswer('inputData must be an object')
  const rawAnswers = arrayField(input, 'answers')
  const byId = new Map(questions.map(question => [question.id, question]))
  const seen = new Set<string>()
  const answers = rawAnswers.map((raw) => {
    if (!isRecord(raw)) throw invalidAnswer('each answer must be an object')
    const id = stringField(raw, 'id')
    const question = byId.get(id)
    if (question === undefined || seen.has(id)) throw invalidAnswer('answers must cover each question exactly once')
    seen.add(id)
    const selected = arrayField(raw, 'selected')
    if (!selected.every(item => typeof item === 'string')) throw invalidAnswer('selected must contain strings')
    const labels = selected as string[]
    if (question.multiSelect !== true && labels.length > 1) throw invalidAnswer('single-select question has multiple answers')
    const options = new Set((question.options ?? []).map(option => option.label))
    if (labels.some(label => !options.has(label))) throw invalidAnswer('selected contains an unknown option')
    const custom = raw.custom
    if (custom !== undefined && typeof custom !== 'string') throw invalidAnswer('custom must be a string')
    if (labels.length === 0 && (custom === undefined || custom.length === 0)) throw invalidAnswer('answer is empty')
    return { id, selected: labels, ...(custom === undefined ? {} : { custom }) }
  })
  if (seen.size !== questions.length) throw invalidAnswer('answers must cover every question')
  return { answers }
}

function invalidAnswer(message: string): BridgeError {
  return new BridgeError('INVALID_PARAMS', message, { retryable: false })
}

function noticeId(kind: string, externalSessionId: string, requestId: string): string {
  return `dsh_notice_${sha256Hex(`${kind}\0${externalSessionId}\0${requestId}`)}`
}

function combinedSignal(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  return first === undefined ? second : AbortSignal.any([first, second])
}
