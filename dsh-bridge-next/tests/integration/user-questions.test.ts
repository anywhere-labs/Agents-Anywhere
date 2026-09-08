import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as AskUserTool from '@deepseek-ai/dsh-tool-ask-user'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, initialSelections } from '../fixtures/agent-runtime.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { SyncFeed, type SyncBatch } from '../../src/host/dsh-runtime/sync.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import type { Context } from '@deepseek-ai/cordis'
import { UserQuestions } from '../../src/host/dsh-runtime/questions.js'

const questions = [
  { id: 'mode', question: '选择模式', options: [{ label: '标准' }, { label: '快速' }] },
  { id: 'targets', question: '选择平台', multi_select: true, options: [{ label: 'Web' }, { label: 'Android' }] },
  { id: 'notes', question: '其他要求' },
]
const input = { answers: { mode: { optionIds: ['o_1'] }, targets: { optionIds: ['o_0', 'o_1'], customText: 'iOS' }, notes: { customText: '简洁' } } }
const expected = { answers: [{ id: 'mode', selected: ['快速'] }, { id: 'targets', selected: ['Web', 'Android'], custom: 'iOS' }, { id: 'notes', selected: [], custom: '简洁' }] }

class QuestionAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const call = { type: 'tool-call' as const, id: ToolCallId(randomUUID()), name: 'ask_user_question', arguments: JSON.stringify({ questions }) }
    if (this.requests.length % 2 === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call', id: call.id, name: call.name }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '收到回答，继续执行。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到回答，继续执行。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'aa-questions-'))
  const adapter = new QuestionAdapter()
  const native = await nativeRuntime(home, async ctx => {
    await mountAgents(ctx, adapter)
    // Real Connection RPC/Gateway; browser auth is never consulted by the local carrier.
    new HostConnectionService(ctx, [], undefined as never)
    await ctx.plugin(UserQuestionService).await()
    await ctx.plugin(AskUserTool).await()
    await ctx.plugin(Remotes).await()
  })
  const runtime = native.ctx.agentsAnywhereRuntime.native
  await until(() => runtime.questions.available, 'question consumer connected')
  const router = new RuntimeRouter({ native: runtime, query: native.ctx.sessionQuery, status: id => runtime.status(id) }, 'test')
  const request = (method: string, params: Record<string, unknown>) => router.request(method, params, new AbortController().signal)
  return { ...native, home, adapter, runtime, router, request, close: async () => {
    router.close(); await native.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  } }
}

async function remote(ctx: Context) {
  const abort = new AbortController()
  const stream = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, abort.signal))[Symbol.asyncIterator]()
  const ready = (await stream.next()).value as { clientId: string }
  const questions = new Set<unknown>()
  return { next: async () => {
    while (true) {
      const next = await stream.next()
      if (next.done) throw new Error('Remote stream ended before the expected question')
      const frame = next.value as Record<string, unknown>
      if (frame.event === 'user-questions/request') { questions.add(frame.eventId); return frame }
      if (frame.type === 'cancel' && questions.has(frame.eventId)) return frame
    }
  }, close: () => abort.abort(),
    reply: async (eventId: string, outcome: unknown) => {
      const rpcId = randomUUID()
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1/api/$events/result', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: { clientId: ready.clientId, eventId, outcome } } }),
      }))
      assert.equal((await response.json()).result.ok, true)
    } }
}

