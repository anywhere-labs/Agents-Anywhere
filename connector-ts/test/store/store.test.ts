import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TimelineDraft } from '../../src/domain/conversation/index.js'
import { finalize, initialPlanning, observeMode } from '../../src/domain/planning/index.js'
import { initialGoalState, observe } from '../../src/domain/goals/index.js'
import { STRING_MAX, inProcessStore, openSqliteStore, openStoreWorker, type RemoteStore, type SyncStore } from '../../src/store/index.js'
import { TS_WORKER_EXEC_ARGV } from '../support/worker.js'

let dir: string
let sync: SyncStore
let store: RemoteStore
let tick = 0
const now = () => `2026-11-16T00:00:${String(tick++).padStart(2, '0')}.000Z`

const message = (id: string, text: string, order: number, patch: Partial<TimelineDraft> = {}): TimelineDraft => ({
  id, type: 'message', status: 'done', role: 'assistant', orderSeq: order, content: { text }, source: { runtime: 'codex' }, createdAt: 't', ...patch,
})

async function createSession(sessionId = 'sess_1') {
  return store.sessions.create({
    sessionId, runtimeType: 'codex', runtimeId: 'rti_1', externalSessionId: `th_${sessionId}`, cwd: '/work', nativeTitle: 'Title',
    status: 'idle', sourceAvailability: 'available', takeover: true, at: now(),
  })
}

beforeEach(() => {
  tick = 0
  dir = mkdtempSync(join(tmpdir(), 'aa-store-'))
  sync = openSqliteStore({ dataDir: dir, durability: 'normal', now })
  store = inProcessStore(sync)
})

