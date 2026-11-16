// DSH-4 end to end: the plugin 3.0 in a real in-process DSH host, A's local socket listener
// (connector-ts/src/host/dsh-socket.ts) and the Connector's DSH plugin route on B's generic ACP
// engine (connector-ts/src/runtime/profiles/dsh/plugin). Skipped when connector-ts is not installed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'

const connectorTs = new URL('../../../connector-ts/', import.meta.url)
const skip = existsSync(new URL('node_modules/@agentclientprotocol/sdk/package.json', connectorTs)) ? false : 'connector-ts is not installed'

type Socket = typeof import('../../../connector-ts/src/host/dsh-socket.js')
type Route = typeof import('../../../connector-ts/src/runtime/profiles/dsh/plugin/route.js')
type Port = import('../../../connector-ts/src/application/ports/runtime-session.js').RuntimeEvent

async function until(check: () => boolean, label: string, ms = 8000) {
  for (let n = 0; n < ms / 10; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

function collect(events: AsyncIterable<Port>): Port[] {
  const seen: Port[] = []
  void (async () => { for await (const event of events) seen.push(event) })()
  return seen
}

async function fixture(options: { questions?: boolean, adapter?: TextAdapter } = {}) {
  const { DshBridgeListener } = await import(new URL('src/host/dsh-socket.ts', connectorTs).href) as Socket
  const { dshPluginRoute } = await import(new URL('src/runtime/profiles/dsh/plugin/route.ts', connectorTs).href) as Route
  // A short home: the socket lives under it and Unix socket paths are limited to ~104 bytes.
  const home = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'aa-ts-')))
  const adapter = options.adapter ?? new TextAdapter()
  const host = await nativeRuntime(home, async ctx => {
    await mountAgents(ctx, adapter)
    if (options.questions) await ctx.plugin(UserQuestionService).await()
    await ctx.plugin(Remotes).await()
  })
  const dir = join(home, '.agents-anywhere', 'dsh-bridge')
  await mkdir(dir, { recursive: true })
  const routes: ReturnType<Route['dshPluginRoute']>[] = []
  const listener = new DshBridgeListener({ dir, instanceId: 'c1', connectorVersion: '3.0.0-test',
    onConnection: connection => routes.push(dshPluginRoute(connection, 'rti_dsh')) })
  try {
    await listener.start()
    await until(() => routes.length === 1, 'the plugin dials the published socket')
  } catch (error) {
    await listener.stop().catch(() => undefined)
    await host.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
    throw error
  }
  return { home, adapter, ctx: host.ctx, native: host.ctx.agentsAnywhereRuntime.native, listener, route: routes[0]!, routes,
    async close() {
      await listener.stop()
      await host.ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    } }
}

test('the plugin route: hello, catalog, full replay with the same item IDs as history, AA-created session and prompt', { timeout: 60_000, skip }, async () => {
  const f = await fixture()
  try {
    assert.equal(f.route.hello.hostInstance, f.ctx.agentsAnywhereRuntime.acp.hostInstance)
    const handle = f.route.handle
    const listed = await handle.listNativeSessions()
    assert.ok(listed.sessions.some(item => item.nativeSessionId === 'native-main' && item.title === '官方原生会话'))
    const caps = new Map(handle.capabilities().items.map(item => [item.id, item.supported]))
    assert.equal(caps.get('session.steer'), true)
    assert.equal(caps.get('runtime.attachment'), true)

    // History read and full replay agree on every item ID.
    const history = await handle.readNativeHistory({ nativeSessionId: 'native-main', locator: f.home }, { limit: 0 })
    const main = await handle.open({ kind: 'existing', ref: { nativeSessionId: 'native-main', locator: f.home } }, { sessionId: 'sess_main', replay: 'full' })
    const replayed = collect(main.events)
    await until(() => replayed.filter(event => 'itemId' in event).length >= history.items.length, 'replay delivered')
    const ids = (events: readonly Port[]) => [...new Set(events.filter(event => 'itemId' in event).map(event => (event as { itemId: string }).itemId))]
    assert.deepEqual(ids(replayed), ids(history.items))
    const texts = replayed.filter(event => event.type === 'message.completed').map(event => event.type === 'message.completed' && [event.role, event.text])
    assert.deepEqual(texts, [['reasoning', '先查看目录'], ['assistant', '我来读取。']])
    await main.close()

    // AA creates a session under the native ID it assigns, and sends the first message.
    const native = 'aa_0123456789abcdef_platform-1'
    const session = await handle.open({ kind: 'new', spec: { cwd: f.home, preferredNativeSessionId: native } }, { sessionId: 'sess_new', replay: 'none' })
    assert.equal(session.nativeSessionId, native)
    const live = collect(session.events)
    const accepted = await session.prompt({ text: '你好' }, { deliveryId: 'd1', clientMessageId: 'cm-1' })
    assert.equal(accepted.outcome, 'accepted')
    await until(() => live.some(event => event.type === 'message.delta' && event.text === '你'), 'streamed delta')
    const streamed = live.find(event => event.type === 'message.delta' && event.role === 'assistant') as Extract<Port, { type: 'message.delta' }>
    f.adapter.release?.()
    await until(() => live.some(event => event.type === 'turn.ended'), 'turn ended')
    const committed = live.find(event => event.type === 'message.completed' && event.role === 'assistant') as Extract<Port, { type: 'message.completed' }>
    assert.equal(committed.text, '你好')
    assert.equal(committed.itemId, streamed.itemId, 'the committed message replaces its stream in place')
    assert.equal(live.find(event => event.type === 'turn.ended' && event.reason === 'end_turn') !== undefined, true)
    const user = live.find(event => event.type === 'message.completed' && event.role === 'user') as Extract<Port, { type: 'message.completed' }>
    assert.equal(live.filter(event => event.type === 'message.completed' && event.role === 'user').length, 1, 'the echo is not a second user item')
    await session.close()

    // Re-attaching with a full replay lands on the same items: no duplicate user or assistant message.
    const again = await handle.open({ kind: 'existing', ref: { nativeSessionId: native, locator: f.home } }, { sessionId: 'sess_new', replay: 'full' })
    const replay = collect(again.events)
    await until(() => replay.some(event => event.type === 'message.completed' && event.role === 'assistant'), 'replayed')
    assert.deepEqual(ids(replay).sort(), [user.itemId, committed.itemId].sort())
    await again.close()
  } finally { await f.close() }
})

