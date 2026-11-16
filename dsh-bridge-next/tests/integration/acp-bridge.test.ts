// S7 prototype: the plugin speaks ACP to a Connector over the dsh-bridge 3.0 socket.
// A minimal fake Connector (ACP client) drives a real in-process DSH host.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as acp from '@agentclientprotocol/sdk'
import * as Remotes from '@deepseek-ai/dsh-api-remotes'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { createUserMessage, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { acpStream, parseRendezvousV3 } from '../../src/host/acp/link.js'
import { DSH_METHODS, type BridgeHello, type DshTurnNotification } from '../../src/contracts/bridge-v3.js'

async function until(check: () => boolean, label: string, ms = 5000) {
  for (let n = 0; n < ms / 10; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

/** The Connector half: listens, checks the hello key, then runs an ACP client per connection. */
class FakeConnector {
  server: Server
  key = `ak_${randomBytes(32).toString('hex')}`
  hellos: BridgeHello[] = []
  updates: acp.SessionNotification[] = []
  ext: { method: string, params: Record<string, unknown> }[] = []
  permissions: { params: acp.RequestPermissionRequest, answer: (value: acp.RequestPermissionResponse) => void }[] = []
  conn: acp.ClientSideConnection | undefined
  socket: Socket | undefined
  constructor(readonly socketPath: string) {
    this.server = createServer(socket => this.accept(socket))
  }
  async listen(rendezvousPath: string, instanceId = 'connector-1') {
    await new Promise<void>(resolve => this.server.listen(this.socketPath, resolve))
    await writeFile(rendezvousPath, JSON.stringify({ version: 3, protocol: 'acp', instanceId, pid: process.pid,
      endpoint: { unixPath: this.socketPath }, key: this.key }), { mode: 0o600 })
  }
  private accept(socket: Socket) {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) return
      socket.off('data', onData)
      socket.pause()
      const hello = JSON.parse(buffered.subarray(0, newline).toString()) as BridgeHello
      this.hellos.push(hello)
      if (hello.key !== this.key) {
        socket.end(`${JSON.stringify({ t: 'reject', code: 'bad_key', message: 'bad key' })}\n`)
        return
      }
      socket.write(`${JSON.stringify({ t: 'welcome', bridgeProtocol: '3.0', connectorInstance: 'connector-1', connectorVersion: '3.0.0-test' })}\n`)
      this.socket = socket
      const client: acp.Client = {
        requestPermission: params => new Promise(resolve => this.permissions.push({ params, answer: resolve })),
        sessionUpdate: async params => { this.updates.push(params) },
        extNotification: async (method, params) => { this.ext.push({ method, params }) },
        extMethod: async () => ({}),
      }
      this.conn = new acp.ClientSideConnection(() => client, acpStream(socket, buffered.subarray(newline + 1)))
    }
    socket.on('data', onData)
  }
  turns(sessionId: string) {
    return this.updates.filter(item => item.sessionId === sessionId && item.update.sessionUpdate === 'session_info_update')
      .map(item => (item.update as { _meta?: { dsh?: { turnEvent?: DshTurnNotification } } })._meta?.dsh?.turnEvent)
      .filter((item): item is DshTurnNotification => item !== undefined)
  }
  texts(sessionId: string, kind: string, filter: (meta: Record<string, unknown>) => boolean = () => true) {
    return this.updates.filter(item => item.sessionId === sessionId && item.update.sessionUpdate === kind
      && filter(((item.update as { _meta?: { dsh?: Record<string, unknown> } })._meta?.dsh) ?? {}))
      .map(item => ((item.update as { content?: { text?: string } }).content?.text ?? ''))
  }
  async close() {
    this.socket?.destroy()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

/** Fails the requests whose failure codes are queued, then replies like TextAdapter. */
class FlakyAdapter extends TextAdapter {
  failures: string[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const code = this.failures.shift()
    if (code === undefined) return yield* super.stream(options)
    this.requests.push(options)
    throw new LlmError('upstream unavailable', code)
  }
}

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'aa-acp-bridge-')))
  const adapter = new FlakyAdapter()
  const fixture = await nativeRuntime(home, async ctx => {
    await mountAgents(ctx, adapter)
    await ctx.plugin(Remotes).await()
  })
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const dir = join(home, '.agents-anywhere', 'dsh-bridge')
  await mkdir(dir, { recursive: true })
  const rendezvous = join(dir, 'connector-acp.json')
  const connector = new FakeConnector(join(home, 'acp.sock'))
  // The plugin's own 3.0 link (DshRuntimeService) follows the rendezvous in the fixture home.
  const link = fixture.ctx.agentsAnywhereRuntime.acp
  return { home, adapter, ctx: fixture.ctx, native, rendezvous, connector, link,
    async connect() {
      await connector.listen(rendezvous)
      link.start()
      await until(() => link.status.state === 'connected' && connector.conn !== undefined, 'plugin connected ' + JSON.stringify(link.status))
      const init = await connector.conn!.initialize({ protocolVersion: 1, clientCapabilities: {} })
      return init
    },
    async close() {
      await link.close(); await connector.close(); await fixture.ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    } }
}