afterEach(async () => {
  await store.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('sessions and clock', () => {
  it('creates sessions idempotently and queues one summary', async () => {
    expect((await createSession()).created).toBe(true)
    expect((await createSession()).created).toBe(false)
    const outbox = await store.outbox.pending(0, 10)
    expect(outbox.map(record => record.kind)).toEqual(['session.summary'])
    expect(outbox[0]?.payload.summary).toMatchObject({ sessionId: 'sess_1', headSeq: 0, display: { title: 'Title', cwd: '/work' } })
  })

  it('stamps each change with the next sequence and skips identical replays', async () => {
    await createSession()
    const first = await store.timeline.apply('sess_1', { upserts: [message('a', 'one', 1024), message('b', 'two', 2048)], at: now() })
    expect([first.fromSeq, first.toSeq]).toEqual([1, 2])
    const replay = await store.timeline.apply('sess_1', { upserts: [message('a', 'one', 1024)], at: now() })
    expect(replay.changed).toEqual([])
    expect([replay.fromSeq, replay.toSeq]).toEqual([2, 2])
    const edit = await store.timeline.apply('sess_1', { upserts: [message('a', 'one!', 1024)], at: now() })
    expect(edit.changed[0]).toMatchObject({ id: 'a', revision: 2, updatedSeq: 3 })
  })

  it('pages by order and by bytes, newest first', async () => {
    await createSession()
    const drafts = Array.from({ length: 30 }, (_, i) => message(`m${i}`, `text ${i}`, (i + 1) * 1024))
    await store.timeline.apply('sess_1', { upserts: drafts, at: now() })
    const latest = await store.timeline.read('sess_1', 'latest', null, 10, 0)
    expect(latest.items.map(i => i.id)).toEqual(drafts.slice(20).map(d => d.id))
    expect(latest.hasMore).toBe(true)
    const before = await store.timeline.read('sess_1', 'before', latest.oldestOrderSeq, 10, 0)
    expect(before.items.map(i => i.id)).toEqual(drafts.slice(10, 20).map(d => d.id))
    const small = await store.timeline.read('sess_1', 'latest', null, 30, 1500)
    expect(small.items.length).toBeLessThan(30)
    expect(small.items.at(-1)?.id).toBe('m29')
    expect(small.hasMore).toBe(true)
    const after = await store.timeline.read('sess_1', 'after', 1024, 3, 0)
    expect(after.items.map(i => i.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('serves changes since a cursor and asks for a snapshot after a reset or a deletion', async () => {
    await createSession()
    await store.timeline.apply('sess_1', { upserts: [message('a', '1', 1), message('b', '2', 2)], at: now() })
    const changes = await store.timeline.changesSince('sess_1', 1, 100, 0)
    expect(changes).toMatchObject({ complete: true, snapshotRequired: false, toSeq: 2 })
    expect(changes.items.map(i => i.id)).toEqual(['b'])
    expect(await store.timeline.changesSince('sess_1', 2, 100, 0)).toMatchObject({ complete: true, items: [] })

    const replaced = await store.timeline.apply('sess_1', { upserts: [message('a', '1', 1)], replace: {}, at: now() })
    expect(replaced.reset).toBe(true)
    expect(replaced.deleted).toEqual(['b'])
    expect(replaced.session.clock.resetSeq).toBe(3)
    expect((await store.timeline.changesSince('sess_1', 2, 100, 0)).snapshotRequired).toBe(true)
    expect((await store.timeline.changesSince('sess_1', replaced.session.clock.headSeq, 100, 0)).snapshotRequired).toBe(false)

    await store.timeline.apply('sess_1', { upserts: [message('c', '3', 3)], at: now() })
    const head = (await store.sessions.get('sess_1'))!.clock.headSeq
    await store.timeline.apply('sess_1', { upserts: [], deletes: ['c'], at: now() })
    expect((await store.timeline.changesSince('sess_1', head, 100, 0)).snapshotRequired).toBe(true)
  })

  it('jumps past the Server floor and restamps every item', async () => {
    await createSession()
    await store.timeline.apply('sess_1', { upserts: [message('a', '1', 1), message('b', '2', 2)], at: now() })
    expect(await store.sessions.applySeqFloors({ sess_1: 1203, sess_unknown: 5 })).toEqual(['sess_1'])
    const session = await store.sessions.get('sess_1')
    expect(session?.clock).toEqual({ headSeq: 1206, resetSeq: 1204 })
    expect((await store.timeline.get('sess_1', 'a'))?.updatedSeq).toBe(1205)
    expect(await store.sessions.applySeqFloors({ sess_1: 10 })).toEqual([])
    expect(await store.sessions.heads()).toEqual([{ sessionId: 'sess_1', headSeq: 1206, resetSeq: 1204 }])
  })

  it('keeps the floor of a session it does not have yet and starts that session above it', async () => {
    // A reinstall: the Server remembers sess_2 at 1203, the native rescan recreates it only after hello.
    expect(await store.sessions.applySeqFloors({ sess_2: 900 })).toEqual([])
    expect(await store.sessions.applySeqFloors({ sess_2: 1203 })).toEqual([])
    expect(await store.sessions.applySeqFloors({ sess_2: 1000 })).toEqual([])
    // The floor survives a restart before the rescan.
    await store.close()
    sync = openSqliteStore({ dataDir: dir, durability: 'normal', now })
    store = inProcessStore(sync)
    const { session } = await createSession('sess_2')
    expect(session.clock).toEqual({ headSeq: 1204, resetSeq: 1204 })
    const commit = await store.timeline.apply('sess_2', { upserts: [message('a', 'rebuilt', 1)], at: now() })
    expect(commit.changed[0]?.updatedSeq).toBe(1205)
    // A client at seq:1203 from the lost store is below the fence: it takes a snapshot.
    expect((await store.timeline.changesSince('sess_2', 1203, 100, 0)).snapshotRequired).toBe(true)
    const summaries = (await store.outbox.pending(0, 10)).filter(record => record.kind === 'session.summary' && record.sessionId === 'sess_2')
    expect(summaries[0]?.payload.summary).toMatchObject({ headSeq: 1204 })
    // Used once: the floor no longer applies to this session through `create`, only through the clock.
    expect(await store.sessions.applySeqFloors({ sess_2: 1203 })).toEqual([])
    const raw = new DatabaseSync(join(dir, 'store.sqlite'))
    expect(raw.prepare('SELECT COUNT(*) AS n FROM seq_floors').get()).toEqual({ n: 0 })
    raw.close()
    // A session nobody gave a floor for still starts at 0.
    expect((await createSession('sess_3')).session.clock).toEqual({ headSeq: 0, resetSeq: 0 })
  })
})

describe('byte budget', () => {
  it('moves long strings and inline media into blobs and keeps a preview', async () => {
    await createSession()
    const long = 'x'.repeat(STRING_MAX + 10)
    const image = Buffer.alloc(3000, 7).toString('base64')
    const draft: TimelineDraft = {
      id: 't1', type: 'tool', status: 'done', role: null, orderSeq: 1, source: { runtime: 'codex' }, createdAt: 't',
      content: { output: long, result: [{ type: 'image', data: image, mimeType: 'image/png' }] },
    }
    const commit = await store.timeline.apply('sess_1', { upserts: [draft], at: now() })
    const item = commit.changed[0]!
    expect(item.blobRefs?.map(ref => ref.path)).toEqual(['/output', '/result/0/data'])
    expect(String(item.content.output).length).toBeLessThan(10_000)
    expect((item.content.result as { omitted?: string }[])[0]?.omitted).toContain('图片')
    const outputRef = item.blobRefs![0]!
    expect(Buffer.from((await store.blobs.read(outputRef.blobId))!).toString('utf8')).toBe(long)
    expect((await store.blobs.read(item.blobRefs![1]!.blobId))!.byteLength).toBe(3000)
    // The same draft again is unchanged: slimming is deterministic.
    expect((await store.timeline.apply('sess_1', { upserts: [draft], at: now() })).changed).toEqual([])
  })
})

describe('blob lifecycle', () => {
  const tool = (id: string, output: string, status: TimelineDraft['status'], order = 1): TimelineDraft => ({
    id, type: 'tool', status, role: null, orderSeq: order, source: { runtime: 'codex' }, createdAt: 't', content: { output },
  })
  /** Finished blob files on disk (temporary files excluded). */
  const blobFiles = (): string[] => {
    const root = join(dir, 'blobs')
    return readdirSync(root).flatMap(shard => readdirSync(join(root, shard)).filter(name => /^[0-9a-f]{64}$/u.test(name)))
  }
  const blobRows = (): number => Number((new DatabaseSync(join(dir, 'store.sqlite'), { readOnly: true }).prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n)

  it('writes no blob while a long output streams, and one when it finishes', async () => {
    await createSession()
    let text = ''
    for (let i = 0; i < 40; i++) {
      text += `line ${i} `.padEnd(64 * 1024 - 16, '.') + `end ${i}`.padEnd(16)
      const commit = await store.timeline.apply('sess_1', { upserts: [tool('t1', text, 'running')], at: now() })
      const item = commit.changed[0]!
      expect(item.blobRefs).toBeUndefined()
      expect(String(item.content.output)).toContain('输出进行中')
    }
    expect(blobFiles()).toEqual([])
    const done = (await store.timeline.apply('sess_1', { upserts: [tool('t1', text, 'done')], at: now() })).changed[0]!
    expect(done.blobRefs).toHaveLength(1)
    expect(Buffer.from((await store.blobs.read(done.blobRefs![0]!.blobId))!).toString('utf8')).toBe(text)
    expect(blobFiles()).toHaveLength(1)
  })

  it('deletes a blob and its file once no item points at it, and keeps one another item still uses', async () => {
    await createSession()
    const a = 'a'.repeat(STRING_MAX + 1)
    const b = 'b'.repeat(STRING_MAX + 1)
    const first = (await store.timeline.apply('sess_1', { upserts: [tool('t1', a, 'done', 1), tool('t2', a, 'done', 2)], at: now() })).changed
    expect(first[0]!.blobRefs![0]!.blobId).toBe(first[1]!.blobRefs![0]!.blobId)
    expect(blobFiles()).toHaveLength(1)
    // t1 gets new content: the shared blob stays for t2.
    await store.timeline.apply('sess_1', { upserts: [tool('t1', b, 'done', 1)], at: now() })
    expect(blobFiles()).toHaveLength(2)
    // t2 is deleted: nothing points at the first blob any more.
    await store.timeline.apply('sess_1', { upserts: [], deletes: ['t2'], at: now() })
    expect(blobFiles()).toHaveLength(1)
    expect(await store.blobs.read(first[1]!.blobRefs![0]!.blobId)).toBeNull()
    // A full replace without t1 drops the last one.
    await store.timeline.apply('sess_1', { upserts: [], replace: {}, at: now() })
    expect(blobFiles()).toEqual([])
    expect(blobRows()).toBe(0)
  })

  it('keeps blobs put through the repository, and sweeps orphans and stray files at open', async () => {
    await createSession()
    const kept = await store.blobs.put(new Uint8Array([1, 2, 3]), { mediaType: null, origin: 'upload', at: 't' })
    await store.timeline.apply('sess_1', { upserts: [tool('t1', 'z'.repeat(STRING_MAX + 1), 'done')], at: now() })
    await store.close()
    const raw = new DatabaseSync(join(dir, 'store.sqlite'))
    // A crash between a blob write and its item: a timeline blob row nothing points at.
    raw.exec("DELETE FROM blob_refs")
    raw.close()
    const root = join(dir, 'blobs')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    mkdirSync(join(root, 'ab'), { recursive: true })
    const stray = join(root, 'ab', `ab${'0'.repeat(62)}`)
    const tmp = join(root, 'ab', `ab${'1'.repeat(62)}.tmp-1-abcd`)
    const young = join(root, 'ab', `ab${'2'.repeat(62)}`)
    for (const file of [stray, tmp, young]) writeFileSync(file, 'x')
    utimesSync(stray, old, old)
    utimesSync(tmp, old, old)
    sync = openSqliteStore({ dataDir: dir, durability: 'normal', now })
    store = inProcessStore(sync)
    expect(existsSync(stray)).toBe(false)
    expect(existsSync(tmp)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(Array.from((await store.blobs.read(kept.blobId))!)).toEqual([1, 2, 3])
    expect(blobRows()).toBe(1)
  })

  it('knows which session points at a blob', async () => {
    await createSession()
    await createSession('sess_2')
    const item = (await store.timeline.apply('sess_1', { upserts: [tool('t1', 'r'.repeat(STRING_MAX + 1), 'done')], at: now() })).changed[0]!
    const blobId = item.blobRefs![0]!.blobId
    expect(await store.blobs.referencedBy('sess_1', blobId)).toBe(true)
    expect(await store.blobs.referencedBy('sess_2', blobId)).toBe(false)
  })

  it('fills the references of items stored before the reference table', async () => {
    await createSession()
    const item = (await store.timeline.apply('sess_1', { upserts: [tool('t1', 'q'.repeat(STRING_MAX + 1), 'done')], at: now() })).changed[0]!
    await store.close()
    const raw = new DatabaseSync(join(dir, 'store.sqlite'))
    raw.exec("DROP TABLE blob_refs; UPDATE meta SET value = '4' WHERE key = 'schema_version'")
    raw.close()
    sync = openSqliteStore({ dataDir: dir, durability: 'normal', now })
    store = inProcessStore(sync)
    expect(Buffer.from((await store.blobs.read(item.blobRefs![0]!.blobId))!).toString('utf8')).toHaveLength(STRING_MAX + 1)
    await store.timeline.apply('sess_1', { upserts: [], deletes: ['t1'], at: now() })
    expect(blobFiles()).toEqual([])
  })
})

describe('deliveries and queue', () => {
  const userItem = (id: string): TimelineDraft => message(`tl_${id}`, 'hello', 100, { role: 'user', status: 'pending', source: { runtime: 'platform', clientMessageId: id } })

  it('writes the delivery and the pending user message in one transaction, once', async () => {
    await createSession()
    const input = { sessionId: 'sess_1', clientMessageId: 'm1', inputDigest: 'd1', userItem: userItem('m1'), enqueue: null, commandId: 'c1', at: now() }
    const first = await store.deliveries.receive(input)
    expect(first).toMatchObject({ duplicate: false, delivery: { state: 'accepted' } })
    expect(first.commit?.changed[0]?.id).toBe('tl_m1')
    expect((await store.timeline.findByClientMessageId('sess_1', 'm1'))?.id).toBe('tl_m1')
    const again = await store.deliveries.receive(input)
    expect(again.duplicate).toBe(true)
    await expect(store.deliveries.receive({ ...input, inputDigest: 'd2' })).rejects.toMatchObject({ code: 'delivery_conflict' })
    await store.deliveries.transition('sess_1', 'm1', 'sending', { at: now() })
    expect((await store.deliveries.inFlight()).map(d => d.clientMessageId)).toEqual(['m1'])
  })

  it('queues without a timeline item and settles the delivery as the queue moves', async () => {
    await createSession()
    const queued = await store.deliveries.receive({
      sessionId: 'sess_1', clientMessageId: 'm2', inputDigest: 'd', userItem: null, commandId: null, at: now(),
      enqueue: { mode: 'auto', item: { messageId: 'qmsg_1', sessionId: 'sess_1', clientMessageId: 'm2', content: 'later', attachments: [], createdBy: 'u', createdAt: 't', updatedAt: 't' } },
    })
    expect(queued).toMatchObject({ delivery: { state: 'queued' }, queueItem: { messageId: 'qmsg_1' }, commit: null })
    await store.queues.apply('sess_1', { kind: 'markSending', messageId: 'qmsg_1' }, now())
    expect((await store.deliveries.get('sess_1', 'm2'))?.state).toBe('sending')
    await store.queues.apply('sess_1', { kind: 'markFailed', messageId: 'qmsg_1', error: { code: 'queue_dispatch_unknown', message: 'x' } }, now())
    expect((await store.deliveries.get('sess_1', 'm2'))?.state).toBe('unknown')
    await store.queues.apply('sess_1', { kind: 'retry', messageId: 'qmsg_1' }, now())
    expect((await store.deliveries.get('sess_1', 'm2'))?.state).toBe('queued')
    await expect(store.queues.apply('sess_1', { kind: 'remove', messageId: 'nope' }, now())).rejects.toMatchObject({ code: 'queue_item_not_found' })
    expect((await store.queues.nonEmpty()).map(q => q.sessionId)).toEqual(['sess_1'])
  })
})

describe('interactions, planning, goals, commands, outbox, kv', () => {
  it('takes the first answer only, across calls', async () => {
    await createSession()
    await store.interactions.save({ sessionId: 'sess_1', noticeId: 'n1', kind: 'approval', state: 'open', blocking: true, payload: { title: 'Run?' }, responseId: null, resolution: null, openedAt: 't', resolvedAt: null })
    expect((await store.interactions.respond('sess_1', 'n1', 'r1')).kind).toBe('accepted')
    await expect(store.interactions.respond('sess_1', 'n1', 'r2')).rejects.toMatchObject({ code: 'interaction_conflict' })
    expect((await store.interactions.expireBlocking('sess_1', 'turn_ended', now())).map(i => i.state)).toEqual(['expired'])
    expect(await store.interactions.allActive()).toEqual([])
  })

  it('keeps every plan revision and reports only the plan state', async () => {
    await createSession()
    const done = finalize(observeMode(initialPlanning('sess_1', 'codex', 'e'), 'plan'), { nativeId: 'n', text: '# P\nsecret plan', turnId: null, at: 't', nativeReview: null, reviewActions: null })
    const commit = await store.planning.save(done.state, done.document)
    expect(commit.session.planState).toBe('awaiting_review')
    expect(commit.summary?.planState).toBe('awaiting_review')
    expect(JSON.stringify(await store.outbox.pending(0, 10))).not.toContain('secret plan')
    expect((await store.planning.document('sess_1', done.document!.planId, 1))?.markdown).toContain('secret plan')
    await expect(store.planning.save(done.state, { ...done.document!, contentHash: 'sha256:other' })).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('stores goal state and reports only the enum', async () => {
    await createSession()
    const state = observe(initialGoalState({ sessionId: 'sess_1', runtime: 'codex', runtimeId: null, sourceEpoch: 'e' }), { goal: { objective: 'ship v3', status: 'active' }, empty: false }, { newId: () => 'g', now: 't' })
    expect((await store.goals.save(state)).session.goalState).toBe('active')
    expect((await store.goals.load('sess_1'))?.goal?.objective).toBe('ship v3')
  })

  it('records command receipts and queues command.result', async () => {
    await store.commands.settle({ commandId: 'c1', method: 'session.sendMessage', sessionId: null, inputDigest: 'd', outcome: 'accepted', result: { delivery: 'accepted' }, error: null, createdAt: 't', updatedAt: 't' })
    expect((await store.commands.get('c1'))?.outcome).toBe('accepted')
    const pending = await store.outbox.pending(0, 10)
    expect(pending.at(-1)).toMatchObject({ kind: 'command.result', payload: { commandId: 'c1', outcome: 'accepted', r: { delivery: 'accepted' } } })
  })

  it('commits a receipt with the effect, and a later settle keeps it', async () => {
    await createSession()
    const receipt = { commandId: 'c9', method: 'session.queue.clear', sessionId: 'sess_1', inputDigest: 'd9', createdAt: 't', result: null }
    const queue = await store.queues.apply('sess_1', { kind: 'clear' }, 't', receipt)
    expect(await store.commands.get('c9')).toMatchObject({ outcome: 'accepted', result: { sessionId: 'sess_1', revision: queue.revision, items: [] } })
    // A failed effect rolls its receipt back with it.
    await expect(store.queues.apply('sess_1', { kind: 'remove', messageId: 'nope' }, 't', { ...receipt, commandId: 'c10' })).rejects.toMatchObject({ code: 'queue_item_not_found' })
    expect(await store.commands.get('c10')).toBeNull()
    // The inbox settles afterwards (or a retry after a crash would): the committed receipt stands, queued once.
    const settled = await store.commands.settle({ ...receipt, outcome: 'rejected', result: null, error: { code: 'late' }, updatedAt: 't' })
    expect(settled).toMatchObject({ outcome: 'accepted', error: null })
    expect((await store.outbox.pending(0, 50)).filter(record => record.kind === 'command.result').map(record => record.payload.commandId)).toEqual(['c9'])
  })

  it('acknowledges the outbox cumulatively', async () => {
    const a = await store.outbox.append('usage.report', null, { n: 1 }, 't')
    const b = await store.outbox.append('usage.report', null, { n: 2 }, 't')
    await store.outbox.append('usage.report', null, { n: 3 }, 't')
    expect(await store.outbox.lowest()).toBe(a)
    expect(await store.outbox.ack(b)).toBe(2)
    expect((await store.outbox.pending(0, 10)).map(r => r.payload.n)).toEqual([3])
  })

  it('stores runtime bookkeeping', async () => {
    await store.kv.set('rti_1', 'cursor', { offset: 42 })
    expect(await store.kv.get('rti_1', 'cursor')).toEqual({ offset: 42 })
    await store.kv.delete('rti_1', 'cursor')
    expect(await store.kv.get('rti_1', 'cursor')).toBeUndefined()
  })
})

describe('data upgrades', () => {
  it('opens a store written by a newer Connector read-only', async () => {
    await createSession()
    await store.close()
    const raw = new DatabaseSync(join(dir, 'store.sqlite'))
    raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
    raw.close()
    sync = openSqliteStore({ dataDir: dir, now })
    store = inProcessStore(sync)
    expect(store.readOnly).toBe(true)
    expect((await store.sessions.get('sess_1'))?.sessionId).toBe('sess_1')
    await expect(createSession('sess_2')).rejects.toMatchObject({ code: 'store_read_only' })
  })

  it('migrates a version 1 store: sessions keep their rows and gain an empty project', async () => {
    await createSession()
    await store.close()
    const raw = new DatabaseSync(join(dir, 'store.sqlite'))
    raw.exec("ALTER TABLE sessions DROP COLUMN project_id; ALTER TABLE deliveries DROP COLUMN pending_json; UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    raw.close()
    sync = openSqliteStore({ dataDir: dir, now })
    store = inProcessStore(sync)
    expect(store.readOnly).toBe(false)
    expect(await store.sessions.get('sess_1')).toMatchObject({ sessionId: 'sess_1', projectId: null })
    await store.sessions.create({ sessionId: 'sess_p', runtimeType: 'codex', runtimeId: 'codex', externalSessionId: null, cwd: '/w', projectId: 'prj_1', nativeTitle: null, status: 'pending', sourceAvailability: 'available', takeover: true, at: now() })
    expect(await store.sessions.get('sess_p')).toMatchObject({ projectId: 'prj_1' })
  })

  it('keeps the store epoch across reopen', async () => {
    const epoch = store.storeEpoch
    await store.close()
    sync = openSqliteStore({ dataDir: dir, now })
    store = inProcessStore(sync)
    expect(store.storeEpoch).toBe(epoch)
  })
})

describe('worker thread', () => {
  it('serves the same port from a worker and revives domain errors', async () => {
    await store.close()
    const remote = await openStoreWorker(
      { dataDir: dir, durability: 'normal' },
      { workerUrl: new URL('../../src/store/worker-entry.ts', import.meta.url), execArgv: TS_WORKER_EXEC_ARGV },
    )
    try {
      await remote.sessions.create({ sessionId: 's_w', runtimeType: 'pi', runtimeId: 'r', externalSessionId: null, cwd: null, nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: true, at: 't' })
      const commit = await remote.timeline.apply('s_w', { upserts: [message('x', 'from worker', 1)], at: 't' })
      expect(commit.toSeq).toBe(1)
      await expect(remote.queues.apply('s_w', { kind: 'remove', messageId: 'none' }, 't')).rejects.toMatchObject({ name: 'ConversationError', code: 'queue_item_not_found' })
      const bytes = await remote.blobs.put(new Uint8Array([1, 2, 3]), { mediaType: null, origin: 'test', at: 't' })
      expect(Array.from((await remote.blobs.read(bytes.blobId))!)).toEqual([1, 2, 3])
    } finally {
      await remote.close()
    }
    store = inProcessStore(openSqliteStore({ dataDir: dir, now }))
  })

  it('fails every waiting and later call when the worker dies, and says so once', async () => {
    await store.close()
    const failures: Error[] = []
    const remote = await openStoreWorker(
      { dataDir: dir, durability: 'normal' },
      { workerUrl: new URL('../support/dying-store-worker.ts', import.meta.url), execArgv: TS_WORKER_EXEC_ARGV, onUnavailable: error => failures.push(error) },
    )
    try {
      expect(await remote.sessions.list()).toEqual([])
      // The worker dies while this call waits for its answer.
      const waiting = remote.kv.get('rti', '__die__')
      await expect(waiting).rejects.toMatchObject({ name: 'StoreError', code: 'store_unavailable' })
      await expect(remote.sessions.list()).rejects.toMatchObject({ code: 'store_unavailable' })
      await expect(remote.commands.get('c1')).rejects.toMatchObject({ code: 'store_unavailable' })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ code: 'store_unavailable' })
      expect(failures[0]?.message).toContain('code 7')
    } finally {
      await remote.close()
    }
    // Closing a healthy worker is not a failure.
    const healthy = await openStoreWorker(
      { dataDir: dir, durability: 'normal' },
      { workerUrl: new URL('../../src/store/worker-entry.ts', import.meta.url), execArgv: TS_WORKER_EXEC_ARGV, onUnavailable: error => failures.push(error) },
    )
    await healthy.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failures).toHaveLength(1)
    store = inProcessStore(openSqliteStore({ dataDir: dir, now }))
  })
})
