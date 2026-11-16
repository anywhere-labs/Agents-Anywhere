import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, LlmError, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LocalRouter, Mesh, MeshCallError, Router } from 'meshcall'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { corruptHistory } from '../fixtures/corrupt-history.js'
import { mountAgents, TextAdapter, initialSelections } from '../fixtures/agent-runtime.js'
import { MAX_RETAINED_PROJECTIONS, SyncFeed, SYNC_FLUSH_MS, type SyncOperation, type SyncTransport } from '../../src/host/dsh-runtime/sync.js'
import type { SnapshotRequest, SnapshotResult } from '../../src/host/generated/dsh-sync.js'
import type { NativeChange } from '../../src/host/dsh-runtime/native.js'
import { projectHistory } from '../../src/host/dsh-runtime/history.js'
import { nativeSessionId, sessionId } from '../../src/host/dsh-runtime/identity.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { continuationRequestId } from '../../src/host/dsh-runtime/turn-outcome.js'

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 400; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), label)
}

function notifications(operations: SyncOperation[]) {
  return operations.flatMap(op => op.kind === 'notifications'
    ? op.notifications as { method: string, params: Record<string, unknown> }[] : [])
}

interface Batch { subscriptionId: string, batchSeq: number, projectionVersion: number, operations: SyncOperation[] }
interface Capture { request: SnapshotRequest, items: Record<string, unknown>[], result: SnapshotResult }
interface FollowOptions {
  namespace?: string
  checkpoints?: Map<string, unknown>
  onBatch?: (batch: Batch) => void
  /** Runs when a capture starts, before its pages are consumed. */
  snapshot?: (capture: Capture) => Promise<void> | void
}

function follow(native: ReturnType<typeof nativeRuntime> extends Promise<infer T> ? T['ctx']['agentsAnywhereRuntime']['native'] : never,
  options: FollowOptions = {}) {
  const batches: Batch[] = [], errors: unknown[] = [], captures: Capture[] = []
  const checkpoints = options.checkpoints
  const transport: SyncTransport = {
    async ingestBatch(batch) {
      const recorded = batch as unknown as Batch
      batches.push(recorded)
      options.onBatch?.(recorded)
    },
    async loadCheckpoint(id) { return (checkpoints?.get(id) as Record<string, unknown> | undefined) ?? null },
    async saveCheckpoint(id, checkpoint) { checkpoints?.set(id, checkpoint) },
    async deleteCheckpoint(id) { checkpoints?.delete(id) },
    async ingestSnapshot(request, pages) {
      const capture: Capture = { request, items: [], result: { accepted: true } }
      captures.push(capture)
      await options.snapshot?.(capture)
      for await (const page of pages) capture.items.push(...page.items)
      return capture.result
    },
  }
  const feed = new SyncFeed(native, options.namespace ?? 'test', randomUUID(), transport,
    error => errors.push(error), checkpoints !== undefined)
  feed.start()
  return { feed, batches, errors, captures, ops: () => batches.flatMap(b => b.operations) }
}