test('rendezvous v3 parsing accepts only the ACP rendezvous', () => {
  const key = `ak_${'a'.repeat(64)}`
  assert.ok(parseRendezvousV3(JSON.stringify({ version: 3, protocol: 'acp', instanceId: 'x', pid: 1, endpoint: { unixPath: '/s' }, key })))
  assert.equal(parseRendezvousV3(JSON.stringify({ version: 2, protocol: 'meshcall', instanceId: 'x', pid: 1, endpoint: { unixPath: '/s' }, key: 'mk_a' })), undefined)
  assert.equal(parseRendezvousV3(JSON.stringify({ version: 3, protocol: 'acp', instanceId: 'x', pid: 1, endpoint: { unixPath: '/s' }, key: 'ak_short' })), undefined)
})

test('a wrong key is rejected and the plugin connects once the rendezvous carries the right key', { timeout: 20_000 }, async () => {
  const f = await fixture()
  try {
    await f.connector.listen(f.rendezvous)
    const good = f.connector.key
    f.connector.key = `ak_${'0'.repeat(64)}`
    f.link.start()
    await until(() => f.connector.hellos.length >= 1 && f.link.status.state === 'retrying', 'rejected hello')
    assert.equal(f.connector.hellos[0]!.hostInstance, f.link.hostInstance)
    assert.equal(f.connector.hellos[0]!.bridgeProtocol, '3.0')
    f.connector.key = good
    await until(() => f.link.status.state === 'connected', 'connected after retry', 8000)
  } finally { await f.close() }
})

test('initialize, list, load replay, and AA-created sessions are real host sessions', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const init = await f.connect()
    assert.equal(init.agentInfo?.name, 'agents-anywhere-dsh-bridge')
    assert.equal(init.agentCapabilities?.loadSession, true)
    const meta = (init._meta as { dsh: { hostInstance: string, features: Record<string, boolean> } }).dsh
    assert.equal(meta.hostInstance, f.link.hostInstance)
    assert.equal(meta.features.queue, true)

    const listed = await f.connector.conn!.listSessions({})
    const main = listed.sessions.find(item => item.sessionId === 'native-main')
    assert.ok(main, 'seeded native session is listed')
    assert.equal(main.title, '官方原生会话')
    assert.equal(main.cwd, f.home)

    // Replay: user message, reasoning, text, tool lifecycle, and turn boundaries.
    const loaded = await f.connector.conn!.loadSession({ sessionId: 'native-main', cwd: f.home, mcpServers: [] })
    assert.equal(typeof (loaded._meta as { dsh: { lastSeq: number } }).dsh.lastSeq, 'number')
    assert.deepEqual(f.connector.texts('native-main', 'user_message_chunk'), ['读取当前目录'])
    assert.deepEqual(f.connector.texts('native-main', 'agent_thought_chunk'), ['先查看目录'])
    assert.deepEqual(f.connector.texts('native-main', 'agent_message_chunk'), ['我来读取。'])
    assert.ok(f.connector.updates.some(item => item.update.sessionUpdate === 'tool_call'))
    assert.ok(f.connector.updates.some(item => item.update.sessionUpdate === 'tool_call_update' && (item.update as { status?: string }).status === 'completed'))
    assert.deepEqual(f.connector.turns('native-main').map(item => item.phase), ['started', 'ended'])

    // AA creates a session with its own native ID; it lands in the host and its workspace.
    const id = 'aa_0123456789abcdef_platform-1'
    const created = await f.connector.conn!.newSession({ cwd: f.home, mcpServers: [], _meta: { dsh: { sessionId: id } } })
    assert.equal(created.sessionId, id)
    assert.ok(f.ctx.workspaceRegistry.list().some(item => item.sessionIds.includes(id as SessionId)), 'attached to a workspace')
    // Retrying session/new with the same ID is idempotent.
    assert.equal((await f.connector.conn!.newSession({ cwd: f.home, mcpServers: [], _meta: { dsh: { sessionId: id } } })).sessionId, id)

    const prompt = f.connector.conn!.prompt({ sessionId: id, prompt: [{ type: 'text', text: '你好' }], _meta: { dsh: { requestId: 'aa-req-1' } } })
    await until(() => f.connector.texts(id, 'agent_message_chunk', meta => meta.transient === true).includes('你'), 'streamed transient chunk')
    assert.equal(f.native.status(id as SessionId), 'running', 'turn runs in the host')
    f.adapter.release?.()
    assert.equal((await prompt).stopReason, 'end_turn')
    assert.deepEqual(f.connector.texts(id, 'agent_message_chunk', meta => meta.committed !== undefined), ['你好'])
    const user = f.connector.updates.find(item => item.sessionId === id && item.update.sessionUpdate === 'user_message_chunk')
    assert.equal(((user!.update as { _meta: { dsh: { requestId: string } } })._meta.dsh.requestId), 'aa-req-1')
    const ended = f.connector.turns(id).find(item => item.phase === 'ended')
    assert.deepEqual(ended && ended.phase === 'ended' && ended.requestIds, ['aa-req-1'])

    // The same requestId is not admitted twice.
    const again = await f.connector.conn!.prompt({ sessionId: id, prompt: [{ type: 'text', text: '你好' }], _meta: { dsh: { requestId: 'aa-req-1' } } })
    assert.equal((again._meta as { dsh: { duplicate?: boolean } }).dsh.duplicate, true)
    assert.equal(f.ctx.sessions.get(id as SessionId)!.snapshotEvents().filter(event => event.type === 'user/message'
      && (event.data.source as { rpcId?: string }).rpcId === 'aa-req-1').length, 1)
  } finally { await f.close() }
})

