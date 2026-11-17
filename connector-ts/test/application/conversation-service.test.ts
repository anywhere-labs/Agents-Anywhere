import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService, platformUserItemId } from '../../src/application/index.js'
import type { NewSessionSpec, RuntimeHandle, RuntimeHandles, OpenTarget } from '../../src/application/ports/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed, OutboxSignal, joinChunks, chunkJson, outboxStream, plainSealer, watchSession } from '../../src/sync/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

let dir: string
let store: RemoteStore
let feed: MemoryChangeFeed
let live: { method: string; payload: Record<string, unknown> }[]
let service: ConversationService
let sessions: FakeRuntimeSession[]
let opened: OpenTarget[]
let ms = 0
let counter = 0

const clock = { nowIso: () => new Date(Date.UTC(2026, 10, 16, 0, 0, 0, ms)).toISOString(), nowMs: () => ms }
const ids = { newId: (prefix: string) => `${prefix}${++counter}` }

function handle(): RuntimeHandle {
  return {
    type: 'pi',
    instanceId: 'rti_pi',
    capabilities: () => ({ revision: 1, items: [] }),
    catalogs: async () => ({}),
    listNativeSessions: async () => ({ sessions: [] }),
    readNativeHistory: async () => ({ items: [] }),
    open: async (target: OpenTarget, options) => {
      opened.push(target)
      const native = target.kind === 'existing' ? target.ref.nativeSessionId : `native_${(target.spec as NewSessionSpec).cwd.length}_${sessions.length}`
      const session = new FakeRuntimeSession(options.sessionId, native)
      sessions.push(session)
      return session
    },
    events: (async function* () {})(),
    stop: async () => undefined,
  }
}

const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'rti_pi' ? handle() : null) }

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