test('startup invalidation bursts stay bounded and state reads and messaging remain usable', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-startup-invalidations-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const stream = follow(native)
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'test')
  const request = (method: string, params: Record<string, unknown>) => router.request(method, params, AbortSignal.timeout(5_000))
  const notes = () => notifications(stream.ops())
  try {
    // Reconnects and service registration can invalidate the same facts many
    // times while the feed is still uploading its first session snapshots.
    for (let i = 0; i < 12_000; i++) native.commands.invalidate()
    await until(() => notes().some(n => n.method === 'session.inventory.complete'), 'inventory completes despite duplicate invalidations')
    assert.deepEqual(stream.errors, [])
    assert.equal(notes().filter(n => n.method === 'runtime.capability.updated').length, 1)
    assert.equal(notes().filter(n => n.method === 'session.capability.updated').length, 2)
    const completedBatch = stream.batches.find(b => notifications(b.operations).some(n => n.method === 'session.inventory.complete'))!
    assert.equal(notifications(completedBatch.operations).filter(n => n.method === 'session.capability.updated').length, 2,
      'startup state changes and inventory completion share a bounded transport batch')
    const params = { sessionId: sessionId('test', 'persisted-only'), externalSessionId: 'persisted-only' }
    assert.equal((await request('getSessionState', params) as { status: string }).status, 'idle')
    const sent = await request('startTurn', { ...params, content: '继续对话', clientMessageId: 'startup-send' })
    assert.equal((sent as { accepted: boolean }).accepted, true, JSON.stringify(sent))
    await until(() => !!adapter.release, 'message reaches the official Agent loop')
    adapter.release!()
    await until(() => notes().some(n => n.method === 'session.turnEnded'), 'reply and turn completion reach the sync feed')
    // A live projection can recalibrate with a capture (for example when DSH
    // appends a session marker only at restore time); either path delivers the reply.
    assert.ok(JSON.stringify([notes(), stream.captures]).includes('你好'))
    assert.deepEqual(stream.errors, [])
  } finally { router.close(); stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('one corrupt persisted session does not break inventory, healthy streaming or explicit recovery', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-unreadable-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const id = SessionId('persisted-only')
  const entry = (await fixture.ctx.sessionQuery.listSessions()).find(item => item.header.id === id)!
  const path = ({ path: (await (fixture.ctx.sessionPersistence as import('@deepseek-ai/dsh-session-persistence-jsonl').default).resolveCurrentLog(entry.header.id))! }).path
  const original = await readFile(path)
  // A committed turn with a sequence gap reproduces the official reader failure.
  const corrupt = Buffer.concat([original, Buffer.from(`${JSON.stringify({ seq: 1004, time: Date.now(), type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })}\n`)])
  let stream: ReturnType<typeof follow> | undefined
  try {
    await writeFile(path, corrupt)
    await assert.rejects(fixture.ctx.sessionQuery.readSession(id))
    stream = follow(native)
    const notes = () => notifications(stream!.ops())
    await until(() => notes().some(note => note.method === 'session.inventory.complete'), 'healthy inventory completes despite the unreadable session')
    assert.equal((await native.source.state(id)).reason, 'read_failed')
    assert.ok(stream.captures.some(capture => capture.request.sessionId === sessionId('test', 'native-main')))
    assert.ok(!stream.captures.some(capture => capture.request.sessionId === sessionId('test', id)))
    const inventory = notes().find(note => note.method === 'session.inventory.complete')!
    const failed = (inventory.params.sessions as { externalSessionId: string, sourceState: { availability: string, reason: string } }[]).find(item => item.externalSessionId === id)!
    assert.equal(failed.sourceState.availability, 'unavailable')
    assert.equal(failed.sourceState.reason, 'read_failed')
    fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'healthy feedback survives' }] }), { surfaceOp: 'append' })
    await until(() => notes().some(note => note.method === 'timeline.itemUpsert' && JSON.stringify(note.params).includes('healthy feedback survives')), 'healthy live feedback reaches the same stream')
    await writeFile(path, original)
    native.refresh(id)
    await until(() => stream!.captures.some(capture => capture.request.sessionId === sessionId('test', id)), 'explicit refresh retries the repaired session')
    const committed = stream!.captures.filter(capture => capture.request.sessionId === sessionId('test', id)).length
    await writeFile(path, corrupt)
    native.refresh(id)
    await until(() => notes().some(note => note.method === 'session.source.updated' && note.params.externalSessionId === id && note.params.reason === 'read_failed'), 'a later snapshot failure is isolated as well')
    assert.equal(stream!.captures.filter(capture => capture.request.sessionId === sessionId('test', id)).length, committed, 'no empty or partial snapshot replaces the accepted history')
    assert.deepEqual(stream.errors, [])
    assert.equal(Buffer.compare(await readFile(path), corrupt), 0, 'the bridge never repairs or rewrites native history')
  } finally { stream?.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('fast mixed native events flush at 30 Hz with complete final text, tool results and ordered completion', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-flush-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const times: number[] = []
  const stream = follow(native, { onBatch: () => times.push(performance.now()) })
  const { batches, errors, feed } = stream
  const notes = () => notifications(batches.flatMap(batch => batch.operations))
  try {
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
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let held = false
  const stream = follow(native, { snapshot: async () => {
    if (held) return
    held = true
    await gate
  } })
  const { batches, errors, captures } = stream
  const ops = stream.ops
  try {
    await until(() => held, 'first capture was held')
    const count = batches.length
    await delay(40)
    assert.equal(batches.length, count, 'No next batch before the Connector acknowledges the capture')
    fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'baseline race' }] }), { surfaceOp: 'append' })
    fixture.session.append('session/title', { title: 'New title', source: { kind: 'user' }, messageSeqs: [] })
    const brief = fixture.ctx.sessions.prepare(SessionId('brief-session'), { meta: { cwd: home } })
    const detach = fixture.ctx.sessions.enter(brief)
    fixture.ctx.sessions.announce(brief)
    brief.append('turn/start', { turn: 1 })
    brief.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '短暂加载的会话' }] }), { surfaceOp: 'append' })
    brief.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await fixture.ctx.sessions.flush(brief)
    detach()
    release()
    await until(() => notifications(ops()).some(n => n.method === 'session.inventory.complete'), 'initial complete')
    const starts = new Set(captures.map(capture => capture.request.sessionId))
    assert.equal(starts.size, 3, 'blank session is not imported headlessly')
    assert.ok(starts.has(sessionId('test', brief.id)), 'A new session disposed while a capture is in flight still imports its persisted history')
    assert.ok(notifications(ops()).some(n => n.method === 'session.meta.upsert' && n.params.title === 'New title'))
    assert.ok(notifications(ops()).some(n => n.method === 'timeline.itemUpsert' && JSON.stringify(n.params.item).includes('baseline race')))
    const workspace = await fixture.ctx.workspaceRegistry.create(home)
    await workspace.attachSession(fixture.session.id)
    await workspace.setTitle('DSH 项目名称')
    await fixture.ctx.workspaceRegistry.delete(workspace.id)
    native.presence.report('test-client', 1, 'empty-native')
    await delay(SYNC_FLUSH_MS * 3)
    assert.ok(!captures.some(capture => capture.request.sessionId === sessionId('test', 'empty-native')), 'Selecting a draft must not import it')
    native.presence.report('test-client', 2, null)
    await fixture.ctx.workspaceRegistry.archiveSession(fixture.session.id)
    await until(() => notifications(ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === sessionId('test', fixture.session.id) && n.params.availability === 'archived'), 'explicit archive event')
    assert.ok(!notifications(ops()).some(n => n.method.startsWith('workspace.')), 'native projects are not synchronized')
    assert.ok(!JSON.stringify(ops()).includes('DSH 项目名称'))
    assert.ok(!notifications(ops()).some(n => n.method === 'session.source.updated' && n.params.sessionId === sessionId('test', 'empty-native')), 'Draft source notifications must not create empty AA sessions either')
    assert.deepEqual(errors, [])
    assert.deepEqual(batches.map(b => b.batchSeq), batches.map((_, n) => n + 1))
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

