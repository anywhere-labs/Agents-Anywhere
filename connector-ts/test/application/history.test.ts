import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationService, NativeHistory } from '../../src/application/index.js'
import type { HistoryItem, HistoryWindow, NativeHistoryPage, NativeSessionSummary, RuntimeHandle, RuntimeHandles } from '../../src/application/ports/index.js'
import { ORDER_ANCHOR_INDEX, ORDER_INDEX_MAX, ORDER_SUB_SLOTS } from '../../src/domain/conversation/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed } from '../../src/sync/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

/** A native record per session: messages n1..nN, cursors are positions. */
class FakeNative {
  public readonly records = new Map<string, HistoryItem[]>()
  public readonly summaries: NativeSessionSummary[] = []
  public rewritten = new Set<string>()
  public reads: { id: string; window: HistoryWindow }[] = []

  public add(nativeId: string, count: number, extra: Partial<NativeSessionSummary> = {}): void {
    const items = this.records.get(nativeId) ?? []
    const start = items.length
    for (let i = start + 1; i <= start + count; i++) items.push({ type: 'message.completed', itemId: `${nativeId}_m${i}`, role: i % 2 === 0 ? 'assistant' : 'user', text: `message ${i}`, replay: true })
    this.records.set(nativeId, items)
    const existing = this.summaries.find(summary => summary.nativeSessionId === nativeId)
    const summary = { nativeSessionId: nativeId, title: `T ${nativeId}`, cwd: '/w', updatedAt: `u${items.length}`, ...extra }
    if (existing === undefined) this.summaries.push(summary)
    else Object.assign(existing, summary)
  }

  public read(nativeId: string, window: HistoryWindow): NativeHistoryPage {
    this.reads.push({ id: nativeId, window })
    const items = this.records.get(nativeId) ?? []
    if (window.cursor !== undefined && window.direction === 'newer' && this.rewritten.has(nativeId)) {
      throw Object.assign(new Error('rewritten'), { code: 'history_cursor_invalid' })
    }
    if (window.cursor === undefined) {
      const start = Math.max(0, items.length - window.limit)
      return { items: items.slice(start), ...(start > 0 ? { olderCursor: String(start) } : {}), newerCursor: String(items.length) }
    }
    const at = Number(window.cursor)
    if (window.direction === 'older') {
      const start = Math.max(0, at - window.limit)
      return { items: items.slice(start, at), ...(start > 0 ? { olderCursor: String(start) } : {}) }
    }
    const end = Math.min(items.length, at + window.limit)
    return { items: items.slice(at, end), newerCursor: String(end) }
  }
}

let dir: string
let store: RemoteStore
let feed: MemoryChangeFeed
let native: FakeNative
let history: NativeHistory
let bound: Set<string>
let ms = 0

const clock = { nowIso: () => new Date(Date.UTC(2026, 10, 16, 0, 0, 0, ms)).toISOString(), nowMs: () => ms }

function handle(): RuntimeHandle {
  return {
    type: 'pi',
    instanceId: 'rti_pi',
    capabilities: () => ({ revision: 1, items: [] }),
    catalogs: async () => ({}),
    listNativeSessions: async cursor => {
      const start = cursor === undefined ? 0 : Number(cursor)
      const page = native.summaries.slice(start, start + 1)
      return { sessions: page, ...(start + 1 < native.summaries.length ? { nextCursor: String(start + 1) } : {}) }
    },
    readNativeHistory: async (ref, window) => native.read(ref.nativeSessionId, window),
    open: async (target, options) => new FakeRuntimeSession(options.sessionId, target.kind === 'existing' ? target.ref.nativeSessionId : 'new'),
    events: (async function* () {})(),
    stop: async () => undefined,
  }
}