async function makeSession(sessionId = 'sess_1'): Promise<void> {
  await store.sessions.create({ sessionId, runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: `native_${sessionId}`, cwd: '/w', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
}

const ctx = (commandId: string | null = null) => ({ commandId, inputDigest: null, actor: 'usr_1' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-svc-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  feed = new MemoryChangeFeed()
  live = []
  sessions = []
  opened = []
  ms = 0
  counter = 0
  service = new ConversationService({ store, feed, live: { emit: (method, payload) => live.push({ method, payload }) }, runtimes, clock, ids, coalesceMs: 100 })
})

afterEach(async () => {
  await service.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sending messages', () => {
  it('acknowledges after the delivery is on disk, then hands it to the Runtime once', async () => {
    await makeSession()
    const result = await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'hello' }, ctx('c1'))
    expect(result).toEqual({ delivery: 'accepted', clientMessageId: 'm1' })
    await settle()
    expect(opened).toEqual([{ kind: 'existing', ref: { nativeSessionId: 'native_sess_1' } }])
    const runtime = sessions[0]!
    expect(runtime.calls).toMatchObject([{ method: 'prompt', input: { text: 'hello' }, delivery: { clientMessageId: 'm1' } }])
    expect((await store.deliveries.get('sess_1', 'm1'))?.state).toBe('started')
    // The device wrote the user message (the fake adapter does not echo it).
    expect((await store.timeline.findByClientMessageId('sess_1', 'm1'))?.id).toBe(platformUserItemId('sess_1', 'm1'))
    // Replaying the same message is a duplicate, never a second prompt.
    expect(await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'hello' }, ctx('c1'))).toMatchObject({ delivery: 'duplicate', state: 'started' })
    await settle()
    expect(runtime.calls.filter(call => call.method === 'prompt')).toHaveLength(1)
  })

  it('shows a failed user message and never resends an unknown outcome', async () => {
    await makeSession()
    await service.binding('sess_1')
    sessions[0]!.nextPrompt = { outcome: 'unknown', error: { code: 'timeout', message: 'no answer' } }
    await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'x' }, ctx())
    await settle()
    expect((await store.deliveries.get('sess_1', 'm1'))).toMatchObject({ state: 'unknown', errorCode: 'timeout' })
    expect((await store.timeline.findByClientMessageId('sess_1', 'm1'))?.status).toBe('failed')
    await service.recover()
    expect(sessions[0]!.calls.filter(call => call.method === 'prompt')).toHaveLength(1)
  })

  it('hands off a delivery left in accepted by a crash after the ack, and rejects one that kept nothing', async () => {
    await makeSession()
    // The process died after the delivery was on disk and acknowledged, before the Runtime hand-off.
    await store.deliveries.receive({ sessionId: 'sess_1', clientMessageId: 'm1', inputDigest: 'd1', userItem: null, enqueue: null, pending: { content: 'after restart', attachments: [] }, commandId: 'c1', at: clock.nowIso() })
    await store.deliveries.receive({ sessionId: 'sess_1', clientMessageId: 'm0', inputDigest: 'd0', userItem: null, enqueue: null, commandId: null, at: clock.nowIso() })
    await service.recover()
    await settle()
    expect(sessions[0]!.calls).toMatchObject([{ method: 'prompt', input: { text: 'after restart' }, delivery: { clientMessageId: 'm1' } }])
    expect((await store.deliveries.get('sess_1', 'm1'))?.state).toBe('started')
    expect(await store.deliveries.get('sess_1', 'm0')).toMatchObject({ state: 'rejected', errorCode: 'connector_restarted' })
    expect((await store.timeline.findByClientMessageId('sess_1', 'm0'))?.status).toBe('failed')
    // Nothing is kept once the delivery left accepted: a second restart sends nothing again.
    expect(await store.deliveries.acceptedPending()).toEqual([])
    await service.recover()
    await settle()
    expect(sessions[0]!.calls.filter(call => call.method === 'prompt')).toHaveLength(1)
  })

  it('opens the new Runtime session of a creation left in accepted', async () => {
    await store.sessions.create({ sessionId: 'sess_new', runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: null, cwd: '/proj', nativeTitle: null, status: 'pending', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
    await store.deliveries.receive({ sessionId: 'sess_new', clientMessageId: 'm1', inputDigest: 'd1', userItem: null, enqueue: null, pending: { content: 'start', attachments: [], open: { cwd: '/proj', title: 'T' } }, commandId: 'c1', at: clock.nowIso() })
    await service.recover()
    await settle()
    expect(opened).toEqual([{ kind: 'new', spec: { cwd: '/proj', title: 'T' } }])
    expect((await store.deliveries.get('sess_new', 'm1'))?.state).toBe('started')
  })

  it('queues while a turn runs and dispatches the head when the turn ends idle', async () => {
    await makeSession()
    await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'first' }, ctx())
    await settle()
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user', clientMessageId: 'm1' })
    await settle()
    expect((await store.sessions.get('sess_1'))?.status).toBe('running')

    await expect(service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm2', content: 'x' }, ctx())).rejects.toMatchObject({ code: 'session_busy', details: { legacy: true } })
    const queued = await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm2', content: 'second', queue: 'auto' }, ctx())
    expect(queued).toMatchObject({ delivery: 'queued', queuePosition: 1 })
    expect(live.some(event => event.method === 'runtime.queue.updated')).toBe(true)

    runtime.emit({ type: 'message.delta', itemId: 'a1', role: 'assistant', text: 'he', turnId: 't1' })
    runtime.emit({ type: 'message.delta', itemId: 'a1', role: 'assistant', text: 'llo', turnId: 't1' })
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await settle(40)
    const item = await store.timeline.get('sess_1', 'a1')
    expect(item).toMatchObject({ status: 'done', content: { text: 'hello', isThinking: false } })
    expect(runtime.calls.filter(call => call.method === 'prompt').map(call => (call as { input: { text: string } }).input.text)).toEqual(['first', 'second'])
    expect((await store.queues.get('sess_1')).items).toEqual([])
    expect((await store.deliveries.get('sess_1', 'm2'))?.state).toBe('started')
    const session = await store.sessions.get('sess_1')
    expect(session?.latestTurnEndSeq).not.toBeNull()
  })

  it('pauses the queue after an errored turn until resume', async () => {
    await makeSession()
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'external' })
    await settle()
    await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm2', content: 'later', queue: 'auto' }, ctx())
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'failed', error: { code: 'boom', message: 'x' } })
    await settle(40)
    expect((await store.sessions.get('sess_1'))?.status).toBe('error')
    expect((await store.queues.get('sess_1')).paused).toBe(true)
    expect(runtime.calls.filter(call => call.method === 'prompt')).toHaveLength(0)
    await service.queueOp('sess_1', { kind: 'resume' })
    await settle(40)
    expect(runtime.calls.filter(call => call.method === 'prompt')).toHaveLength(1)
  })
})