/** Holds the first capture until released, like a slow upload during the startup scan. */
function holdFirstCapture() {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const state = { held: false, release }
  return { state, snapshot: async () => {
    if (state.held) return
    state.held = true
    await gate
  } }
}

/** Records the feed's diagnostics events in order. */
function recordDiagnostics(native: { diagnostics: { log: (...args: never[]) => void } }) {
  const events: { event: string, fields: Record<string, unknown> }[] = []
  const log = native.diagnostics.log.bind(native.diagnostics) as (level: string, event: string, fields?: Record<string, unknown>, error?: unknown) => void
  native.diagnostics.log = ((level: string, event: string, fields: Record<string, unknown> = {}, error?: unknown) => {
    events.push({ event, fields }); log(level, event, fields, error)
  }) as never
  return events
}

test('a streaming Agent during a slow startup scan neither overflows the feed nor loses chunks', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stream-flood-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const diagnostics = recordDiagnostics(native)
  const hold = holdFirstCapture()
  const stream = follow(native, { snapshot: hold.snapshot })
  const emit = (change: NativeChange) => (native as unknown as { emit(change: NativeChange): void }).emit(change)
  try {
    await until(() => hold.state.held, 'first capture was held')
    const id = fixture.session.id, throughSeq = Number(fixture.session.seq) - 1
    // Far more native chunks than the feed may buffer, interleaved with status invalidations.
    for (let n = 0; n < 30_000; n++) {
      emit({ type: 'stream', id, turn: 9, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' }, time: n, throughSeq })
      if (n % 10 === 0) emit({ type: 'status', id })
    }
    hold.state.release()
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'inventory completes')
    await until(() => notifications(stream.ops()).some(n => n.method === 'timeline.itemUpsert'
      && (n.params.item as { content: { text?: string } }).content.text === 'x'.repeat(30_000)), 'the merged chunks project the complete draft')
    assert.deepEqual(stream.errors, [])
    assert.ok(!diagnostics.some(entry => entry.event === 'sync.queue_compacted' || entry.event === 'sync.failed'))
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('changes that outpace a slow startup scan recalibrate the noisiest session instead of failing the feed', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-event-flood-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const diagnostics = recordDiagnostics(native)
  const hold = holdFirstCapture()
  const stream = follow(native, { snapshot: hold.snapshot })
  const notes = () => notifications(stream.ops())
  try {
    await until(() => hold.state.held, 'first capture was held')
    fixture.session.append('turn/start', { turn: 2 })
    for (let n = 0; n < 10_500; n++) fixture.session.append('session/title', { title: `title ${n}`, source: { kind: 'user' }, messageSeqs: [] })
    fixture.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    hold.state.release()
    await until(() => notes().some(n => n.method === 'session.inventory.complete'), 'inventory completes')
    await until(() => notes().some(n => n.method === 'session.turnEnded'), 'the retained turn end is still reported')
    assert.deepEqual(stream.errors, [])
    const compacted = diagnostics.find(entry => entry.event === 'sync.queue_compacted')
    assert.ok(compacted, 'the overflow compacts the queue')
    assert.equal(compacted.fields.sessions, 1)
    const platformId = sessionId('test', fixture.session.id)
    const last = stream.captures.findLast(capture => capture.request.sessionId === platformId)!
    assert.equal(last.request.meta.title, 'title 10499', 'the recalibration captures the final state')
    assert.ok(!diagnostics.some(entry => entry.event === 'sync.failed'))
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('an unreachable Server retries the same batch and keeps the feed; any other failure still ends it', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-batch-retry-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  let unavailable = 2
  const stream = follow(native, { onBatch: () => {
    if (unavailable > 0) { unavailable -= 1; throw new MeshCallError('backend_unavailable', 'backend ingest request failed', { retryable: true }) }
  } })
  const refused = follow(native, { onBatch: () => { throw new MeshCallError('INVALID_PARAMS', 'refused') } })
  try {
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'inventory completes after the Server returns')
    assert.deepEqual(stream.errors, [])
    const [first, second, third] = stream.batches
    assert.equal(first!.batchSeq, second!.batchSeq, 'the failed batch goes out again')
    assert.equal(first!.batchSeq, third!.batchSeq)
    assert.deepEqual(first!.operations, third!.operations)
    await until(() => refused.errors.length === 1, 'a refused batch ends the feed')
    assert.equal(refused.batches.length, 1)
  } finally { stream.feed.close(); refused.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('new native drafts sync once after their first real user message, including attachment-only messages', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-first-message-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const stream = follow(native)
  const id = SessionId('new-native-draft')
  const platformId = sessionId('test', id)
  const snapshots = () => stream.captures.filter(capture => capture.request.sessionId === platformId)
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
    await until(() => snapshots().length === 1 && stream.captures.find(capture => capture.request.sessionId === platformId)!.items.length > 0, 'first user message imports the session without waiting for an assistant')
    assert.equal(snapshots().length, 1)
    const items = snapshots().flatMap(capture => capture.items) as unknown as { role: string, source: { nativeMessageId?: string } }[]
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
      if (id === 'injected-only') session.append('user/message', createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'context without a user' }] }), { surfaceOp: 'append' })
      if (id !== 'persisted-draft') session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
      await ctx.sessions.flush(session)
      detach()
    }
    await mountAgents(ctx, adapter)
  })
  const native = fixture.ctx.agentsAnywhereRuntime.native
  let stream = follow(native)
  const imported = () => stream.captures.map(capture => capture.request.sessionId)
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
    await until(() => stream.captures.some(capture => capture.request.sessionId === sessionId('test', handle!.agent.id)), 'native first message is synchronized live')
    assert.deepEqual(stream.errors, [])
    // Disconnect before the turn's tail events reach the first feed. Whether that
    // feed has already checkpointed the tail is a timing accident; closing here
    // keeps the replacement feed's decision deterministic.
    stream.feed.close()
    adapter.release!()
    await handle.agent.whenIdle()
    await fixture.ctx.sessions.flush(handle.agent.session)
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
    assert.ok(stream.captures.some(capture => capture.request.sessionId === sessionId('test', session.id)), 'An older catalog must preserve the newly observed session')
    assert.ok(JSON.stringify([stream.ops(), stream.captures]).includes('first message during scan'))
    assert.deepEqual(stream.errors, [])
  } finally {
    release(); query.listSessions = list; stream.feed.close()
    await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  }
})