test('published Host pauses the real ask_user_question tool, accepts platform answers and continues the agent', { timeout: 30_000 }, async () => {
  const f = await fixture()
  const id = SessionId('question-tool')
  const platformId = sessionId('test', id)
  const client = await remote(f.ctx)
  try {
    await f.runtime.send(id, '请先问我三个问题', 'message-1', f.home, true, initialSelections, 'standard')
    const agent = f.ctx.agents.get(id)!
    await until(() => f.runtime.questions.waiting(id), 'actual tool is waiting')
    const state = await f.request('session.getState', { sessionId: platformId }) as { status: string }
    assert.equal(state.status, 'waiting_approval')
    const notices = (await f.request('session.getNotices', { sessionId: platformId }) as { notices: any[] }).notices
    assert.equal(notices.length, 1)
    const notice = notices[0]!
    assert.equal(notice.actions[0].input.uiSchema.questions[1].multiple, true)
    assert.equal(notice.actions[0].input.uiSchema.component, 'inputRequest')
    await assert.rejects(f.request('session.respondInteraction', { sessionId: platformId, noticeId: notice.noticeId, actionId: 'submit', inputData: { answers: {} } }))
    assert.equal(f.runtime.questions.waiting(id), true)
    assert.equal((await f.request('session.respondInteraction', { sessionId: sessionId('test', 'native-main'), noticeId: notice.noticeId, actionId: 'cancel' }) as { ok: boolean }).ok, false)
    const result = await f.request('session.respondInteraction', { sessionId: platformId, noticeId: notice.noticeId, actionId: 'submit', inputData: input })
    assert.equal((result as { ok: boolean }).ok, true)
    await until(() => agent.session.snapshotEvents().some(e => e.type === 'turn/end'), 'agent continues after answer')
    const toolResult = agent.session.snapshotEvents().find(e => e.type === 'tool/result')
    assert.equal(toolResult?.type, 'tool/result')
    if (toolResult?.type === 'tool/result') {
      const block = toolResult.data.message.content.find(c => c.type === 'tool-result')!
      assert.equal(block.isError, false)
      assert.deepEqual(JSON.parse(block.content.find(c => c.type === 'text')!.text), expected)
    }
    assert.equal(f.runtime.questions.notices('test', id)[0]?.status, 'resolved')
    assert.equal((await f.request('session.respondInteraction', { sessionId: platformId, noticeId: notice.noticeId, actionId: 'submit', inputData: input }) as { ok: boolean }).ok, false)
    const nativeRequest = await client.next()
    assert.equal(nativeRequest.event, 'user-questions/request')
    assert.deepEqual(await client.next(), { type: 'cancel', eventId: nativeRequest.eventId })
    await f.runtime.send(id, '再问一组，这次取消', 'message-2')
    await until(() => f.runtime.questions.waiting(id), 'second real tool waits')
    const cancelled = f.runtime.questions.notices('test', id).find(n => n.status === 'open')!
    assert.equal((await f.request('session.respondInteraction', { sessionId: platformId, noticeId: cancelled.noticeId, actionId: 'cancel' }) as { ok: boolean }).ok, true)
    await until(() => agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length === 2, 'cancel follows the native tool error path')
    const cancelledResult = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result')!
    if (cancelledResult.type === 'tool/result') assert.equal(cancelledResult.data.message.content.find(c => c.type === 'tool-result')?.isError, true)
  } finally { client.close(); await f.close() }
})

