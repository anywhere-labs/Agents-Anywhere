import { AgentCard, Part, Role, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk'
import { JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import { JsonRpcTransportHandler, ServerCallContext, type A2ARequestHandler } from '@a2a-js/sdk/server'
import type { AgentActorRef, GatewayResponse, SessionGateway } from '../application/ports/index.js'
import type { ReviewAdmission, ReviewExecutionUseCases, ReviewTaskSnapshot, ReviewWorker } from '../application/ports/review.js'
import { CollabError } from '../domain/collab/errors.js'
import { type ReviewTarget } from '../domain/collab/review.js'
import {
  object, readReviewRequest, readReviewResult, REVIEW_ARTIFACT, REVIEW_REQUEST, REVIEW_RESUME,
  type ReviewExecution, type ReviewExecutionPhase, type ReviewRequest,
} from '../domain/collab/review-execution.js'

const state: Record<ReviewExecutionPhase, TaskState> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
}

export const reviewRpcPath = (device: string): string => `connectors/${encodeURIComponent(device)}/a2a/review`
const cardPath = (device: string): string => `connectors/${encodeURIComponent(device)}/a2a/agent-card.json`

export function reviewAgentCard(url: string): AgentCard {
  return AgentCard.fromJSON({
    name: 'Agents Anywhere Code Review', description: 'Review a pinned Git commit in an independent read-only session.',
    version: '1.0.0', supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { delegation: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
    securityRequirements: [{ schemes: { delegation: { list: [] } } }],
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'review-code', name: 'Review code', description: 'Review a candidate SHA against its base and return blocking findings.', tags: ['git', 'code-review'] }],
  })
}

function taskView(execution: ReviewExecution, deviceId: string, includeArtifacts = true): Task {
  const { id, contextId, sessionId, updatedAt, revision, result, request, attention } = execution
  return Task.fromJSON({
    id, contextId,
    metadata: { 'aa.review': { revision, reviewer: { deviceId, sessionId }, ...(attention === undefined ? {} : { attention }) } },
    status: { state: state[execution.phase], timestamp: updatedAt, ...(attention === undefined ? {} : {
      message: { messageId: `${id}:${revision}`, taskId: id, contextId, role: Role.ROLE_AGENT, parts: [{ text: attention.message }] },
    }) },
    artifacts: !includeArtifacts || execution.phase !== 'completed' || result === undefined ? [] : [{
      artifactId: `${id}:result`, name: 'Code review', extensions: [],
      parts: [{ data: { schema: REVIEW_ARTIFACT, runId: request.runId, round: request.round, sha: request.sha, ...result }, mediaType: 'application/json' }],
    }],
  })
}

function dataOf(parts: Part[]): unknown {
  const part = parts.find(part => part.content?.$case === 'data')
  return part?.content?.value
}

function unsupported(): never {
  throw new UnsupportedOperationError('This review agent supports polling and does not offer streaming or push notifications.')
}

export class A2AReviewHandler {
  public constructor(
    private readonly service: ReviewExecutionUseCases,
    private readonly deviceId: string,
    private readonly card: AgentCard,
    private readonly authorize: (actor: AgentActorRef, delegation: string | undefined, request?: ReviewRequest) => Promise<ReviewAdmission>,
  ) {}