/** A test-owned Connector side: its own Router, published rendezvous and a Bridge caller. */
async function connectorSide(home: string) {
  const directory = bridgePath(home)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = `mk_test_${randomUUID().replaceAll('-', '')}`
  const authFile = join(home, 'router-auth.json')
  await writeFile(authFile, JSON.stringify({ api_keys: [{
    id: 'test', key_hash: createHash('sha256').update(key).digest('hex'), roles: ['client', 'server'],
    register: ['aa.dsh.v2.Bridge', 'aa.dsh.v2.Sync'],
    call: ['aa.dsh.v2.Bridge/*', 'aa.dsh.v2.Sync/*', 'meshcall.router.v1.Registry/*'],
  }] }), { mode: 0o600 })
  const endpoint = process.platform === 'win32'
    ? { pipe: `agents-anywhere-test-${randomUUID().replaceAll('-', '')}` }
    // Keep the Unix socket short enough for the portable 103-byte limit.
    : { unixPath: join(tmpdir(), `aa-${randomUUID().slice(0, 8)}.sock`) }
  const router = new LocalRouter(endpoint)
  await router.start()
  await writeFile(join(directory, 'connector.json'), JSON.stringify({
    version: 2, protocol: 'meshcall', instanceId: `test-${randomUUID()}`, pid: process.pid, endpoint, key,
  }), { mode: 0o600 })
  const mesh = new Mesh(new Router(endpoint), { token: key, peerId: 'test-connector' })
  const call = async (method: string, params: Record<string, unknown> = {}) =>
    mesh.unary('aa.dsh.v2.Bridge', method, params, { metadata: { 'aa-session-namespace': 'test' }, timeoutMs: 10_000 })
  return { call,
    ready: async () => {
      for (let attempt = 0; attempt < 500; attempt++) {
        try { await call('initialize', { protocolVersion: '2.0', runtime: 'dsh' }); return }
        catch { await delay(10) }
      }
      assert.fail('the plugin did not register aa.dsh.v2.Bridge on the test Router')
    },
    close: async () => { await mesh.close(); await router.stop() } }
}