test('native answers, whole-request cancellation, pending replay and Connector feed reconnect use the official pending request', { timeout: 30_000 }, async () => {
  const f = await fixture()
  const id = SessionId('question-reconnect')
  const platformId = sessionId('test', id)
  const client = await remote(f.ctx)
  const feeds: SyncFeed[] = []
  try {
    const handle = await f.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: f.home } })
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '请先问我问题' }] }), { surfaceOp: 'append' })
    const ask = (signal?: AbortSignal) => f.ctx.userQuestions.ask({ agent: handle.agent,
      questions: [{ id: 'q', question: '继续吗？', options: [{ label: '好' }] }], ...(signal ? { signal } : {}) })
    const first = ask()
    const event = await client.next()
    await until(() => f.runtime.questions.waiting(id), 'visible question')
    const noticeId = f.runtime.questions.notices('test', id)[0]!.noticeId
    const batches: SyncBatch[] = []
    const feed = new SyncFeed(f.runtime, 'test', batch => { batches.push(batch); queueMicrotask(() => feed.ack(batch.batchSeq)) }, error => assert.fail(String(error)))
    feeds.push(feed); feed.start()
    await until(() => JSON.stringify(batches).includes(noticeId), 'pending request in initial sync')
    feed.close()
    const replay = await remote(f.ctx)
    try { assert.equal((await replay.next()).eventId, event.eventId) } finally { replay.close() }
    const recovered: SyncBatch[] = []
    const nextFeed = new SyncFeed(f.runtime, 'test', batch => { recovered.push(batch); queueMicrotask(() => nextFeed.ack(batch.batchSeq)) }, error => assert.fail(String(error)))
    feeds.push(nextFeed); nextFeed.start()
    await until(() => JSON.stringify(recovered).includes(noticeId), 'same pending notice after Connector reconnect')
    await client.reply(event.eventId as string, { kind: 'result', value: { answers: [{ id: 'q', selected: ['好'] }] } })
    assert.deepEqual(await first, { answers: [{ id: 'q', selected: ['好'] }] })
    await until(() => !f.runtime.questions.waiting(id), 'native answer withdraws platform form')
    assert.equal((await f.request('session.respondInteraction', { sessionId: platformId, noticeId, actionId: 'cancel' }) as { ok: boolean }).ok, false)

    const cancelled = ask().then(() => assert.fail('must reject'), error => error)
    await client.next()
    await until(() => f.runtime.questions.waiting(id), 'next question')
    const pending = f.runtime.questions.notices('test', id).find(n => n.status === 'open')!
    assert.equal((await f.request('session.respondInteraction', { sessionId: platformId, noticeId: pending.noticeId, actionId: 'cancel' }) as { ok: boolean }).ok, true)
    assert.equal((await cancelled).code, 'ASK_CANCELLED')
    await client.next() // cancellation of the native UI's pending form

    const abort = new AbortController()
    const aborted = ask(abort.signal).then(() => assert.fail('must reject'), error => error)
    await client.next()
    await until(() => f.runtime.questions.waiting(id), 'abortable question')
    abort.abort()
    assert.equal((await aborted).code, 'ASK_ABORTED')
    await until(() => !f.runtime.questions.waiting(id), 'native interruption withdraws form')
    await client.next()

    const plan = f.ctx.userQuestions.ask({ agent: handle.agent, questions: [{ id: 'plan', question: '计划', detail: '步骤', intent: { kind: 'plan-review', approve: '好' }, options: [{ label: '好' }] }] })
    const planEvent = await client.next()
    await delay(30)
    assert.equal(f.runtime.questions.waiting(id), false)
    await client.reply(planEvent.eventId as string, { kind: 'result', value: { answers: [{ id: 'plan', selected: ['好'] }] } })
    await plan
    await handle.dispose()
  } finally { for (const feed of feeds) feed.close(); client.close(); await f.close() }
})

test('a question survives plugin consumer disposal and is replayed with the same ID; competing submissions resolve once', { timeout: 30_000 }, async () => {
  const f = await fixture()
  const id = SessionId('question-reload')
  let replacement: UserQuestions | undefined
  try {
    const handle = await f.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: f.home } })
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '请先问我问题' }] }), { surfaceOp: 'append' })
    const promise = f.ctx.userQuestions.ask({ agent: handle.agent, questions: [{ id: 'q', question: '名称？' }] })
    await until(() => f.runtime.questions.waiting(id), 'question before disposal')
    const originalId = f.runtime.questions.notices('test', id)[0]!.noticeId
    await f.runtime.questions.close()
    assert.equal(f.runtime.questions.available, false)
    replacement = new UserQuestions(f.ctx, value => f.runtime.visible(value), () => {})
    await until(() => replacement!.waiting(id), 'official pending replay after consumer replacement')
    assert.equal(replacement.notices('test', id)[0]!.noticeId, originalId)
    const results = await Promise.all([
      replacement.respond('test', id, originalId, 'submit', { answers: { q: { customText: 'A' } } }),
      replacement.respond('test', id, originalId, 'submit', { answers: { q: { customText: 'B' } } }),
    ])
    assert.equal(results.filter(r => r.ok).length, 1)
    assert.deepEqual(await promise, { answers: [{ id: 'q', selected: [], custom: 'A' }] })
    await handle.dispose()
  } finally { await replacement?.close(); await f.close() }
})

test('questions cross the Python adapter and existing backend notice/respond endpoints with takeover enforced', { timeout: 60_000 }, async () => {
  const f = await fixture()
  try {
    const result = await promisify(execFile)('uv', ['run', '--with-editable', '../connector', 'python', '../connector/tests/dsh_question_probe.py', f.home], {
      cwd: new URL('../../../server/', import.meta.url), timeout: 45_000,
    })
    assert.match(result.stdout, /DSH question pipeline passed/)
  } finally { await f.close() }
})