const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'rti_pi' ? handle() : null) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-hist-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  feed = new MemoryChangeFeed()
  native = new FakeNative()
  bound = new Set()
  history = new NativeHistory({ store, feed, runtimes, clock, pageLimit: 3, sessionIdFor: (_h, runtimeId, ref) => `sess_${runtimeId}_${ref.nativeSessionId}`, isBound: id => bound.has(id) })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

const ids = async (sessionId: string): Promise<string[]> => (await store.timeline.read(sessionId, 'latest', null, 500, 10_000_000)).items.map(item => item.id)

describe('native history projection', () => {
  it('keeps orderSeq within 32 bits around the anchor', () => {
    expect(ORDER_ANCHOR_INDEX * ORDER_SUB_SLOTS).toBeLessThan(2 ** 31)
    expect((ORDER_INDEX_MAX + 1) * ORDER_SUB_SLOTS).toBeLessThan(2 ** 31)
  })

  it('discovers native sessions, projects only the latest page and queues session.inventory', async () => {
    native.add('a', 5)
    native.add('b', 2, { archived: true })
    expect(await history.scan('rti_pi', 'scan_1')).toEqual({ sessions: 2, complete: true })
    expect(await ids('sess_rti_pi_a')).toEqual(['a_m3', 'a_m4', 'a_m5'])
    expect(await ids('sess_rti_pi_b')).toEqual(['b_m1', 'b_m2'])
    const a = await store.sessions.get('sess_rti_pi_a')
    expect(a).toMatchObject({ externalSessionId: 'a', nativeTitle: 'T a', cwd: '/w', takeover: false })
    expect(a?.latestTurnEndSeq).not.toBeNull()
    expect((await store.sessions.get('sess_rti_pi_b'))?.sourceAvailability).toBe('archived')
    const inventory = (await store.outbox.pending(0, 100)).filter(record => record.kind === 'session.inventory')
    expect(inventory).toHaveLength(1)
    expect(inventory[0]!.payload).toMatchObject({ runtimeId: 'rti_pi', scanId: 'scan_1', complete: true, sessions: [{ sessionId: 'sess_rti_pi_a' }, { sessionId: 'sess_rti_pi_b', sourceAvailability: 'archived' }] })
    // A second scan without native changes reads nothing again.
    native.reads = []
    await history.scan('rti_pi', 'scan_2')
    expect(native.reads).toEqual([])
  })

  it("shows an unopened session's permission as the Runtime reported it, and nothing when it did not", async () => {
    native.add('a', 1, { permission: 'codex:permission:full_access' })
    native.add('b', 1)
    await history.scan('rti_pi', 's')
    const readers = new DeviceReaders(store, clock.nowIso, { sessionCapabilities: async () => null, catalogs: async () => null, selections: id => history.nativeSelections(id) })
    expect(((await readers.sessionState({ sessionId: 'sess_rti_pi_a' })).state as Record<string, unknown>).selections).toEqual({ permission: 'codex:permission:full_access' })
    // No report, no default.
    expect((await readers.sessionState({ sessionId: 'sess_rti_pi_b' })).state).not.toHaveProperty('selections')
    expect(((await readers.snapshot({ sessionId: 'sess_rti_pi_a' })).state as Record<string, unknown>).selections).toEqual({ permission: 'codex:permission:full_access' })
    // Open here: the session's own configuration counts.
    bound.add('sess_rti_pi_a')
    expect(await history.nativeSelections('sess_rti_pi_a')).toBeNull()
    bound.clear()
    // A later report changes it; a report without one forgets it.
    native.add('a', 0, { permission: 'codex:permission:request_approval' })
    await history.scan('rti_pi', 's2')
    expect(await history.nativeSelections('sess_rti_pi_a')).toEqual({ permission: 'codex:permission:request_approval' })
    delete (native.summaries.find(summary => summary.nativeSessionId === 'a') as { permission?: string }).permission
    await history.scan('rti_pi', 's3')
    expect(await history.nativeSelections('sess_rti_pi_a')).toBeNull()
  })

  it('projects older pages when a client pages back, below what is stored', async () => {
    native.add('a', 8)
    await history.scan('rti_pi', 's')
    const readers = new DeviceReaders(store, clock.nowIso, undefined, history)
    const latest = await readers.read({ sessionId: 'sess_rti_pi_a', mode: 'latest', limit: 3 })
    expect(latest.items!.map(item => item.id)).toEqual(['a_m6', 'a_m7', 'a_m8'])
    expect(latest.hasMore).toBe(true)
    const older = await readers.read({ sessionId: 'sess_rti_pi_a', mode: 'before', cursor: latest.oldestOrderSeq ?? null, limit: 3 })
    expect(older.items!.map(item => item.id)).toEqual(['a_m3', 'a_m4', 'a_m5'])
    expect(older.hasMore).toBe(true)
    const oldest = await readers.read({ sessionId: 'sess_rti_pi_a', mode: 'before', cursor: older.oldestOrderSeq ?? null, limit: 3 })
    expect(oldest.items!.map(item => item.id)).toEqual(['a_m1', 'a_m2'])
    expect(oldest.hasMore).toBe(false)
    const all = (await store.timeline.read('sess_rti_pi_a', 'latest', null, 500, 10_000_000)).items
    expect(all.map(item => item.id)).toEqual(['a_m1', 'a_m2', 'a_m3', 'a_m4', 'a_m5', 'a_m6', 'a_m7', 'a_m8'])
    expect(all.every((item, i) => i === 0 || item.orderSeq > all[i - 1]!.orderSeq)).toBe(true)
    expect(all.every(item => item.orderSeq > 0 && item.orderSeq < 2 ** 31)).toBe(true)
  })

  it('projects new native content incrementally and publishes it', async () => {
    native.add('a', 3)
    await history.scan('rti_pi', 's')
    const notices: number[] = []
    feed.subscribe('sess_rti_pi_a', notice => notices.push(notice.toSeq))
    native.add('a', 4)
    await history.scan('rti_pi', 's2')
    expect(await ids('sess_rti_pi_a')).toEqual(['a_m1', 'a_m2', 'a_m3', 'a_m4', 'a_m5', 'a_m6', 'a_m7'])
    expect(native.reads.at(-2)?.window).toMatchObject({ cursor: '3', direction: 'newer' })
    expect(notices.length).toBeGreaterThan(0)
    // A bound session gets new content from live events instead.
    bound.add('sess_rti_pi_a')
    native.add('a', 1)
    native.reads = []
    await history.scan('rti_pi', 's3')
    expect(native.reads).toEqual([])
  })

  it('projects a rewritten native record again and raises the reset fence', async () => {
    native.add('a', 3)
    await history.scan('rti_pi', 's')
    const before = await store.sessions.get('sess_rti_pi_a')
    native.records.set('a', [])
    native.add('a', 2)
    native.rewritten.add('a')
    Object.assign(native.summaries[0]!, { updatedAt: 'rewritten' })
    await history.scan('rti_pi', 's2')
    expect(await ids('sess_rti_pi_a')).toEqual(['a_m1', 'a_m2'])
    const after = await store.sessions.get('sess_rti_pi_a')
    expect(after!.clock.resetSeq).toBeGreaterThan(before!.clock.resetSeq)
    expect((await store.timeline.get('sess_rti_pi_a', 'a_m3'))).toBeNull()
  })

  it('projects history before a Runtime session is opened, so live items sort after it', async () => {
    native.add('a', 2)
    await store.sessions.create({ sessionId: 'sess_x', runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: 'a', cwd: '/w', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
    const service = new ConversationService({ store, feed, live: { emit: () => undefined }, runtimes, clock, ids: { newId: prefix => `${prefix}1` }, coalesceMs: 100, history })
    try {
      const binding = await service.binding('sess_x')
      ;(binding as unknown as { session: FakeRuntimeSession }).session.emit({ type: 'message.completed', itemId: 'live1', role: 'assistant', text: 'live' })
      for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve))
      expect(await ids('sess_x')).toEqual(['a_m1', 'a_m2', 'live1'])
    } finally {
      await service.close()
    }
  })

  describe('a session started on this device', () => {
    /** Stores what the live turns of a session sent from here left: user messages under the Runtime's ids, the replies. */
    async function sentFromHere(sessionId: string, turns: { userId: string; clientMessageId: string; text: string; replyId: string }[]): Promise<void> {
      await store.sessions.create({ sessionId, runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: 'a', cwd: '/w', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
      let index = ORDER_ANCHOR_INDEX
      const upserts = turns.flatMap(turn => [
        { id: turn.userId, type: 'message' as const, status: 'done' as const, role: 'user' as const, orderSeq: index++ * ORDER_SUB_SLOTS, content: { kind: 'markdown', text: turn.text, clientMessageId: turn.clientMessageId }, source: { runtime: 'platform', clientMessageId: turn.clientMessageId }, createdAt: clock.nowIso() },
        { id: turn.replyId, type: 'message' as const, status: 'done' as const, role: 'assistant' as const, orderSeq: index++ * ORDER_SUB_SLOTS, content: { kind: 'markdown', text: 'reply' }, source: { runtime: 'pi' }, createdAt: clock.nowIso() },
      ])
      await store.timeline.apply(sessionId, { upserts, at: clock.nowIso() })
    }

    it('does not repeat a user message the native record names by entry but carries the client message id of (Pi)', async () => {
      await sentFromHere('sess_x', [{ userId: 'aa_u1', clientMessageId: 'cm1', text: 'hello', replyId: 'a_r1' }])
      native.records.set('a', [
        { type: 'message.completed', itemId: 'a_entry1', role: 'user', text: 'hello', clientMessageId: 'cm1', replay: true },
        { type: 'message.completed', itemId: 'a_r1', role: 'assistant', text: 'reply', replay: true },
      ])
      await history.ensureLatest('sess_x')
      expect(await ids('sess_x')).toEqual(['aa_u1', 'a_r1'])
    })

    it('does not repeat a user message the native record names by its own id only (Claude), however often it is projected', async () => {
      await sentFromHere('sess_x', [
        { userId: 'aa_u1', clientMessageId: 'cm1', text: 'again', replyId: 'a_r1' },
        { userId: 'aa_u2', clientMessageId: 'cm2', text: 'again', replyId: 'a_r2' },
      ])
      native.records.set('a', [
        { type: 'message.completed', itemId: 'a_uuid1', role: 'user', text: 'again', replay: true },
        { type: 'message.completed', itemId: 'a_r1', role: 'assistant', text: 'reply', replay: true },
        { type: 'message.completed', itemId: 'a_uuid2', role: 'user', text: ' again ', replay: true },
        { type: 'message.completed', itemId: 'a_r2', role: 'assistant', text: 'reply', replay: true },
      ])
      const history10 = new NativeHistory({ store, feed, runtimes, clock, pageLimit: 10, sessionIdFor: (_h, runtimeId, ref) => `sess_${runtimeId}_${ref.nativeSessionId}`, isBound: id => bound.has(id) })
      await history10.ensureLatest('sess_x')
      expect(await ids('sess_x')).toEqual(['aa_u1', 'a_r1', 'aa_u2', 'a_r2'])
      // The record grows from elsewhere (the CLI): the new message is projected, the matched ones stay matched.
      native.records.get('a')!.push({ type: 'message.completed', itemId: 'a_uuid3', role: 'user', text: 'again', replay: true })
      await history10.catchUp('sess_x', 'u2')
      expect(await ids('sess_x')).toEqual(['aa_u1', 'a_r1', 'aa_u2', 'a_r2', 'a_uuid3'])
    })
  })
})
