import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { SyncFeed, SYNC_FLUSH_MS, type SyncBatch, type SyncOperation } from '../../src/host/dsh-runtime/sync.js'
import { projectHistory } from '../../src/host/dsh-runtime/history.js'
import { nativeSessionId, sessionId } from '../../src/host/dsh-runtime/identity.js'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 400; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

function notifications(operations: SyncOperation[]) {
  return operations.flatMap(op => op.kind === 'notifications'
    ? op.notifications as { method: string, params: Record<string, unknown> }[] : [])
}

function follow(native: ReturnType<typeof nativeRuntime> extends Promise<infer T> ? T['ctx']['agentsAnywhereRuntime']['native'] : never) {
  const batches: SyncBatch[] = [], errors: unknown[] = []
  const feed = new SyncFeed(native, 'test', batch => { batches.push(batch); queueMicrotask(() => feed.ack(batch.batchSeq)) }, error => errors.push(error))
  feed.start()
  return { feed, batches, errors, ops: () => batches.flatMap(b => b.operations) }
}

test('fast mixed native events flush at 30 Hz with complete final text, tool results and ordered completion', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-flush-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const batches: SyncBatch[] = [], times: number[] = [], errors: unknown[] = []
  const feed = new SyncFeed(native, 'test', batch => {
    times.push(performance.now()); batches.push(batch)
    queueMicrotask(() => feed.ack(batch.batchSeq))
  }, error => errors.push(error))
  const notes = () => notifications(batches.flatMap(batch => batch.operations))
  try {
    feed.start()
    await until(() => notes().some(note => note.method === 'session.inventory.complete'), 'baseline')
    const firstLive = batches.length
    const start = fixture.session.append('turn/start', { turn: 2 })
    fixture.session.append('step/start', { turn: 2, step: 1 })
    let text = ''
    for (let window = 0; window < 8; window++) {
      for (let index = 0; index < 40; index++) {
        text += '字'
        fixture.session.append('assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '字' } })
      }
      await delay(12)
    }
    fixture.session.append('assistant/message', { turn: 2, step: 1, message: createAssistantMessage({
      source: { provider: 'test', model: 'text' }, content: [{ type: 'text', text }],
    }) }, { surfaceOp: 'append' })
    const callId = ToolCallId('flush-write')
    fixture.session.append('tool/call', { turn: 2, step: 1, callId, name: 'write', arguments: '{"file_path":"/workspace/new.txt","content":"complete"}' })
    fixture.session.append('tool/result', { turn: 2, step: 1, meta: { diffs: [] }, message: createToolResultMessage({
      callId, content: [{ type: 'text', text: '<path>/workspace/new.txt</path>\n<type>file</type>\n<content>\nCreated file\n</content>' }], isError: false,
    }) }, { surfaceOp: 'append' })
    fixture.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    fixture.session.append('turn/start', { turn: 3 })
    fixture.session.append('turn/end', { turn: 3, reason: { kind: 'interrupted' } })
    await until(() => notes().filter(note => note.method === 'session.turnEnded').length === 2, 'final tail flushes without another event')
    const live = notifications(batches.slice(firstLive).flatMap(batch => batch.operations))
    const upserts = live.filter(note => note.method === 'timeline.itemUpsert')
    const latest = new Map(upserts.map(note => { const item = note.params.item as { id: string }; return [item.id, item] }))
    const expected = projectHistory(await native.read(fixture.session.id), sessionId('test', fixture.session.id))
      .filter(item => item.type !== 'turn.start' && item.type !== 'turn.end' && Number(item.source.lastSeq) >= start.seq)
    for (const item of expected) assert.deepEqual(latest.get(item.id), item)
    assert.ok(expected.some(item => item.content.text === text && item.status === 'done'))
    assert.ok(expected.some(item => item.content.kind === 'file_change'))
    assert.ok(upserts.length < 40, '320 native chunks are coalesced before transport')
    const endIndex = live.findIndex(note => note.method === 'session.turnEnded')
    assert.ok(endIndex > live.findLastIndex(note => note.method === 'timeline.itemUpsert'))
    for (let index = 1; index < times.length; index++) assert.ok(times[index]! - times[index - 1]! >= SYNC_FLUSH_MS - 1)
    assert.deepEqual(live.filter(note => note.method === 'session.turnEnded').map(note => note.params.outcome), ['completed', 'interrupted'])
    assert.ok(batches.slice(firstLive).some(batch => batch.operations.some(operation => {
      const entries = notifications([operation])
      return entries.some(note => note.method === 'session.turnEnded') &&
        entries.some(note => note.method === 'timeline.itemUpsert' && JSON.stringify(note.params.item).includes('file_change'))
    })), 'Tool and lifecycle notifications are merged into one forwarded list')
    assert.deepEqual(errors, [])
    const count = batches.length
    feed.close()
    fixture.session.append('session/title', { title: 'after close', source: { kind: 'user' }, messageSeqs: [] })
    await delay(SYNC_FLUSH_MS * 2)
    assert.equal(batches.length, count)
  } finally { feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('baseline buffers native changes and archive events without syncing native projects', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const batches: SyncBatch[] = [], errors: unknown[] = []
  let held: SyncBatch | undefined
  let amended = false
  const feed = new SyncFeed(native, 'test', batch => {
    batches.push(batch)
    if (!amended && batch.operations[0]?.kind === 'snapshot.items') {
      amended = true; held = batch
      fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'baseline race' }] }), { surfaceOp: 'append' })
      fixture.session.append('session/title', { title: 'New title', source: { kind: 'user' }, messageSeqs: [] })
    } else queueMicrotask(() => feed.ack(batch.batchSeq))
  }, error => errors.push(error))
  const ops = () => batches.flatMap(b => b.operations)
  try {
    feed.start()
    await until(() => !!held, 'first page was held')
    const count = batches.length
    await delay(40)
    assert.equal(batches.length, count, 'No next batch before Connector acknowledgement')
    const brief = fixture.ctx.sessions.prepare(SessionId('brief-session'), { meta: { cwd: home } })
    const detach = fixture.ctx.sessions.enter(brief)
    fixture.ctx.sessions.announce(brief)
    brief.append('turn/start', { turn: 1 })
    brief.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '短暂加载的会话' }] }), { surfaceOp: 'append' })
    brief.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await fixture.ctx.sessions.flush(brief)
    detach()
    feed.ack(held!.batchSeq)
    await until(() => notifications(ops()).some(n => n.method === 'session.inventory.complete'), 'initial complete')
    const starts = ops().filter(op => op.kind === 'snapshot.begin')
    assert.equal(starts.length, 3, 'blank session is not imported headlessly')
    assert.ok(starts.some(op => op.sessionId === sessionId('test', brief.id)), 'A new session disposed during ACK wait still imports its persisted history')
    assert.ok(notifications(ops()).some(n => n.method === 'session.meta.upsert' && n.params.title === 'New title'))
    assert.ok(notifications(ops()).some(n => n.method === 'timeline.itemUpsert' && JSON.stringify(n.params.item).includes('baseline race')))
    const workspace = await fixture.ctx.workspaceRegistry.create(home)
    await workspace.attachSession(fixture.session.id)
    await workspace.setTitle('DSH 项目名称')
    await fixture.ctx.workspaceRegistry.delete(workspace.id)
    native.presence.report('test-client', 1, 'empty-native')
    await delay(SYNC_FLUSH_MS * 3)
    assert.ok(!ops().some(op => op.kind === 'snapshot.begin' && op.sessionId === sessionId('test', 'empty-native')), 'Selecting a draft must not import it')
    native.presence.report('test-client', 2, null)
    await fixture.ctx.workspaceRegistry.archiveSession(fixture.session.id)
    await until(() => notifications(ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === sessionId('test', fixture.session.id) && n.params.availability === 'archived'), 'explicit archive event')
    assert.ok(!ops().some(op => op.kind === 'workspace.inventory'), 'native projects are not synchronized')
    assert.ok(!JSON.stringify(ops()).includes('DSH 项目名称'))
    assert.ok(!notifications(ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === sessionId('test', 'empty-native')), 'Draft source notifications must not create empty AA sessions either')
    assert.deepEqual(errors, [])
    assert.deepEqual(batches.map(b => b.batchSeq), batches.map((_, n) => n + 1))
  } finally { feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('new native drafts sync once after their first real user message, including attachment-only messages', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-first-message-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const stream = follow(native)
  const id = SessionId('new-native-draft')
  const platformId = sessionId('test', id)
  const snapshots = () => stream.ops().filter(op => op.kind === 'snapshot.begin' && op.sessionId === platformId)
  try {
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'baseline')
    const draft = fixture.ctx.sessions.create(id, { meta: { cwd: home } })
    native.presence.report('test-client', 1, id)
    await delay(SYNC_FLUSH_MS * 3)
    assert.equal(snapshots().length, 0, 'A selected empty session stays local')
    assert.ok(!notifications(stream.ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === platformId))
    draft.append('turn/start', { turn: 1 })
    draft.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'injected context' }] }), { surfaceOp: 'append' })
    await delay(SYNC_FLUSH_MS * 3)
    assert.equal(snapshots().length, 0, 'Starting a turn or injecting context is not a user message')
    assert.equal(await native.visible(id), false)

    const message = draft.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: { id: 'native-image' } }] }), { surfaceOp: 'append' })
    await until(() => stream.ops().some(op => op.kind === 'snapshot.commit' && op.sessionId === platformId), 'first user message imports the session without waiting for an assistant')
    assert.equal(snapshots().length, 1)
    const items = stream.ops().filter(op => op.kind === 'snapshot.items' && op.sessionId === platformId).flatMap(op => op.items as { role: string, source: { nativeMessageId?: string } }[])
    assert.equal(items.filter(item => item.role === 'user').length, 1)
    assert.ok(JSON.stringify(items).includes('native-image'))
    assert.ok(!JSON.stringify(items).includes('injected context'))

    const second = draft.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'second user message' }] }), { surfaceOp: 'append' })
    native.presence.report('test-client', 2, null)
    await until(() => notifications(stream.ops()).some(n => n.method === 'timeline.itemUpsert' && JSON.stringify(n.params.item).includes('second user message')), 'later messages update the existing session')
    assert.equal(snapshots().length, 1)
    assert.notEqual(message.data.id, second.data.id)
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('startup and reconnect exclude persisted drafts and import messages sent through the native Agent', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-draft-reconnect-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, async ctx => {
    for (const id of ['persisted-draft', 'turn-only', 'injected-only']) {
      const session = ctx.sessions.prepare(SessionId(id), { meta: { cwd: home } })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      if (id !== 'persisted-draft') session.append('turn/start', { turn: 1 })
      if (id === 'injected-only') session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'context without a user' }] }), { surfaceOp: 'append' })
      if (id !== 'persisted-draft') session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
      await ctx.sessions.flush(session)
      detach()
    }
    await mountAgents(ctx, adapter)
  })
  const native = fixture.ctx.agentsAnywhereRuntime.native
  let stream = follow(native)
  const imported = () => stream.ops().filter(op => op.kind === 'snapshot.begin').map(op => op.sessionId)
  const drafts = ['empty-native', 'persisted-draft', 'turn-only', 'injected-only', 'discarded-draft']
  let handle: Awaited<ReturnType<typeof fixture.ctx.agents.create>> | undefined
  try {
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'startup inventory')
    assert.deepEqual(new Set(imported()), new Set(['native-main', 'persisted-only'].map(id => sessionId('test', id))))
    const discarded = fixture.ctx.sessions.prepare(SessionId('discarded-draft'), { meta: { cwd: home } })
    const detach = fixture.ctx.sessions.enter(discarded)
    fixture.ctx.sessions.announce(discarded)
    detach()

    // This follows DSH's own create/followup path, not the bridge's remote send helper.
    handle = await fixture.ctx.agents.create({ sessionId: SessionId('native-ui-session'), agentOptions: { provider: 'test', model: 'text' }, meta: { cwd: home } })
    await delay(SYNC_FLUSH_MS * 3)
    assert.ok(!imported().includes(sessionId('test', handle.agent.id)))
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first message from DSH' }] }))
    await until(() => !!adapter.release, 'native model is running')
    await until(() => stream.ops().some(op => op.kind === 'snapshot.commit' && op.sessionId === sessionId('test', handle!.agent.id)), 'native first message is synchronized live')
    assert.deepEqual(stream.errors, [])
    adapter.release!()
    await handle.agent.whenIdle()
    await fixture.ctx.sessions.flush(handle.agent.session)
    stream.feed.close()
    stream = follow(native)
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'reconnected inventory')
    for (const id of drafts) assert.ok(!imported().includes(sessionId('test', id)), `${id} must not be imported on reconnect`)
    assert.equal(imported().filter(id => id === sessionId('test', handle!.agent.id)).length, 1)
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await handle?.dispose(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('a stale inventory cannot erase a new session that sends its first message and leaves memory during the scan', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-inventory-race-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const query = fixture.ctx.sessionQuery
  const list = query.listSessions
  let captured = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  query.listSessions = async function (signal) {
    const entries = await list.call(this, signal)
    captured = true
    await gate
    return entries
  }
  const stream = follow(native)
  try {
    await until(() => captured, 'old catalog captured')
    const session = fixture.ctx.sessions.prepare(SessionId('created-during-scan'), { meta: { cwd: home } })
    const detach = fixture.ctx.sessions.enter(session)
    fixture.ctx.sessions.announce(session)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first message during scan' }] }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await fixture.ctx.sessions.flush(session)
    detach()
    release()
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'baseline completes')
    assert.ok(stream.ops().some(op => op.kind === 'snapshot.commit' && op.sessionId === sessionId('test', session.id)), 'An older catalog must preserve the newly observed session')
    assert.ok(JSON.stringify(stream.ops()).includes('first message during scan'))
    assert.deepEqual(stream.errors, [])
  } finally {
    release(); query.listSessions = list; stream.feed.close()
    await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  }
})