describe('runtime events', () => {
  it('coalesces streaming deltas into few commits and publishes them on the ChangeFeed', async () => {
    await makeSession()
    await service.binding('sess_1')
    const notices: number[] = []
    feed.subscribe('sess_1', notice => notices.push(notice.toSeq))
    const runtime = sessions[0]!
    for (let i = 0; i < 50; i++) runtime.emit({ type: 'message.delta', itemId: 'a1', role: 'assistant', text: 'x', turnId: 't' })
    await settle(40)
    ms += 200
    runtime.emit({ type: 'message.completed', itemId: 'a1', role: 'assistant', text: 'x'.repeat(50), turnId: 't' })
    await settle(40)
    const item = await store.timeline.get('sess_1', 'a1')
    expect(item?.content.text).toBe('x'.repeat(50))
    expect(item?.status).toBe('done')
    expect(notices.length).toBeLessThan(10)
  })

  it('keeps the first answer of an interaction and expires it when the turn ends', async () => {
    await makeSession()
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user' })
    runtime.emit({ type: 'interaction.opened', interactionId: 'perm1', kind: 'approval', title: 'Run ls?', options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }, { id: 'deny', label: 'Deny', kind: 'reject_once' }], turnId: 't1' })
    await settle()
    expect((await store.sessions.get('sess_1'))?.status).toBe('waiting_approval')
    expect(await service.respondNotice('sess_1', 'perm1', 'r1', { kind: 'option', optionId: 'allow' })).toEqual({ status: 'responding' })
    await expect(service.respondNotice('sess_1', 'perm1', 'r2', { kind: 'option', optionId: 'deny' })).rejects.toMatchObject({ code: 'interaction_conflict' })
    expect(runtime.calls.filter(call => call.method === 'respond')).toHaveLength(1)
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await settle(40)
    expect(await store.interactions.list('sess_1', true)).toEqual([])
  })

  it('replaces the history on history.reset and raises the fence', async () => {
    await makeSession()
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'message.completed', itemId: 'old', role: 'assistant', text: 'old' })
    await settle()
    runtime.emit({ type: 'history.reset', phase: 'begin', revision: 'r2' })
    runtime.emit({ type: 'message.completed', itemId: 'new', role: 'assistant', text: 'new', replay: true })
    runtime.emit({ type: 'history.reset', phase: 'commit', revision: 'r2' })
    await settle(40)
    expect(await store.timeline.get('sess_1', 'old')).toBeNull()
    expect((await store.timeline.get('sess_1', 'new'))?.content.text).toBe('new')
    const session = await store.sessions.get('sess_1')
    expect(session!.clock.resetSeq).toBeGreaterThan(0)
  })

  it('fails the running turn with an unknown outcome when the Runtime session is lost', async () => {
    await makeSession()
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user' })
    runtime.emit({ type: 'message.delta', itemId: 'a1', role: 'assistant', text: 'partial', turnId: 't1' })
    runtime.emit({ type: 'session.lost', error: { code: 'adapter_exited', message: 'gone' } })
    await settle(40)
    const session = await store.sessions.get('sess_1')
    expect(session).toMatchObject({ status: 'error', activeTurn: null })
    expect((await store.timeline.get('sess_1', 'a1'))?.status).toBe('failed')
    expect((await store.timeline.get('sess_1', 'aa_turn_failed_t1'))?.content).toMatchObject({ kind: 'error' })
    expect(service.isBound('sess_1')).toBe(false)
  })
})

