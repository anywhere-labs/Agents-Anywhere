import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { SyncFeed, type SyncBatch, type SyncOperation } from '../../src/host/dsh-runtime/sync.js'
import { projectHistory } from '../../src/host/dsh-runtime/history.js'
import { nativeSessionId, sessionId } from '../../src/host/dsh-runtime/identity.js'

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

test('baseline buffers native changes, official filtering and workspace/archive events stay live', { timeout: 30_000 }, async () => {
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
    await until(() => ops().some(op => op.kind === 'workspace.inventory' && JSON.stringify(op).includes(workspace.id)), 'workspace event')
    native.presence.report('test-client', 1, 'empty-native')
    await until(() => ops().some(op => op.kind === 'snapshot.begin' && op.sessionId === sessionId('test', 'empty-native')), 'selected blank visible')
    native.presence.report('test-client', 2, null)
    await until(() => notifications(ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === sessionId('test', 'empty-native')), 'deselected blank removed')
    await fixture.ctx.workspaceRegistry.archiveSession(fixture.session.id)
    await until(() => notifications(ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === sessionId('test', fixture.session.id)), 'archive removed')
    assert.deepEqual(errors, [])
    assert.deepEqual(batches.map(b => b.batchSeq), batches.map((_, n) => n + 1))
  } finally { feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
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
    await until(() => notifications(stream.ops()).some(n => n.method === 'timeline.itemUpsert' && JSON.stringify(n.params.item).includes('你')), 'text pushed while running')
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-pipeline-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const timer = setInterval(() => adapter.release?.(), 300)
  try {
    const result = await promisify(execFile)('uv', ['run', '--with-editable', '../connector', 'python', '../connector/tests/dsh_event_probe.py', home], {
      cwd: new URL('../../../server/', import.meta.url), timeout: 60_000,
    })
    assert.match(result.stdout, /DSH event pipeline passed/)
  } finally { clearInterval(timer); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