test('fresh detail and send checks distinguish archives from persisted and blank sessions', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-source-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const native = fixture.ctx.agentsAnywhereRuntime.native
  let endpoint: { port: number, host: string, token: string } | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    try { endpoint = JSON.parse(await readFile(join(home, 'agents-anywhere/bridge/endpoint.json'), 'utf8')); break }
    catch { await delay(10) }
  }
  assert.ok(endpoint, 'published runtime endpoint')
  const socket = createConnection(endpoint.port, endpoint.host)
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  let sequence = 0
  const rpc = async (method: string, params: Record<string, unknown>) => {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params })}\n`)
    const line = await lines.next()
    assert.equal(line.done, false)
    const response = JSON.parse(line.value)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    return response.result
  }
  await rpc('initialize', { authToken: endpoint.token, protocolVersion: '1.0', runtime: 'dsh', connectorId: 'test', sessionNamespace: 'test' })
  const params = (id: string) => ({ sessionId: sessionId('test', id), externalSessionId: id })
  const request = (method: string, id: string) => rpc(method, params(id)) as Promise<{ sourceState: { availability: string }, status: string }>
  let stream: ReturnType<typeof follow> | undefined
  try {
    assert.equal(fixture.ctx.sessions.get(SessionId('persisted-only')), undefined)
    assert.equal((await request('session.getState', 'persisted-only')).sourceState.availability, 'available')
    assert.equal((await request('session.getState', 'empty-native')).sourceState.availability, 'unavailable')
    // No sync subscription exists: detail must consult the current official catalog itself.
    await fixture.ctx.workspaceRegistry.archiveSession(fixture.session.id)
    const archived = await request('session.getState', fixture.session.id)
    assert.equal(archived.sourceState.availability, 'archived')
    assert.equal(archived.status, 'blocked')
    const sent = await rpc('session.startTurn', { ...params(fixture.session.id), content: '不可发送', clientMessageId: 'blocked-send' }) as { ok: boolean, code: string }
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'session_archived')
    assert.equal(adapter.requests.length, 0)
    stream = follow(native)
    await until(() => notifications(stream!.ops()).some(n => n.method === 'session.inventory.complete'), 'offline calibration')
    const operations = stream.ops()
    assert.ok(!operations.some(op => op.kind === 'workspace.inventory'))
    const complete = notifications(operations).find(n => n.method === 'session.inventory.complete')!
    assert.ok(JSON.stringify(complete.params.sessions).includes('archived'))
    assert.ok(!operations.some(op => op.kind === 'snapshot.begin' && op.sessionId === sessionId('test', fixture.session.id)))
    assert.deepEqual(stream.errors, [])
  } finally { stream?.feed.close(); socket.destroy(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('real AgentLoop sends text once, streams before idle, queues followups and resumes persisted history', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-text-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const stream = follow(native)
  const id = SessionId(nativeSessionId('test', 'sess-new'))
  try {
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'baseline')
    await native.send(id, '第一条', 'client-1', home, true)
    await native.send(id, '第一条', 'client-1', home, true)
    await until(() => !!adapter.release, 'model started')
    await until(() => {
      const operations = stream.ops()
      const platformId = sessionId('test', id)
      const committed = new Set(operations.filter(op => op.kind === 'snapshot.commit' && op.sessionId === platformId).map(op => op.snapshotId))
      // A newly visible session may capture its first streaming text in its baseline.
      return operations.some(op => op.kind === 'snapshot.items' && op.sessionId === platformId &&
        committed.has(op.snapshotId) && JSON.stringify(op.items).includes('你')) ||
        notifications(operations).some(n => n.method === 'timeline.itemUpsert' && n.params.sessionId === platformId && JSON.stringify(n.params.item).includes('你'))
    }, 'text pushed while running')
    assert.equal(fixture.ctx.agents.get(id)?.status, 'running')
    await native.send(id, '第二条', 'client-2')
    adapter.release!()
    await until(() => adapter.requests.length === 2 && !!adapter.release, 'queued second turn')
    adapter.release!()
    await fixture.ctx.agents.get(id)!.whenIdle()
    const log = await native.read(id)
    const users = log.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user')
    assert.equal(users.length, 2)
    const snapshot = projectHistory(log, 'sess-new')
    assert.equal(snapshot.filter(i => i.role === 'assistant' && i.type === 'message').length, 2)
    assert.deepEqual(snapshot.filter(i => i.role === 'user').map(i => i.source.clientMessageId), ['client-1', 'client-2'])
    await native.send(SessionId('persisted-only'), '继续历史', 'client-cold')
    await until(() => adapter.requests.length === 3 && !!adapter.release, 'cold resume')
    assert.ok(adapter.requests[2]!.messages.length > 1000, 'native history restored for the model')
    await native.interrupt(SessionId('persisted-only'))
    await fixture.ctx.agents.get(SessionId('persisted-only'))!.whenIdle()
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('official native loop crosses Python adapter and authenticated backend, including lost ACK and reconnect', { timeout: 75_000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pipeline-')))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  let closed = false
  const mutations = (async () => {
    while (!closed) {
      const marker = join(home, 'native-action.json')
      const action = await readFile(marker, 'utf8').then(text => JSON.parse(text) as { action: string, sessionId: string }).catch(() => undefined)
      if (action) {
        const workspace = fixture.ctx.workspaceRegistry.list().find(workspace => workspace.path === home)!
        if (action.action === 'release') {
          assert.ok(adapter.release, 'the model must still be streaming when the backend observes partial text')
          adapter.release()
        } else if (action.action === 'draft') {
          fixture.ctx.sessions.create(SessionId(action.sessionId), { meta: { cwd: home } })
          fixture.ctx.agentsAnywhereRuntime.native.presence.report('pipeline-client', 1, action.sessionId)
        } else if (action.action === 'first-message') {
          const session = fixture.ctx.sessions.get(SessionId(action.sessionId))!
          session.append('turn/start', { turn: 1 })
          session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first native user message' }] }), { surfaceOp: 'append' })
          session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          await fixture.ctx.sessions.flush(session)
        } else if (action.action === 'rename') await workspace.setTitle('DSH 项目改名')
        else if (action.action === 'archive') await fixture.ctx.workspaceRegistry.archiveSession(SessionId(action.sessionId))
        else if (action.action === 'delete') await fixture.ctx.workspaceRegistry.delete(workspace.id)
        else throw new Error(`Unknown test action: ${action.action}`)
        await rm(marker)
      }
      await delay(20)
    }
  })()
  try {
    const result = await promisify(execFile)('uv', ['run', '--with-editable', '../connector', 'python', '../connector/tests/dsh_event_probe.py', home], {
      cwd: new URL('../../../server/', import.meta.url), timeout: 60_000,
    })
    assert.match(result.stdout, /DSH event pipeline passed/)
  } finally { closed = true; adapter.release?.(); await mutations; await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