describe('creating sessions', () => {
  it('creates the Conversation, opens a new native session and sends the first message', async () => {
    const result = await service.createSession({ sessionId: 'sess_new', runtimeId: 'rti_pi', runtimeType: 'pi', cwd: '/project', title: 'T', clientMessageId: 'm0', content: 'start' }, ctx('c0'))
    expect(result).toEqual({ delivery: 'accepted', clientMessageId: 'm0' })
    await settle(40)
    expect(opened[0]).toMatchObject({ kind: 'new', spec: { cwd: '/project', title: 'T' } })
    expect((await store.sessions.get('sess_new'))?.externalSessionId).toBe(sessions[0]?.nativeSessionId)
    expect(sessions[0]!.calls[0]).toMatchObject({ method: 'prompt', input: { text: 'start' } })
  })

  it('rejects an unknown runtime with a failed user message', async () => {
    await service.createSession({ sessionId: 'sess_x', runtimeId: 'rti_missing', runtimeType: 'pi', cwd: '/p', clientMessageId: 'm0', content: 'start' }, ctx())
    await settle(40)
    expect((await store.deliveries.get('sess_x', 'm0'))).toMatchObject({ state: 'rejected', errorCode: 'runtime_unavailable' })
    expect((await store.timeline.findByClientMessageId('sess_x', 'm0'))?.status).toBe('failed')
  })
})

describe('command inbox', () => {
  it('records receipts, replays them, and refuses a reused commandId with other input', async () => {
    await makeSession()
    const inbox = new CommandInbox(store, clock, service)
    expect(inbox.routes()).toContain('sessionQueueSendNow')
    expect(inbox.routes()).toContain('sessionCreationBegin')
    const call = { commandId: 'c1', deadline: 'x', inputDigest: 'd1', p: { sessionId: 'sess_1', clientMessageId: 'm1', content: 'hi' } }
    expect(await inbox.handle('sessionSendMessage', call)).toMatchObject({ outcome: 'accepted', r: { delivery: 'accepted' } })
    expect(await inbox.handle('sessionSendMessage', call)).toMatchObject({ outcome: 'accepted' })
    expect(await inbox.handle('sessionSendMessage', { ...call, inputDigest: 'd2' })).toMatchObject({ outcome: 'rejected', e: { code: 'command_conflict' } })
    expect(await inbox.handle('sessionQueueDelete', { commandId: 'c2', deadline: 'x', p: { sessionId: 'sess_1', messageId: 'nope' } })).toMatchObject({ outcome: 'rejected', e: { code: 'queue_item_not_found' } })
    const readers = new DeviceReaders(store, clock.nowIso)
    expect(await readers.commandStatus({ commandId: 'c2' })).toMatchObject({ known: true, outcome: 'rejected' })
    expect(await readers.commandStatus({ commandId: 'zz' })).toEqual({ commandId: 'zz', known: false, outcome: null })
    const results = (await store.outbox.pending(0, 50)).filter(record => record.kind === 'command.result')
    expect(results.map(record => record.payload.commandId)).toEqual(['c1', 'c2'])
  })
})

