import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import type { SyncTransport } from '../../src/host/dsh-runtime/sync.js'
import { MAX_RETAINED_LOGS } from '../../src/host/dsh-runtime/sessions/source.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'

type StateResult = { status: string, selections: Record<string, string>, metadata: Record<string, unknown> }

/** Count full-log reads so a cached answer is provable, not just plausible. */
function countLogReads(ctx: Context) {
  const query = ctx.sessionQuery
  const original = query.observeSession.bind(query)
  let reads = 0
  query.observeSession = async (id, options) => { reads += 1; return await original(id, options) }
  return { count: () => reads }
}

async function fixture(name: string) {
  const home = await mkdtemp(join(tmpdir(), name))
  const context = await nativeRuntime(home)
  const runtime = context.ctx.agentsAnywhereRuntime.native
  const router = new RuntimeRouter({ native: runtime, query: context.ctx.sessionQuery, status: id => runtime.status(id) }, 'instance')
  const request = (method: string, params: Record<string, unknown>) => router.request(method, params, new AbortController().signal)
  return { ...context, home, runtime, router, request, close: async () => {
    router.shutdown(); await context.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  } }
}

test('session.getState answers an unchanged log from cached facts', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-state-')
  try {
    const reads = countLogReads(f.ctx)
    const params = { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only' }

    const first = await f.request('getSessionState', params) as StateResult
    const afterFirst = reads.count()
    assert.ok(afterFirst > 0, 'the first read inspects the log')
    assert.equal(first.status, 'idle')

    const second = await f.request('getSessionState', params) as StateResult
    assert.equal(reads.count(), afterFirst, 'an unchanged log is never read twice')
    assert.equal(second.status, first.status)
    assert.deepEqual(second.selections, first.selections)
    assert.deepEqual(second.metadata, first.metadata)
  } finally { await f.close() }
})

test('session.getState rereads a live session whose log changed', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-state-live-')
  try {
    const params = { sessionId: sessionId('instance', 'native-main'), externalSessionId: 'native-main' }
    const completed = await f.request('getSessionState', params) as StateResult
    assert.equal(completed.status, 'idle')

    f.session.append('turn/start', { turn: 2 })
    f.session.append('turn/end', { turn: 2, reason: { kind: 'error' } })

    const failed = await f.request('getSessionState', params) as StateResult
    assert.equal(failed.status, 'error')
  } finally { await f.close() }
})

test('a blank visibility verdict is reused until that log changes', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-visibility-')
  try {
    const cold = f.ctx.sessions.prepare(SessionId('cold-empty'), { meta: { cwd: f.home, createdAt: 1 } })
    const detach = f.ctx.sessions.enter(cold)
    f.ctx.sessions.announce(cold)
    cold.append('turn/start', { turn: 1 })
    cold.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.ctx.sessions.flush(cold)
    detach()
    await f.runtime.source.refresh()

    const reads = countLogReads(f.ctx)
    const before = reads.count()
    assert.equal(await f.runtime.visible('cold-empty'), false)
    assert.equal(f.runtime.source.retainedLogCount, 0, 'blank cold logs are evicted immediately after recording their empty revision')
    const afterFirst = reads.count()
    assert.equal(afterFirst, before + 1, 'the first check reads the log')

    assert.equal(await f.runtime.visible('cold-empty'), false)
    assert.equal(reads.count(), afterFirst, 'an unchanged blank log is not read again')

    // Another DSH writer appends the first message; only the changed log is reread.
    const header = (await f.ctx.sessionQuery.listSessions()).find(item => item.header.id === 'cold-empty')!.header
    const location = ({ path: (await (f.ctx.sessionPersistence as import('@deepseek-ai/dsh-session-persistence-jsonl').default).resolveCurrentLog(header.id))! })
    const lines = (await readFile(location.path, 'utf8')).split('\n').filter(line => line.length > 0)
    const nextSeq = Number((JSON.parse(lines.at(-1)!) as { seq: number }).seq) + 1
    const message = { type: 'user/message', seq: nextSeq, time: Date.now(), surfaceOp: 'append',
      data: { id: 'cold-first-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条消息' }] } }
    await appendFile(location.path, `${JSON.stringify(message)}\n`)
    await f.runtime.source.refresh()

    assert.equal(await f.runtime.visible('cold-empty'), true, 'a first message invalidates the blank verdict')
  } finally { await f.close() }
})