test('the plugin route: approvals reach AA as interactions and are answered through respond', { timeout: 60_000, skip }, async () => {
  const f = await fixture()
  try {
    await until(() => f.native.approvals.available, 'approval stream available')
    const agentHandle = await f.ctx.agents.create({ sessionId: SessionId('approval-ts'), agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: f.home } })
    try {
      const agent = agentHandle.agent
      setApprovalPolicy(agent.session, 'ask')
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '执行受限操作' }] }), { surfaceOp: 'append' })
      await f.ctx.sessions.flush(agent.session)
      const session = await f.route.handle.open({ kind: 'existing', ref: { nativeSessionId: 'approval-ts', locator: f.home } }, { sessionId: 'sess_appr', replay: 'none' })
      const events = collect(session.events)
      const asked = f.ctx.approval.request({ agent, toolName: 'shell', reason: '需要访问工作区之外的文件' })
      await until(() => events.some(event => event.type === 'interaction.opened'), 'interaction opened')
      const opened = events.find(event => event.type === 'interaction.opened') as Extract<Port, { type: 'interaction.opened' }>
      assert.equal(opened.kind, 'approval')
      assert.deepEqual(opened.options?.map(option => option.id), ['allow-once', 'reject'])
      await session.respond(opened.interactionId, { kind: 'option', optionId: 'allow-once' })
      assert.equal(await asked, 'allowed-once')
      await session.close()
    } finally { await agentHandle.dispose() }
  } finally { await f.close() }
})

test('a reloaded plugin (same host instance) replaces its connection', { timeout: 30_000, skip }, async () => {
  const f = await fixture()
  try {
    // Republishing the rendezvous makes the plugin dial again with the same hostInstance.
    await f.listener.stop()
    await f.listener.start()
    await until(() => f.routes.length === 2, 'the plugin follows a restarted Connector')
    assert.equal(f.routes[1]!.hello.hostInstance, f.routes[0]!.hello.hostInstance)
    assert.equal(await Promise.race([f.routes[0]!.closed.then(() => 'closed'), delay(2000).then(() => 'open')]), 'closed')
  } finally { await f.close() }
})