  public async request(actor: AgentActorRef, delegation: string | undefined, method: string, payload: unknown): Promise<unknown> {
    const admission = await this.authorize(actor, delegation)
    if (method === 'GET') return AgentCard.toJSON(this.card)
    const task = async (id: string): Promise<ReviewExecution> => {
      const found = await this.service.get(actor, id)
      if (found === null) throw new TaskNotFoundError()
      await this.authorize(actor, delegation, found.request)
      return found
    }
    const handler: A2ARequestHandler = {
      getAgentCard: async () => this.card,
      getAuthenticatedExtendedAgentCard: async () => unsupported(),
      sendMessage: async ({ message, configuration }) => {
        if (message?.role !== Role.ROLE_USER || !message.messageId || message.messageId.length > 256 || configuration?.taskPushNotificationConfig !== undefined) {
          throw new RequestMalformedError('A review requires a user message with a stable message ID.')
        }
        const payload = object(dataOf(message.parts))
        let execution: ReviewExecution
        if (payload.schema === REVIEW_RESUME && message.taskId && message.contextId) {
          await task(message.taskId)
          const resumed = await this.service.resume(actor, message.taskId, message.contextId, message.messageId).catch(malformed)
          if (resumed === null) throw new TaskNotFoundError()
          execution = resumed
        } else {
          if (message.taskId || message.contextId) throw new RequestMalformedError('Use the resume message to continue a review.')
          let request: ReviewRequest
          try { request = readReviewRequest(payload) } catch (error) { return malformed(error) }
          const scope = await this.authorize(actor, delegation, request)
          execution = await this.service.accept(actor, message.messageId, request, scope).catch(malformed)
        }
        void this.service.tick().catch(() => undefined)
        if (configuration?.returnImmediately !== true) {
          while (execution.phase === 'submitted' || execution.phase === 'working') {
            await new Promise<void>(resolve => setTimeout(resolve, 500))
            execution = await task(execution.id)
          }
        }
        return taskView(execution, this.deviceId)
      },
      getTask: async ({ id }) => taskView(await task(id), this.deviceId),
      cancelTask: async ({ id }) => {
        await task(id)
        const canceled = await this.service.cancel(actor, id, admission.interrupt).catch(() => { throw new TaskNotCancelableError() })
        if (canceled === null) throw new TaskNotFoundError()
        return taskView(canceled, this.deviceId)
      },
      listTasks: async ({ contextId, status, statusTimestampAfter, pageSize = 50, pageToken, includeArtifacts }) => {
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || (pageToken && !/^\d+$/u.test(pageToken))) throw new RequestMalformedError('Invalid review page.')
        const candidates = (await this.service.list(actor)).filter(row => (!contextId || row.contextId === contextId)
          && (!status || state[row.phase] === status) && (!statusTimestampAfter || row.updatedAt >= statusTimestampAfter))
        const rows: ReviewExecution[] = []
        const admitted = new Map<string, boolean>()
        for (const row of candidates) {
          const key = JSON.stringify([row.request.projectId, row.request.cwd])
          const allowed = admitted.get(key) ?? await this.authorize(actor, delegation, row.request).then(() => true, () => false)
          admitted.set(key, allowed)
          if (allowed) rows.push(row)
        }
        const offset = Number(pageToken || '0')
        return {
          tasks: rows.slice(offset, offset + pageSize).map(row => taskView(row, this.deviceId, includeArtifacts === true)),
          pageSize, totalSize: rows.length, nextPageToken: offset + pageSize < rows.length ? String(offset + pageSize) : '',
        }
      },
      sendMessageStream: async function* () { unsupported() },
      resubscribe: async function* () { unsupported() },
      createTaskPushNotificationConfig: async () => unsupported(),
      getTaskPushNotificationConfig: async () => unsupported(),
      listTaskPushNotificationConfigs: async () => unsupported(),
      deleteTaskPushNotificationConfig: async () => unsupported(),
    }
    const response = await new JsonRpcTransportHandler(handler).handle(typeof payload === 'string' ? payload : object(payload), new ServerCallContext({ requestedVersion: '1.0' }))
    if (Symbol.asyncIterator in response) return response.next().then(item => item.value)
    return response
  }
}

function malformed(error: unknown): never {
  throw new RequestMalformedError(error instanceof Error ? error.message : 'Invalid review request.')
}

function gatewayError(response: GatewayResponse): never {
  const detail = object(object(response.body).detail)
  const unavailable = response.status === 404 || response.status === 405 || detail.code === 'agent_route_denied'
  throw Object.assign(new Error(unavailable ? 'Upgrade the reviewer device and Server to start A2A review.' : String(detail.message ?? 'The review device could not be reached.')),
    { code: unavailable ? 'review_a2a_upgrade_required' : String(detail.code ?? 'review_a2a_unavailable') })
}

