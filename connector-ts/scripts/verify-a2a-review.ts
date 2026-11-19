import assert from 'node:assert/strict'
import { AgentCard, SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { JsonRpcTransportFactory } from '@a2a-js/sdk/client'

import type { AgentActorRef, SessionGateway } from '../src/application/ports/index.js'
import type { ReviewExecutionRepository } from '../src/application/ports/review.js'
import type { ReviewExecution, ReviewRequest } from '../src/domain/collab/review-execution.js'
import { issueGrant, type TargetStatus } from '../src/domain/collab/index.js'
import { ReviewService } from '../src/application/collab/review-service.js'
import { ReviewExecutionService } from '../src/application/collab/review-execution-service.js'
import { A2AReviewHandler, A2AReviewWorker, reviewAgentCard } from '../src/peer/a2a-review.js'
import { CollabError } from '../src/domain/collab/errors.js'
import { recordCandidate, recordVerdict, startCandidateReview, type ReviewDecision, type ReviewRun } from '../src/domain/collab/review.js'

const jobs = new Map<string, ReviewExecution>()
const repository: ReviewExecutionRepository = {
  get: async id => jobs.get(id) ?? null,
  list: async () => [...jobs.values()],
  bySession: async id => [...jobs.values()].find(item => item.sessionId === id) ?? null,
  save: async row => { jobs.set(row.id, structuredClone(row)) },
}
const sessions = new Set<string>()
const actor = { deviceId: 'source', sessionId: 'main', grantId: 'grant' }
const target = { deviceId: 'reviewer', runtimeId: 'claude-1', cwd: '/project' }
let launches = 0
let viewStatus: TargetStatus = 'running'
let checkoutAvailable = true
let modelTimeout = false
const gateway: Pick<SessionGateway, 'facts' | 'notices' | 'request'> = {
  facts: async address => sessions.has(address.sessionId) ? {
    address, signal: {
      status: viewStatus, headSeq: 1, resetSeq: 0, latestTurnEndSeq: viewStatus === 'idle' ? 1 : 0,
      planState: 'none', goalState: 'none', deviceOnline: true, at: new Date().toISOString(),
    },
    title: null, runtimeType: 'claude', runtimeId: target.runtimeId, cwd: target.cwd,
    createdBySessionId: actor.sessionId, depth: 1,
  } : null,
  notices: async () => viewStatus === 'waiting_approval'
    ? [{ id: 'real-notice', title: 'Approve the review read', kind: 'approval', options: [] }]
    : [],
  request: async (_device, actor, request) => ({
    status: 200, body: await handler.request(actor, 'delegation', request.method, request.body),
  }),
}
const runtime = {
  launch: async (row: ReviewExecution) => {
    if (!checkoutAvailable) throw new CollabError('review_commit_unavailable', 'The candidate is missing.')
    launches++
    sessions.add(row.sessionId)
  },
  verify: async () => {},
  failure: async () => modelTimeout ? ('timeout' as const) : undefined,
  interrupt: async () => { viewStatus = 'idle' },
}
const service = () => new ReviewExecutionService(repository, target.deviceId, { nowIso: () => new Date().toISOString(), nowMs: Date.now }, gateway, runtime, console.error)
let executions = service()
let handler: A2AReviewHandler
const permission = async (who: AgentActorRef, token?: string, request?: ReviewRequest) => {
  assert.equal(token, 'delegation')
  assert.equal(who.deviceId, 'source')
  return { depth: 1, interrupt: who.grantId === 'grant', ...(request ? { project: { id: 'project', cwd: '/project' } } : {}) }
}
const card = reviewAgentCard('https://agents.example/a2a/review')
handler = new A2AReviewHandler(executions, target.deviceId, card, permission)
const wireCard = AgentCard.fromJSON(await handler.request(actor, 'delegation', 'GET', null))
const binding = wireCard.supportedInterfaces[0]
assert.ok(binding)
assert.equal(binding.protocolBinding, 'JSONRPC')
assert.equal(binding.protocolVersion, '1.0')
assert.ok(wireCard.securitySchemes.delegation)
const client = await new JsonRpcTransportFactory({
  fetchImpl: async (_url, init) => Response.json(await handler.request(actor, 'delegation', 'POST', JSON.parse(String(init?.body)))),
}).create(binding.url, wireCard)
const request = { runtimeId: target.runtimeId, cwd: target.cwd, runId: 'review_' + '1'.repeat(32), base: 'a'.repeat(40), sha: 'b'.repeat(40), round: 1, requirement: 'Review', remote: 'origin' }
const message = SendMessageRequest.fromJSON({ message: { role: 'ROLE_USER', messageId: 'first', parts: [{ data: { ...request, schema: 'aa.review.request.v1' } }] }, configuration: { returnImmediately: true } })
const first = await client.sendMessage(message)
assert.ok('id' in first && first.id)
const retried = await client.sendMessage(message)
assert.ok('id' in retried)
assert.equal(first.id, retried.id)
assert.equal(first.contextId, retried.contextId)
assert.ok(message.message)
const competing = await client.sendMessage({ ...message, message: { ...message.message, messageId: 'competing' } })
assert.ok('id' in competing)
assert.equal(first.id, competing.id)
const wrongCandidate = SendMessageRequest.fromJSON({
  message: { role: 'ROLE_USER', messageId: 'wrong-sha', parts: [{ data: { ...request, schema: 'aa.review.request.v1', sha: 'd'.repeat(40) } }] },
  configuration: { returnImmediately: true },
})
await assert.rejects(client.sendMessage(wrongCandidate))
assert.equal(launches, 1)
executions = service()
handler = new A2AReviewHandler(executions, target.deviceId, card, permission)
const worker = new A2AReviewWorker(gateway)
const persisted = await worker.get(actor, target, first.id)
assert.equal(persisted.taskId, first.id)
assert.ok(persisted.reviewer)
viewStatus = 'waiting_approval'
await executions.tick()
assert.equal((await worker.get(actor, target, first.id)).attention?.noticeId, 'real-notice')
await assert.rejects(executions.submit('spoof-session', { verdict: 'approved', summary: 'spoof', blockers: [] }))
assert.equal(await executions.get({ ...actor, sessionId: 'other' }, first.id), null)
const records = await client.listTasks({ tenant: '', contextId: first.contextId, status: TaskState.TASK_STATE_INPUT_REQUIRED, pageToken: '', statusTimestampAfter: undefined })
assert.equal(records.totalSize, 1)
viewStatus = 'running'
await executions.submit(persisted.reviewer.sessionId, { verdict: 'changes_requested', summary: 'One blocker', blockers: [{ description: 'Overflow', evidence: 'src/file.ts:12' }] })
viewStatus = 'idle'
await executions.tick()
const done = await client.getTask({ id: first.id, tenant: '', historyLength: 0 })
assert.equal(done.status?.state, TaskState.TASK_STATE_COMPLETED)
const artifact = done.artifacts[0]?.parts[0]?.content
assert.equal(artifact?.$case, 'data')
assert.equal(artifact.value.sha, request.sha)
assert.equal((await worker.get(actor, target, first.id)).result?.verdict, 'changes_requested')
viewStatus = 'running'

const next = await worker.submit(actor, target, 'second', { ...request, round: 2, sha: 'c'.repeat(40) })
assert.notEqual(next.taskId, first.id)
await executions.tick()
await assert.rejects(worker.cancel({ ...actor, grantId: 'read-only' }, target, next.taskId))
const canceled = await worker.cancel(actor, target, next.taskId)
assert.equal(canceled.phase, 'canceled')
assert.equal(launches, 2)
viewStatus = 'running'

checkoutAvailable = false
const missing = await worker.submit(actor, target, 'missing', { ...request, round: 3, sha: 'e'.repeat(40) })
const missingState = await until(async () => {
  await executions.tick()
  const status = await worker.get(actor, target, missing.taskId)
  return status.attention?.code === 'review_commit_unavailable' ? status : undefined
})
assert.equal(missingState.phase, 'input-required')
checkoutAvailable = true
const resumed = await worker.resume(actor, target, missing.taskId, missing.contextId, 'resume')
assert.equal(resumed.taskId, missing.taskId)
await until(async () => {
  await executions.tick()
  return launches === 3 || undefined
})
const replay = await worker.resume(actor, target, missing.taskId, missing.contextId, 'resume')
assert.equal(replay.taskId, missing.taskId)
assert.equal(launches, 3)

const implementation = { deviceId: 'source', runtimeId: 'codex-1', cwd: '/project' }
const candidate = {
  sha: request.sha, implementation: { itemId: 'implementation', seq: 5 },
  changes: { summary: 'change', patch: '', truncated: false },
  checks: [], checksComplete: false,
}
const run = startCandidateReview(recordCandidate({
  id: request.runId, phase: 'implementing', requirement: request.requirement, base: request.base, remote: request.remote,
  implementation, review: target, rounds: [], since: 0, attempt: 0,
}, candidate), persisted.reviewer)
const decision: ReviewDecision = { verdict: 'approved', summary: 'Looks good', blockers: [], itemId: 'review', seq: 6 }
assert.throws(() => recordVerdict(run, 'd'.repeat(40), decision))
assert.equal(recordVerdict(run, request.sha, decision).phase, 'returning')
assert.throws(() => recordCandidate({ ...run, phase: 'implementing' }, candidate))
modelTimeout = true
viewStatus = 'idle'
await executions.tick()
const failure = await worker.get(actor, target, missing.taskId)
assert.equal(failure.phase, 'failed')
assert.equal(failure.attention?.code, 'review_model_timeout')
let saved: ReviewRun = {
  ...run,
  rounds: run.rounds.map(round => ({
    ...round, task: { messageId: 'missing', taskId: failure.taskId, contextId: failure.contextId },
  })),
}
let offline = false
let resumedMessageId: string | undefined
const coordinator = new ReviewService({
  sessions: { get: async () => null },
  runs: {
    get: async () => structuredClone(saved),
    unfinishedDispatches: async () => [{ sessionId: actor.sessionId, run: structuredClone(saved) }],
    save: async (_sessionId, run) => { saved = structuredClone(run) },
  },
  gateway: { facts: gateway.facts, notices: gateway.notices, observe: async () => assert.fail('Unexpected timeline observation') },
  worker: {
    get: async () => {
      if (offline) throw Object.assign(new Error('Reviewer is offline'), { code: 'connector_offline' })
      return failure
    },
    submit: async (_actor, _target, messageId) => {
      if (offline) {
        resumedMessageId = messageId
        throw Object.assign(new Error('Reviewer is offline'), { code: 'connector_offline' })
      }
      assert.equal(messageId, resumedMessageId)
      return { taskId: 'retried', contextId: 'retried', revision: 1, phase: 'working', reviewer: persisted.reviewer! }
    },
    cancel: async () => assert.fail('Unexpected cancellation'),
    resume: async () => assert.fail('Unexpected resume'),
  },
  git: { base: async () => assert.fail('Unexpected Git lookup'), validateCandidate: async () => assert.fail('Unexpected candidate check') },
  publish: async () => {},
})
const grant = issueGrant({ grantId: actor.grantId, supervisor: actor, crossDevice: true, secretDigest: 'test', at: new Date().toISOString() })
const actions = { spawn: async () => assert.fail('Unexpected spawn'), send: async () => assert.fail('Unexpected send') }
const driver = async () => ({ grant, actions })
await coordinator.poll(driver)
assert.equal((await coordinator.read(actor.sessionId))?.phase, 'review_failed')
offline = true
await coordinator.poll(driver)
const failedRetry = await coordinator.run(grant, { action: 'advance' }, actions)
assert.deepEqual([failedRetry.phase, failedRetry.attention], ['review_failed', failure.attention])
offline = false
await coordinator.poll(driver)
const recovered = await coordinator.read(actor.sessionId)
assert.deepEqual([recovered?.phase, recovered?.attention], ['reviewing', null])
console.log('A2A code review acceptance passed')

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await check()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('The review execution did not reach its expected state.')
}