test('fresh detail and send checks distinguish archives from persisted and blank sessions', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-source-'))
  const connector = await connectorSide(home)
  const adapter = new TextAdapter()
  let fixture: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  let stream: ReturnType<typeof follow> | undefined
  try {
    fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
    const native = fixture.ctx.agentsAnywhereRuntime.native
    await connector.ready()
    const rpc = connector.call
    const params = (id: string) => ({ sessionId: sessionId('test', id), externalSessionId: id })
    const request = (method: string, id: string) => rpc(method, params(id)) as Promise<{ sourceState: { availability: string }, status: string }>
    assert.equal(fixture.ctx.sessions.get(SessionId('persisted-only')), undefined)
    assert.equal((await request('getSessionState', 'persisted-only')).sourceState.availability, 'available')
    assert.equal((await request('getSessionState', 'empty-native')).sourceState.availability, 'unavailable')
    // No sync subscription exists: detail must consult the current official catalog itself.
    await fixture.ctx.workspaceRegistry.archiveSession(fixture.session.id)
    const archived = await request('getSessionState', fixture.session.id)
    assert.equal(archived.sourceState.availability, 'archived')
    assert.equal(archived.status, 'blocked')
    const sent = await rpc('startTurn', { ...params(fixture.session.id), content: '不可发送', clientMessageId: 'blocked-send' }) as { ok: boolean, code: string }
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'session_archived')
    assert.equal(adapter.requests.length, 0)
    stream = follow(native)
    await until(() => notifications(stream!.ops()).some(n => n.method === 'session.inventory.complete'), 'offline calibration')
    const operations = stream.ops()
    assert.ok(!notifications(operations).some(n => n.method.startsWith('workspace.')))
    const complete = notifications(operations).find(n => n.method === 'session.inventory.complete')!
    assert.ok(JSON.stringify(complete.params.sessions).includes('archived'))
    assert.ok(!stream.captures.some(capture => capture.request.sessionId === sessionId('test', fixture!.session.id)))
    assert.deepEqual(stream.errors, [])
  } finally {
    stream?.feed.close()
    await fixture?.ctx.fiber.dispose(); await connector.close()
    await rm(home, { recursive: true, force: true })
  }
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
    await native.send(id, '第一条', 'client-1', home, true, initialSelections, 'standard')
    await native.send(id, '第一条', 'client-1', home, true, initialSelections, 'standard')
    await until(() => !!adapter.release, 'model started')
    await until(() => {
      const operations = stream.ops()
      const platformId = sessionId('test', id)
      // A newly visible session may capture its first streaming text in its baseline.
      return stream.captures.some(capture => capture.request.sessionId === platformId && JSON.stringify(capture.items).includes('你')) ||
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

// The Python probe builds the Server in-process, so it needs a throwaway PostgreSQL database.
test('official native loop crosses Python and backend despite corrupt history, including two turns, lost ACK and reconnect', { timeout: 75_000, skip: !process.env.AGENT_SERVER_TEST_DB_URL && 'AGENT_SERVER_TEST_DB_URL is not set' }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-pipeline-')))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, async ctx => {
    await corruptHistory(ctx, home)
    await mountAgents(ctx, adapter)
  })
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
        } else if (action.action === 'host-restart') {
          await fixture.plugin.dispose()
          const host = await import('../../lib/index.js')
          fixture.plugin = fixture.ctx.plugin(host, { dshHome: home, stateRoot: join(home, 'account'), connectorSourceDir: home })
          await fixture.plugin.await()
        } else if (action.action === 'offline-message') {
          fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'offline recovery message' }] }), { surfaceOp: 'append' })
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
    assert.match(result.stdout, /offline change=1 delta, 0 snapshots/)
  } finally { closed = true; adapter.release?.(); await mutations; await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})