test('turns started in the DSH UI reach AA, queueing works, and a Connector disconnect leaves the host turn running', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    await f.connect()
    const id = 'aa_0123456789abcdef_platform-2'
    await f.connector.conn!.newSession({ cwd: f.home, mcpServers: [], _meta: { dsh: { sessionId: id } } })
    // The DSH Web UI sends through the same SessionController.
    await f.ctx.sessionController.prompt({ sessionId: id as SessionId, requestId: 'ui-req-1' as never, mode: 'queue',
      content: [{ type: 'text', text: '界面发的消息' }] }, new AbortController().signal)
    await until(() => f.connector.texts(id, 'user_message_chunk').includes('界面发的消息'), 'UI message pushed to AA')
    await until(() => f.connector.turns(id).some(item => item.phase === 'started'), 'UI turn start pushed')

    // While the UI turn runs, AA queues a message and gets admission at once.
    const queued = await f.connector.conn!.prompt({ sessionId: id, prompt: [{ type: 'text', text: '排队的消息' }],
      _meta: { dsh: { requestId: 'aa-queued-1', delivery: 'queue' } } })
    assert.equal((queued._meta as { dsh: { admitted: boolean } }).dsh.admitted, true)

    // Drop the Connector mid-turn: the host keeps running the turn (invariant I1).
    const sentThrough = Math.max(...f.connector.updates.filter(item => item.sessionId === id)
      .map(item => Number(((item.update as { _meta?: { dsh?: { seq?: number } } })._meta?.dsh?.seq) ?? -1)).filter(seq => !(seq > 1e9)))
    f.connector.socket!.destroy()
    await until(() => f.link.status.state !== 'connected', 'plugin noticed the disconnect')
    assert.equal(f.native.status(id as SessionId), 'running', 'host turn survives the disconnect')
    f.adapter.release?.()
    await until(() => f.ctx.sessions.get(id as SessionId)!.snapshotEvents().filter(event => event.type === 'turn/end').length >= 1, 'UI turn finished without AA')
    await until(() => f.adapter.release !== undefined, 'queued message started its turn')
    f.adapter.release?.()
    await until(() => f.native.status(id as SessionId) === 'idle', 'queued turn finished')

    // Reconnect and catch up from the last seq the Connector saw.
    f.connector.updates = []; f.connector.ext = []
    await until(() => f.link.status.state === 'connected', 'reconnected', 10_000)
    await f.connector.conn!.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await f.connector.conn!.loadSession({ sessionId: id, cwd: f.home, mcpServers: [], _meta: { dsh: { replayFromSeq: sentThrough + 1 } } })
    assert.ok(!f.connector.texts(id, 'user_message_chunk').includes('界面发的消息'), 'already-seen events are not replayed')
    assert.ok(f.connector.texts(id, 'user_message_chunk').includes('排队的消息'), 'missed queued message replayed')
    assert.ok(f.connector.texts(id, 'agent_message_chunk', meta => meta.committed !== undefined).includes('你好'))
    assert.ok(f.connector.turns(id).some(item => item.phase === 'ended'))
  } finally { await f.close() }
})