function snapshot(task: Task): ReviewTaskSnapshot {
  const phase = Object.entries(state).find(([, value]) => value === task.status?.state)?.[0] as ReviewExecutionPhase | undefined
  const meta = object(task.metadata?.['aa.review'])
  const reviewer = object(meta.reviewer)
  const attention = object(meta.attention)
  const target = object(attention.target)
  if (!task.id || !task.contextId || phase === undefined || typeof meta.revision !== 'number' || !Number.isSafeInteger(meta.revision)) {
    throw new CollabError('invalid_argument', 'The review device returned an invalid A2A task.')
  }
  const artifact = task.artifacts.find(item => object(dataOf(item.parts)).schema === REVIEW_ARTIFACT)
  const data = object(artifact === undefined ? undefined : dataOf(artifact.parts))
  return {
    taskId: task.id, contextId: task.contextId, phase, revision: meta.revision,
    ...(typeof reviewer.deviceId === 'string' && typeof reviewer.sessionId === 'string' ? { reviewer: { deviceId: reviewer.deviceId, sessionId: reviewer.sessionId } } : {}),
    ...(typeof attention.code === 'string' && typeof attention.message === 'string' ? {
      attention: {
        code: attention.code, message: attention.message,
        ...(typeof target.deviceId === 'string' && typeof target.sessionId === 'string' ? { target: { deviceId: target.deviceId, sessionId: target.sessionId } } : {}),
        ...(typeof attention.noticeId === 'string' ? { noticeId: attention.noticeId } : {}),
      },
    } : {}),
    ...(artifact !== undefined && artifact.artifactId && typeof data.runId === 'string' && typeof data.round === 'number' && typeof data.sha === 'string'
      ? { result: { ...readReviewResult(data), runId: data.runId, round: data.round, sha: data.sha, artifactId: artifact.artifactId } } : {}),
  }
}

export class A2AReviewWorker implements ReviewWorker {
  public constructor(private readonly gateway: Pick<SessionGateway, 'request'>) {}

  public submit(actor: AgentActorRef, target: ReviewTarget, messageId: string, request: ReviewRequest): Promise<ReviewTaskSnapshot> {
    return this.send(actor, target, messageId, { schema: REVIEW_REQUEST, ...request })
  }

  public resume(actor: AgentActorRef, target: ReviewTarget, taskId: string, contextId: string, messageId: string): Promise<ReviewTaskSnapshot> {
    return this.send(actor, target, messageId, { schema: REVIEW_RESUME }, taskId, contextId)
  }

  public async get(actor: AgentActorRef, target: ReviewTarget, taskId: string): Promise<ReviewTaskSnapshot> {
    return snapshot(await (await this.transport(actor, target)).getTask({ id: taskId, tenant: '', historyLength: 0 }))
  }

  public async cancel(actor: AgentActorRef, target: ReviewTarget, taskId: string): Promise<ReviewTaskSnapshot> {
    return snapshot(await (await this.transport(actor, target)).cancelTask({ id: taskId, tenant: '', metadata: undefined }))
  }

  private async send(actor: AgentActorRef, target: ReviewTarget, messageId: string, payload: unknown, taskId?: string, contextId?: string): Promise<ReviewTaskSnapshot> {
    const result = await (await this.transport(actor, target)).sendMessage(SendMessageRequest.fromJSON({
      message: { messageId, role: Role.ROLE_USER, parts: [{ data: payload, mediaType: 'application/json' }], ...(taskId === undefined ? {} : { taskId }), ...(contextId === undefined ? {} : { contextId }) },
      configuration: { returnImmediately: true, historyLength: 0 },
    }))
    if (!('status' in result)) throw new CollabError('invalid_argument', 'The review device did not return an A2A task.')
    return snapshot(result)
  }

  private async transport(actor: AgentActorRef, target: ReviewTarget) {
    const response = await this.gateway.request(target.deviceId, actor, { method: 'GET', path: cardPath(target.deviceId) })
    if (response.status !== 200) return gatewayError(response)
    const card = AgentCard.fromJSON(object(response.body))
    const binding = card.supportedInterfaces.find(item => item.protocolBinding === 'JSONRPC' && item.protocolVersion === '1.0')
    if (binding === undefined || !card.skills.some(skill => skill.id === 'review-code')) {
      throw Object.assign(new Error('The selected device does not advertise A2A 1.0 code review.'), { code: 'review_a2a_upgrade_required' })
    }
    return new JsonRpcTransportFactory({
      fetchImpl: async (_url, init) => {
        const reply = await this.gateway.request(target.deviceId, actor, {
          method: 'POST', path: reviewRpcPath(target.deviceId), body: JSON.parse(String(init?.body ?? '{}')),
        })
        if (reply.status !== 200) gatewayError(reply)
        return Response.json(reply.body)
      },
    }).create(binding.url, card)
  }
}