describe('sync streams', () => {
  it('watch streams client-shaped changes from afterSeq and a snapshot after a reset', async () => {
    await makeSession()
    await store.timeline.apply('sess_1', { upserts: [{ id: 'a', type: 'message', status: 'done', role: 'assistant', orderSeq: 1024, content: { text: 'a' }, source: { runtime: 'pi' }, createdAt: 't' }], at: 't' })
    const abort = new AbortController()
    const stream = watchSession({ store, feed, now: clock.nowIso }, { sessionId: 'sess_1', afterSeq: 0 }, abort.signal)
    const first = await stream.next()
    expect(first.value).toMatchObject({ sessionId: 'sess_1', fromSeq: 1, toSeq: 1, events: [{ type: 'timeline.item_created', cursor: 'seq:1', payload: { item: { id: 'a' } } }] })
    const next = stream.next()
    const commit = await store.timeline.apply('sess_1', { upserts: [{ id: 'a', type: 'message', status: 'done', role: 'assistant', orderSeq: 1024, content: { text: 'a2' }, source: { runtime: 'pi' }, createdAt: 't' }], at: 't' })
    feed.publish({ sessionId: 'sess_1', fromSeq: commit.fromSeq, toSeq: commit.toSeq, resetSeq: 0, reset: false })
    expect((await next).value).toMatchObject({ fromSeq: 2, toSeq: 2, events: [{ type: 'timeline.item_updated' }] })
    const afterReset = stream.next()
    const reset = await store.timeline.apply('sess_1', { upserts: [], replace: {}, at: 't' })
    feed.publish({ sessionId: 'sess_1', fromSeq: reset.fromSeq, toSeq: reset.toSeq, resetSeq: reset.session.clock.resetSeq, reset: true })
    expect((await afterReset).value).toMatchObject({ resetSeq: 3, events: [{ type: 'timeline.snapshot', payload: { items: [] } }] })
    abort.abort()
    expect((await stream.next()).done).toBe(true)
  })

  it('outbox stream resends from the lowest unacknowledged oid with sealed summaries', async () => {
    await makeSession()
    await store.outbox.append('usage.report', null, { tokens: 5 }, 't')
    const signal = new OutboxSignal()
    const abort = new AbortController()
    const stream = outboxStream({ outbox: store.outbox, sealer: plainSealer, signal, pollMs: 50 }, abort.signal)
    const summary = (await stream.next()).value!
    expect(summary).toMatchObject({ m: 'session.summary', p: { summary: { sessionId: 'sess_1', displayDevice: { mode: 'plain', payload: { cwd: '/w' } } } } })
    expect((await stream.next()).value).toMatchObject({ m: 'usage.report', p: { tokens: 5 } })
    abort.abort()
    await store.outbox.ack(summary.oid)
    const again = outboxStream({ outbox: store.outbox, sealer: plainSealer, signal, pollMs: 50 }, new AbortController().signal)
    expect((await again.next()).value).toMatchObject({ m: 'usage.report' })
    await again.return(undefined)
  })

  it('snapshot is client-shaped and chunks reassemble', async () => {
    await makeSession()
    await store.timeline.apply('sess_1', { upserts: [{ id: 'a', type: 'message', status: 'done', role: 'user', orderSeq: 1024, content: { text: '你好'.repeat(500) }, source: { runtime: 'pi' }, createdAt: 't' }], at: 't' })
    const readers = new DeviceReaders(store, clock.nowIso)
    const body = await readers.snapshot({ sessionId: 'sess_1' })
    expect(body).toMatchObject({ historySource: 'live', eventCursor: 'seq:1', timeline: { hasMore: false, nextSeq: 1 }, state: { status: 'idle' } })
    const chunks = chunkJson(body, 700)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(chunk => Buffer.byteLength(chunk.chunk, 'utf8') <= 700)).toBe(true)
    expect(chunks.at(-1)?.end).toBe(true)
    expect(joinChunks(chunks)).toEqual(body)
    expect(await readers.changesSince({ sessionId: 'sess_1', afterSeq: 0 })).toMatchObject({ complete: true, toSeq: 1, events: [{ type: 'timeline.item_created' }] })
    await expect(readers.read({ sessionId: 'nope', mode: 'latest' })).rejects.toMatchObject({ code: 'session_not_found' })
  })
})