test('warm single-session RPC and concurrent startup inventories never relist the corpus', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-no-poll-')
  try {
    const query = f.ctx.sessionQuery
    const list = query.listSessions.bind(query)
    let listings = 0
    query.listSessions = async signal => { listings++; return list(signal) }
    const reads = countLogReads(f.ctx)
    await Promise.all([f.runtime.inventory(), f.runtime.inventory(), f.runtime.inventory()])
    assert.equal(listings, 1)
    const afterInventory = reads.count()
    const params = { sessionId: sessionId('instance', 'persisted-only') }
    for (let i = 0; i < 5; i++) {
      await f.request('getSessionState', params)
      await f.runtime.read(SessionId('persisted-only'))
    }
    assert.equal(listings, 1, 'neither platform-ID resolution nor cache validation lists sessions')
    assert.equal(reads.count(), afterInventory, 'visibility, state and snapshot share the observation')
  } finally { await f.close() }
})

test('cold observation cache detects file changes without an inventory scan', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-cache-change-')
  try {
    await f.runtime.inventory()
    const id = SessionId('persisted-only')
    const first = await f.runtime.read(id)
    const location = ({ path: (await (f.ctx.sessionPersistence as import('@deepseek-ai/dsh-session-persistence-jsonl').default).resolveCurrentLog(first.session.id))! })
    await appendFile(location.path, JSON.stringify({ type: 'session/title', seq: first.events.length, time: Date.now(),
      data: { title: 'changed outside the cache', source: { kind: 'user' }, messageSeqs: [] } }) + '\n')
    const next = await f.runtime.read(id)
    assert.equal(next.events.length, first.events.length + 1)
    assert.equal(next.events.at(-1)?.type, 'session/title')
  } finally { await f.close() }
})

test('session observation cache bounds retained logs by LRU capacity', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-log-lru-')
  try {
    const total = MAX_RETAINED_LOGS + 4
    for (let i = 0; i < total; i++) {
      const cold = f.ctx.sessions.prepare(SessionId(`cold-lru-${i}`), { meta: { cwd: f.home, createdAt: i + 1 } })
      const detach = f.ctx.sessions.enter(cold)
      f.ctx.sessions.announce(cold)
      cold.append('turn/start', { turn: 1 })
      cold.append('user/message', {
        id: `msg-${i}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `session ${i}` }],
      }, { surfaceOp: 'append' })
      cold.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await f.ctx.sessions.flush(cold)
      detach()
    }
    await f.runtime.source.refresh()
    for (let i = 0; i < total; i++) {
      await f.runtime.read(SessionId(`cold-lru-${i}`))
    }
    assert.equal(f.runtime.source.retainedLogCount, MAX_RETAINED_LOGS, 'retained logs never exceed MAX_RETAINED_LOGS')

    // On-demand getSessionSnapshot releases the observation it opened and its multi-page capture.
    const reads = countLogReads(f.ctx)
    const params = { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only' }
    let page = await f.request('getSessionSnapshot', params) as { nextCursor: string | null }
    assert.ok(page.nextCursor, 'the fixture history spans more than one page')
    while (page.nextCursor) page = await f.request('getSessionSnapshot', { ...params, cursor: page.nextCursor }) as { nextCursor: string | null }
    assert.equal(f.router.hasHistoryPage, false, 'the capture is cleared after its last page')
    const afterSnapshot = reads.count()
    await f.runtime.read(SessionId('persisted-only'))
    assert.equal(reads.count(), afterSnapshot + 1, 'the snapshot did not leave its observation cached')
  } finally { await f.close() }
})

test('paged snapshot reads survive a sync resubscription and end with the router', { timeout: 60_000 }, async () => {
  const f = await fixture('aa-dsh-page-resubscribe-')
  try {
    const params = { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only' }
    const first = await f.request('getSessionSnapshot', params) as { nextCursor: string | null }
    assert.ok(first.nextCursor, 'the fixture history spans more than one page')
    // A restarting sync stream replaces the feed through subscribe() and unsubscribe().
    const transport: SyncTransport = {
      ingestBatch: async () => {}, loadCheckpoint: async () => null, saveCheckpoint: async () => {},
      deleteCheckpoint: async () => {}, ingestSnapshot: async () => ({ accepted: true }),
    }
    f.router.unsubscribe(f.router.subscribe('restarted-sync', true, transport, () => {}))
    const last = await f.request('getSessionSnapshot', { ...params, cursor: first.nextCursor }) as { nextCursor: string | null }
    assert.equal(last.nextCursor, null, 'the open cursor still reads its last page')

    const unfinished = await f.request('getSessionSnapshot', params) as { nextCursor: string | null }
    f.router.shutdown()
    assert.equal(f.router.hasHistoryPage, false, 'shutdown releases an unfinished capture')
    await assert.rejects(f.request('getSessionSnapshot', { ...params, cursor: unfinished.nextCursor }), { code: 'INVALID_PARAMS' })
  } finally { await f.close() }
})