test('a replacement feed uses Connector checkpoints and uploads only offline deltas', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-checkpoints-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const checkpoints = new Map<string, unknown>()
  let stream = follow(native, { checkpoints })
  try {
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'first inventory')
    assert.equal(stream.captures.length, 2)
    stream.feed.close()
    stream = follow(native, { checkpoints })
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'unchanged reconnect')
    assert.equal(stream.captures.length, 0)
    stream.feed.close()
    fixture.session.append('session/title', { title: 'changed offline', source: { kind: 'user' }, messageSeqs: [] })
    fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'offline delta' }] }), { surfaceOp: 'append' })
    stream = follow(native, { checkpoints })
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'changed reconnect')
    assert.equal(stream.captures.length, 0)
    const delta = notifications(stream.ops()).filter(n => n.method === 'timeline.itemUpsert')
    assert.equal(delta.length, 1)
    assert.ok(JSON.stringify(delta[0]).includes('offline delta'))
    assert.deepEqual(stream.errors, [])
    stream.feed.close()
    // Destroy the plugin Host (including its source caches and projections).
    // Only the Connector-owned, JSON-serializable checkpoints survive.
    const saved = JSON.stringify([...checkpoints])
    await fixture.plugin.dispose()
    fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'changed while Host destroyed' }] }), { surfaceOp: 'append' })
    const host = await import('../../lib/index.js')
    await fixture.ctx.plugin(host, { dshHome: home, stateRoot: join(home, 'account'), connectorSourceDir: home }).await()
    const restored = new Map<string, unknown>(JSON.parse(saved))
    stream = follow(fixture.ctx.agentsAnywhereRuntime.native, { checkpoints: restored })
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'new Host restores Connector checkpoints')
    assert.equal(stream.captures.length, 0)
    const restartDelta = notifications(stream.ops()).filter(n => n.method === 'timeline.itemUpsert')
    assert.equal(restartDelta.length, 1)
    assert.ok(JSON.stringify(restartDelta[0]).includes('changed while Host destroyed'))
    fixture.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'incremental after Host restart' }] }), { surfaceOp: 'append' })
    await until(() => notifications(stream.ops()).some(n => n.method === 'timeline.itemUpsert' && JSON.stringify(n).includes('incremental after Host restart')), 'restored projection handles the next event incrementally')
    assert.equal(stream.captures.length, 0)
    await until(() => (restored.get('native-main') as { throughSeq: number }).throughSeq === Number(fixture.session.seq) - 1, 'live event checkpoint is committed')
    stream.feed.close()
    stream = follow(fixture.ctx.agentsAnywhereRuntime.native, { checkpoints: restored })
    await until(() => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete'), 'live and replay fingerprints agree')
    assert.equal(stream.captures.length, 0)
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('checkpoint mismatches and active turns recalibrate only the affected session', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-fallback-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const checkpoints = new Map<string, unknown>()
  let stream = follow(native, { checkpoints })
  const complete = () => notifications(stream.ops()).some(n => n.method === 'session.inventory.complete')
  try {
    await until(complete, 'initial checkpoints')
    for (const mutation of [{ historyHash: '0'.repeat(64) }, { projectionVersion: 2 }, { projectionVersion: 99 }, { settled: false }]) {
      stream.feed.close()
      checkpoints.set('native-main', { ...checkpoints.get('native-main') as object, ...mutation })
      stream = follow(native, { checkpoints })
      await until(complete, 'incompatible checkpoint recalibrates')
      assert.deepEqual(stream.captures.map(capture => capture.request.sessionId), [sessionId('test', 'native-main')])
      assert.deepEqual(stream.errors, [])
    }
    fixture.session.append('turn/start', { turn: 2 })
    await until(() => (checkpoints.get('native-main') as { settled: boolean }).settled === false, 'active turn never claims a settled checkpoint')
    stream.feed.close()
    stream = follow(native, { checkpoints })
    await until(complete, 'active reconnect')
    assert.deepEqual(stream.captures.map(capture => capture.request.sessionId), [sessionId('test', 'native-main')])
    native.refresh('persisted-only')
    await until(() => stream.captures.some(capture => capture.request.sessionId === sessionId('test', 'persisted-only')), 'manual refresh bypasses a matching checkpoint')
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

/** Idle live sessions beyond the projection budget, each with one completed turn. */
async function idleSessions(fixture: Awaited<ReturnType<typeof nativeRuntime>>, home: string): Promise<Session[]> {
  const sessions: Session[] = []
  for (let i = 0; i < MAX_RETAINED_PROJECTIONS + 3; i++) {
    const live = fixture.ctx.sessions.create(SessionId(`live-extra-${i}`), { meta: { cwd: home, createdAt: i + 10 } })
    appendTurn(live, 1, `initial-${i}`)
    await fixture.ctx.sessions.flush(live)
    sessions.push(live)
  }
  return sessions
}

/** A message reaches the platform either as an incremental item or inside a full capture. */
function delivered(stream: ReturnType<typeof follow>, text: string): boolean {
  return notifications(stream.ops()).some(n => n.method === 'timeline.itemUpsert' && JSON.stringify(n.params).includes(text))
    || stream.captures.some(capture => JSON.stringify(capture.items).includes(text))
}

function appendTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('startup scan releases cold observations and evicted sessions resume from their durable checkpoints', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-scan-memory-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const sessions = await idleSessions(fixture, home)
  // Records which sessions the feed restores from their Connector checkpoint.
  const restored: string[] = []
  const checkpoints = new class extends Map<string, unknown> {
    override get(id: string) { restored.push(id); return super.get(id) }
  }()
  const stream = follow(native, { checkpoints })
  const notes = () => notifications(stream.ops())
  try {
    await until(() => notes().some(n => n.method === 'session.inventory.complete'), 'inventory completes')
    assert.equal(native.source.retainedLogCount, 0, 'cold session observations are released after baseline')
    assert.ok(stream.feed.retainedProjectionCount <= MAX_RETAINED_PROJECTIONS, 'settled projections are bounded by MAX_RETAINED_PROJECTIONS')
    const captures = stream.captures.length
    restored.length = 0

    // LRU trimming evicted the earliest session's settled projection during the scan.
    appendTurn(sessions[0]!, 2, 'after-eviction-delta')
    await until(() => delivered(stream, 'after-eviction-delta'), 'the evicted session delivers its new message')
    assert.deepEqual(restored, ['live-extra-0'], 'only the evicted session resumes from its checkpoint')
    assert.equal(stream.captures.length, captures, 'a resumed session does not re-upload its history')
    await until(() => stream.feed.retainedProjectionCount <= MAX_RETAINED_PROJECTIONS, 'projections are trimmed again after the update')
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('feeds without durable checkpoints keep settled projections instead of re-uploading evicted sessions', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-scan-memory-volatile-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const sessions = await idleSessions(fixture, home)
  const stream = follow(native)
  const notes = () => notifications(stream.ops())
  try {
    await until(() => notes().some(n => n.method === 'session.inventory.complete'), 'inventory completes')
    assert.equal(native.source.retainedLogCount, 0, 'observations are released without durable checkpoints too')
    const captures = stream.captures.length
    appendTurn(sessions[0]!, 2, 'volatile-delta')
    await until(() => delivered(stream, 'volatile-delta'), 'the earliest session delivers its new message')
    assert.equal(stream.captures.length, captures, 'the kept projection sends only the delta')
    assert.deepEqual(stream.errors, [])
  } finally { stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('a session someone works in streams before the startup scan finishes', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-during-scan-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const emit = (change: NativeChange) => (native as unknown as { emit(change: NativeChange): void }).emit(change)
  // Two more persisted, unloaded sessions so the scan outlasts the live changes.
  for (const name of ['cold-a', 'cold-b']) {
    const cold = fixture.ctx.sessions.prepare(SessionId(name), { meta: { cwd: home } })
    const detach = fixture.ctx.sessions.enter(cold)
    fixture.ctx.sessions.announce(cold)
    cold.append('turn/start', { turn: 1 })
    cold.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: name }] }), { surfaceOp: 'append' })
    cold.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await fixture.ctx.sessions.flush(cold)
    detach()
  }
  const live = sessionId('test', fixture.session.id)
  // Every capture but the loaded session's waits until the test lets it through.
  const held: { id: string, release: () => void }[] = []
  const stream = follow(native, { snapshot: async capture => {
    if (capture.request.sessionId === live) return
    const id = String((capture.request.meta as Record<string, unknown>).externalSessionId)
    await new Promise<void>(release => { held.push({ id, release }) })
  } })
  const notes = () => notifications(stream.ops())
  const complete = () => notes().some(n => n.method === 'session.inventory.complete')
  const captured = (id: string) => stream.captures.filter(capture => capture.request.sessionId === sessionId('test', id)).length
  try {
    await until(() => held.length === 1, 'the scan reached an unloaded session')
    assert.equal(stream.captures[0]!.request.sessionId, live, 'a session loaded in DSH is scanned first')
    const [first] = held
    const other = ['cold-a', 'cold-b', 'persisted-only'].find(id => id !== first!.id)!
    fixture.session.append('session/title', { title: '扫描中的新标题', source: { kind: 'user' }, messageSeqs: [] })
    emit({ type: 'status', id: other })
    first!.release()
    // The next unloaded session is the one with a queued change, captured ahead of its turn in the scan.
    await until(() => held.length === 2, 'the session with a queued change was captured early')
    assert.equal(held[1]!.id, other)
    assert.ok(notes().some(n => n.method === 'session.meta.upsert' && n.params.sessionId === live && n.params.title === '扫描中的新标题'),
      'the live change of an imported session is delivered during the scan')
    assert.ok(!complete(), 'the scan is still running')
    for (let n = 1; ; n++) {
      held[n]?.release()
      if (complete()) break
      await until(() => complete() || held.length > n + 1, 'the scan proceeds')
    }
    for (const entry of held) entry.release()
    await until(complete, 'inventory completes')
    assert.equal(captured(fixture.session.id), 1)
    assert.equal(captured(other), 1, 'a session imported early is not captured again by the scan')
    assert.deepEqual(stream.errors, [])
    assert.deepEqual(stream.batches.map(b => b.batchSeq), stream.batches.map((_, n) => n + 1))
  } finally {
    for (const entry of held) entry.release()
    stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  }
})

test('a failed turn or a turn without a reply opens an error card that the next turn closes (#543)', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-turn-outcome-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const stream = follow(native)
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'test')
  const params = { sessionId: sessionId('test', fixture.session.id), externalSessionId: fixture.session.id }
  type Notice = { noticeId: string, status: string, severity: string, interactionType: string, message: string,
    blocking: unknown, responseRequired: boolean, context: Record<string, unknown> }
  const cards = () => notifications(stream.ops()).filter(note => note.method === 'notice.upsert')
    .map(note => note.params as unknown as Notice).filter(notice => notice.context.kind === 'execution_error')
  const readNotices = async () => ((await router.request('getSessionNotices', params, AbortSignal.timeout(5_000))) as { notices: Notice[] })
    .notices.filter(notice => notice.context.kind === 'execution_error')
  try {
    await until(() => notifications(stream.ops()).some(note => note.method === 'session.inventory.complete'), 'baseline')
    assert.deepEqual(await readNotices(), [], 'a session whose last turn replied has no card')

    fixture.session.append('turn/start', { turn: 2 })
    fixture.session.append('step/start', { turn: 2, step: 1 })
    fixture.session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'provider overloaded', code: 'RATE_LIMITED' } } })
    await until(() => cards().length === 1, 'the failed turn opens a card')
    const failed = cards()[0]!
    assert.equal(failed.status, 'open')
    assert.equal(failed.severity, 'error')
    assert.equal(failed.interactionType, 'execution_error')
    assert.equal(failed.message, 'provider overloaded')
    assert.equal(failed.blocking, null, 'the card never locks the composer')
    assert.equal(failed.responseRequired, false)
    assert.deepEqual((failed.context.error as Record<string, unknown>).code, 'RATE_LIMITED')
    assert.deepEqual((await readNotices()).map(notice => [notice.noticeId, notice.status]), [[failed.noticeId, 'open']],
      'a client that reloads still sees the card')

    // DSH ends a turn as completed without calling the model when a pre-step
    // hook has nothing to send; the user saw no reply at all.
    fixture.session.append('turn/start', { turn: 3 })
    fixture.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await until(() => cards().length === 3, 'the next turn closes the card and its empty ending opens another')
    assert.deepEqual(cards().slice(1).map(notice => [notice.noticeId === failed.noticeId, notice.status, notice.severity]),
      [[true, 'closed', 'error'], [false, 'open', 'warning']])
    const empty = cards()[2]!
    assert.equal(empty.context.outcome, 'no_reply')
    assert.equal(empty.context.steps, 0)

    fixture.session.append('turn/start', { turn: 4 })
    fixture.session.append('step/start', { turn: 4, step: 1 })
    fixture.session.append('assistant/message', { turn: 4, step: 1, message: createAssistantMessage({
      source: { provider: 'test', model: 'text' }, content: [{ type: 'text', text: '好的' }],
    }) }, { surfaceOp: 'append' })
    fixture.session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    fixture.session.append('turn/start', { turn: 5 })
    fixture.session.append('turn/end', { turn: 5, reason: { kind: 'interrupted' } })
    await until(() => notifications(stream.ops()).filter(note => note.method === 'session.turnEnded').length === 4, 'all turns end')
    await delay(SYNC_FLUSH_MS * 3)
    assert.deepEqual(cards().slice(3).map(notice => [notice.noticeId, notice.status]), [[empty.noticeId, 'closed']],
      'a turn with a reply or one the user interrupted opens no card')
    assert.deepEqual(await readNotices(), [])
    assert.deepEqual(stream.errors, [])
  } finally { router.close(); stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

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

test('a failure DSH can continue offers to continue on its card, without resending the message', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-turn-continue-'))
  const adapter = new FlakyAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const stream = follow(native)
  const router = new RuntimeRouter({ native, query: fixture.ctx.sessionQuery, status: id => native.status(id) }, 'test')
  const request = (method: string, params: Record<string, unknown>) => router.request(method, params, AbortSignal.timeout(5_000))
  const id = SessionId(nativeSessionId('test', 'sess_continue'))
  const params = { sessionId: 'sess_continue', externalSessionId: id }
  type Notice = { noticeId: string, status: string, actions: { actionId: string }[], context: Record<string, unknown>,
    metadata: { turnEndSeq: number } }
  const cards = () => notifications(stream.ops()).filter(note => note.method === 'notice.upsert')
    .map(note => note.params as unknown as Notice).filter(notice => notice.context.kind === 'execution_error')
  const opened = (count: number) => until(() => cards().filter(card => card.status === 'open').length === count, `card ${count} opens`)
  const readCards = async () => ((await request('getSessionNotices', params)) as { notices: Notice[] })
    .notices.filter(notice => notice.context.kind === 'execution_error')
  const send = (clientMessageId: string, content: string) => request('startTurn', { ...params, clientMessageId, content })
  const respond = (noticeId: string) => request('respondInteraction', { ...params, noticeId, actionId: 'continue', inputData: {} })
  const continued = (noticeId: string) => ({ ok: true, result: { resolved: true, noticeId, sessionId: 'sess_continue' } })
  const unavailable = { ok: false, code: 'dsh_continue_unavailable', message: '这一轮已无法继续生成，请重新发送消息。' }
  const idle = () => fixture.ctx.agents.get(id)!.whenIdle()
  try {
    await until(() => notifications(stream.ops()).some(note => note.method === 'session.inventory.complete'), 'baseline')
    adapter.failures.push('SERVER')
    assert.equal((await request('createAndStartSession', { sessionId: 'sess_continue', clientMessageId: 'first', content: '你好',
      cwd: home, agentPreset: 'standard', selections: initialSelections }) as { accepted: boolean }).accepted, true)
    await opened(1)
    const failed = cards()[0]!
    assert.deepEqual(failed.actions, [{ actionId: 'continue', label: '继续', style: 'primary' }])
    assert.deepEqual((await readCards()).map(card => [card.noticeId, card.actions]), [[failed.noticeId, failed.actions]],
      'a client that reloads can continue too')

    assert.deepEqual(await respond(failed.noticeId), continued(failed.noticeId))
    await until(() => adapter.requests.length === 2 && !!adapter.release, 'DSH retries the request in a new turn')
    await until(() => cards().some(card => card.noticeId === failed.noticeId && card.status === 'closed'), 'the new turn closes the card')
    assert.deepEqual(await respond(failed.noticeId), continued(failed.noticeId), 'a repeated response is a no-op')
    adapter.release!()
    await idle()
    assert.equal(adapter.requests.length, 2)
    const events = fixture.ctx.sessions.get(id)!.snapshotEvents()
    const retries = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'retry' ? [event.data] : [])
    assert.deepEqual(retries.map(message => [message.content, (message.source as { rpcId?: string }).rpcId]),
      [[[], continuationRequestId(id, failed.metadata.turnEndSeq)]])
    assert.deepEqual(projectHistory(await native.read(id), 'sess_continue').filter(item => item.role === 'user')
      .map(item => item.content.text), ['你好'], 'the empty retry message never shows as a bubble')
    assert.deepEqual(await readCards(), [])

    // Resending instead of continuing makes the card stale, even while a newer failure can continue.
    adapter.failures.push('TIMEOUT', 'SERVER')
    await send('second', '再试一次')
    await opened(2)
    const stale = cards().at(-1)!
    assert.deepEqual(stale.actions.map(action => action.actionId), ['continue'])
    await send('third', '换个说法')
    await opened(3)
    const latest = cards().at(-1)!
    assert.notEqual(latest.noticeId, stale.noticeId)
    assert.deepEqual(await respond(stale.noticeId), unavailable)
    assert.equal(adapter.requests.length, 4, 'the stale card never continues the newer failure')
    assert.deepEqual(await respond(latest.noticeId), continued(latest.noticeId))
    await until(() => adapter.requests.length === 5 && !!adapter.release, 'the latest failure continues')
    adapter.release!()
    await idle()

    adapter.failures.push('AUTH')
    await send('fourth', '最后一次')
    await opened(4)
    const final = cards().at(-1)!
    assert.deepEqual(final.actions, [], 'DSH does not continue an authentication failure')
    assert.deepEqual((await readCards()).map(card => card.actions), [[]])
    assert.deepEqual(await respond(final.noticeId), unavailable)
    assert.equal(adapter.requests.length, 6)
    assert.deepEqual(stream.errors, [])
  } finally { adapter.release?.(); router.close(); stream.feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