test('the plugin route: DSH questions become forms and plan reviews become plan_review interactions', { timeout: 60_000, skip }, async () => {
  const f = await fixture({ questions: true })
  try {
    await until(() => f.native.questions.available, 'question consumer connected')
    const id = SessionId('questions-ts')
    const agentHandle = await f.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: f.home } })
    try {
      const agent = agentHandle.agent
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先问我' }] }), { surfaceOp: 'append' })
      await f.ctx.sessions.flush(agent.session)
      const session = await f.route.handle.open({ kind: 'existing', ref: { nativeSessionId: 'questions-ts', locator: f.home } }, { sessionId: 'sess_q', replay: 'none' })
      const events = collect(session.events)
      const opened = async (n: number) => {
        await until(() => events.filter(event => event.type === 'interaction.opened').length >= n, `interaction ${n} opened`)
        return events.filter(event => event.type === 'interaction.opened')[n - 1] as Extract<Port, { type: 'interaction.opened' }>
      }

      const asked = f.ctx.userQuestions.ask({ agent, questions: [{ id: 'q', question: '名称？' }] })
      const form = await opened(1)
      assert.equal(form.kind, 'form')
      assert.ok(form.schema, 'the form carries its JSON Schema')
      await session.respond(form.interactionId, { kind: 'form', action: 'accept', values: { answers: { q: { customText: 'A' } } } })
      assert.deepEqual(await asked, { answers: [{ id: 'q', selected: [], custom: 'A' }] })

      const review = f.ctx.userQuestions.ask({ agent, questions: [{ id: 'plan', question: '是否批准？', detail: '1. 读取\n2. 修改',
        intent: { kind: 'plan-review', approve: '批准计划' }, options: [{ label: '修改计划' }, { label: '批准计划' }] }] })
      const plan = await opened(2)
      assert.equal(plan.kind, 'plan_review')
      await session.respond(plan.interactionId, { kind: 'plan_review', action: 'approve' })
      assert.deepEqual(await review, { answers: [{ id: 'plan', selected: ['批准计划'] }] })

      // A question answered in DSH's own UI withdraws the AA form.
      const third = f.ctx.userQuestions.ask({ agent, questions: [{ id: 'q2', question: '颜色？' }] })
      const pending = await opened(3)
      const entry = f.native.questions.pendingEntries(String(id))[0]!
      assert.equal(await f.native.questions.answerEvent(entry.eventId, { kind: 'submit', input: { answers: { q2: { customText: '蓝' } } } }), 'resolved')
      await third
      await until(() => events.some(event => event.type === 'interaction.resolved' && event.interactionId === pending.interactionId), 'AA form withdrawn')
      await session.close()
    } finally { await agentHandle.dispose() }
  } finally { await f.close() }
})

class VisionAdapter extends TextAdapter {
  override async resolveModel(provider: string, model: string) {
    return { ...await super.resolveModel(provider, model), inputModalities: ['text' as const, 'image' as const] }
  }
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4AWP8DwQMQMDEAAUAPfgEADYYS7QAAAAASUVORK5CYII='

test('the plugin route: images and staged files from AA reach the DSH model; files outside the staging directory are refused', { timeout: 60_000, skip }, async () => {
  const adapter = new VisionAdapter()
  const f = await fixture({ adapter })
  try {
    const session = await f.route.handle.open({ kind: 'new', spec: { cwd: f.home, preferredNativeSessionId: 'aa_0123456789abcdef_image-1' } }, { sessionId: 'sess_img', replay: 'none' })
    const live = collect(session.events)
    const accepted = await session.prompt({ text: '看图', attachments: [{ kind: 'inline', mimeType: 'image/png', data: png, name: 'a.png' }] },
      { deliveryId: 'd1', clientMessageId: 'cm-img' })
    assert.equal(accepted.outcome, 'accepted')
    await until(() => adapter.requests.length > 0, 'the model was asked')
    const sent = JSON.stringify(adapter.requests[0]!.messages)
    assert.ok(sent.includes('image'), 'the image block reached the model')
    adapter.release?.()
    await until(() => live.some(event => event.type === 'turn.ended'), 'turn ended')
    // Files: the Connector stages them under its data directory; the plugin uploads them to DSH.
    const fs = await import('node:fs/promises')
    const staged = join(f.home, '.agents-anywhere', 'dsh-bridge', 'uploads', 'note.txt')
    await fs.mkdir(join(staged, '..'), { recursive: true })
    await fs.writeFile(staged, 'hello')
    const uploaded = await session.prompt({ text: '读文件', attachments: [{ kind: 'file', path: staged, mimeType: 'text/plain' }] },
      { deliveryId: 'd2', clientMessageId: 'cm-file' })
    assert.equal(uploaded.outcome, 'accepted')
    await until(() => adapter.requests.length > 1, 'the model was asked again')
    assert.ok(JSON.stringify(adapter.requests[1]!.messages).includes('note.txt'), 'the uploaded file reached the model')
    adapter.release?.()
    await until(() => live.filter(event => event.type === 'turn.ended').length >= 2, 'second turn ended')
    // A file outside the staging directory is refused before anything is uploaded.
    const outside = join(f.home, 'outside.txt')
    await fs.writeFile(outside, 'x')
    const refused = await session.prompt({ text: '读文件', attachments: [{ kind: 'file', path: outside, mimeType: 'text/plain' }] },
      { deliveryId: 'd3', clientMessageId: 'cm-outside' })
    assert.equal(refused.outcome, 'rejected')
    assert.equal(refused.outcome === 'rejected' && refused.error.code, 'invalid_argument')
    await session.close()
  } finally { await f.close() }
})