test('approvals can be answered from AA, and an answer in the DSH UI withdraws the AA request', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    await f.connect()
    await until(() => f.native.approvals.available, 'approval stream available')
    const handle = await f.ctx.agents.create({ sessionId: SessionId('approval-acp'), agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: f.home } })
    try {
      const agent = handle.agent
      setApprovalPolicy(agent.session, 'ask')
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '执行受限操作' }] }), { surfaceOp: 'append' })
      await f.ctx.sessions.flush(agent.session)
      await f.connector.conn!.loadSession({ sessionId: 'approval-acp', cwd: f.home, mcpServers: [] })

      // AA answers.
      const first = f.ctx.approval.request({ agent, toolName: 'shell', reason: '需要访问工作区之外的文件' })
      await until(() => f.connector.permissions.length === 1, 'permission request reached AA')
      const asked = f.connector.permissions[0]!
      assert.equal(asked.params.toolCall.title, 'shell')
      assert.deepEqual(asked.params.options.map(item => item.optionId), ['allow-once', 'reject'])
      asked.answer({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
      assert.equal(await first, 'allowed-once')

      // The DSH UI answers first: AA hears who answered.
      const controller = new AbortController()
      const second = f.ctx.approval.request({ agent, toolName: 'shell', reason: '再次访问', signal: controller.signal })
      await until(() => f.connector.permissions.length === 2, 'second request reached AA')
      controller.abort()
      await second.catch(() => undefined)
      await until(() => f.connector.ext.some(item => item.method === DSH_METHODS.interactionResolved), 'resolved notification')
      const resolved = f.connector.ext.find(item => item.method === DSH_METHODS.interactionResolved)!.params
      assert.equal(resolved.sessionId, 'approval-acp')
      // A late AA answer is ignored.
      f.connector.permissions[1]!.answer({ outcome: { outcome: 'cancelled' } })
    } finally { await handle.dispose() }
  } finally { await f.close() }
})

test('list subscription pushes sessions created in the DSH UI', { timeout: 20_000 }, async () => {
  const f = await fixture()
  try {
    await f.connect()
    await f.connector.conn!.extMethod(DSH_METHODS.listSubscribe, {})
    await f.ctx.sessionController.create({ sessionId: 'ui-created' as never, cwd: f.home } as never)
    const workspace = await f.ctx.workspaceRegistry.create(f.home)
    await workspace.attachSession('ui-created' as never)
    await f.ctx.sessionController.prompt({ sessionId: 'ui-created' as never, requestId: 'ui-created-1' as never, mode: 'queue',
      content: [{ type: 'text', text: '新会话' }] }, new AbortController().signal)
    await until(() => f.connector.ext.some(item => item.method === DSH_METHODS.listChanges
      && (item.params.upserts as { sessionId: string }[]).some(entry => entry.sessionId === 'ui-created')), 'list change pushed')
    f.adapter.release?.()
  } finally { await f.close() }
})

test('a failed turn reports whether DSH can continue it, and continuing is idempotent', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    await f.connect()
    const id = 'aa_0123456789abcdef_platform-3'
    await f.connector.conn!.newSession({ cwd: f.home, mcpServers: [], _meta: { dsh: { sessionId: id } } })
    f.adapter.failures.push('SERVER')
    assert.equal((await f.connector.conn!.prompt({ sessionId: id, prompt: [{ type: 'text', text: '你好' }],
      _meta: { dsh: { requestId: 'aa-fail-1' } } })).stopReason, 'end_turn')
    await until(() => f.connector.turns(id).some(item => item.phase === 'ended'), 'failed turn ended')
    const failed = f.connector.turns(id).find(item => item.phase === 'ended')!
    assert.ok(failed.phase === 'ended')
    assert.equal(failed.reason.kind, 'error')
    assert.equal(failed.continuable, true)
    const continued = await f.connector.conn!.extMethod(DSH_METHODS.continue, { sessionId: id, turnEndSeq: failed.seq })
    assert.deepEqual(continued, { outcome: 'accepted' })
    await until(() => f.adapter.release !== undefined, 'DSH retries in a new turn')
    assert.deepEqual(await f.connector.conn!.extMethod(DSH_METHODS.continue, { sessionId: id, turnEndSeq: failed.seq }),
      { outcome: 'accepted' }, 'a repeated continue is a no-op')
    f.adapter.release?.()
    await until(() => f.native.status(id as SessionId) === 'idle' && f.connector.turns(id).filter(item => item.phase === 'ended').length === 2, 'retry finished')
    // DSH's empty retry message never shows as a user bubble.
    assert.deepEqual(f.connector.texts(id, 'user_message_chunk'), ['你好'])
    assert.deepEqual(await f.connector.conn!.extMethod(DSH_METHODS.continue, { sessionId: id, turnEndSeq: failed.seq }),
      { outcome: 'accepted' })
  } finally { await f.close() }
})
