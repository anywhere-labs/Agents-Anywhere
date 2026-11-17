import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChangeNotice } from '../../../src/application/ports/index.js'
import { Bridge2SyncRelay, StoreBridge2Ledger, checkpointKey, draftOf, type Bridge2Calls, type Json } from '../../../src/runtime/dsh-bridge2/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../../src/store/index.js'
import { MemoryChangeFeed } from '../../../src/sync/change-feed.js'

let dir: string
let store: RemoteStore
let feed: MemoryChangeFeed
let notices: ChangeNotice[]
let live: { method: string, payload: Record<string, unknown> }[]
let ledger: StoreBridge2Ledger

const hash = (n: number) => `dsh_${String(n).padStart(64, '0')}`
const item = (n: number, patch: Json = {}) => ({ id: hash(n), sessionId: 's1', type: 'message', status: 'done', orderSeq: n, revision: 1,
  role: 'assistant', contentHash: `sha256:${'0'.repeat(64)}`, content: { text: `m${n}` }, source: { runtime: 'dsh', time: 1_700_000_000_000 }, ...patch })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-b2-store-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal' }))
  feed = new MemoryChangeFeed()
  notices = []
  feed.subscribe('*', notice => notices.push(notice))
  live = []
  ledger = new StoreBridge2Ledger({ store, feed, live: { emit: (method, payload) => live.push({ method, payload }) }, runtimeId: 'rti_dsh', now: () => '2026-11-17T00:00:00.000Z' })
})

afterEach(async () => {
  await store.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('dsh-bridge 2.0 into the v3 local store (DSH-3)', () => {
  test('2.0 items become v3 drafts: turn markers, inProgress, hidden, event time', () => {
    expect(draftOf(item(1, { type: 'turn.start', content: { kind: 'turn_start' } }), 'now')).toMatchObject({ type: 'marker', content: { kind: 'turn_start' } })
    expect(draftOf(item(2, { status: 'inProgress' }), 'now')?.status).toBe('running')
    expect(draftOf(item(3, { status: 'hidden' }), 'now')).toBeNull()
    expect(draftOf(item(4), 'now')?.createdAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(() => draftOf(item(5, { type: 'mystery' }), 'now')).toThrow(/Unsupported/)
  })

  test('notifications land in the store, each commit announced; live facts go out as v2 events', async () => {
    await ledger.publish([
      { method: 'session.meta.upsert', params: { sessionId: 's1', externalSessionId: 'native-1', title: '标题', cwd: '/w', orderingTime: '2026-11-16T00:00:00.000Z' } },
      { method: 'timeline.itemUpsert', params: { sessionId: 's1', item: item(1) } },
      { method: 'timeline.itemUpsert', params: { sessionId: 's1', item: item(2, { status: 'inProgress' }) } },
      { method: 'session.state.updated', params: { sessionId: 's1', status: 'running' } },
      { method: 'notice.upsert', params: { sessionId: 's1', noticeId: 'n1', kind: 'approval' } },
      { method: 'catalog.model.update', params: { models: [] } },
    ])
    const session = await store.sessions.get('s1')
    expect(session).toMatchObject({ runtimeType: 'dsh', runtimeId: 'rti_dsh', externalSessionId: 'native-1', cwd: '/w', nativeTitle: '标题', status: 'running' })
    const page = await store.timeline.read('s1', 'latest', null, 10, 1 << 20)
    expect(page.items.map(entry => [entry.id, entry.status])).toEqual([[hash(1), 'done'], [hash(2), 'running']])
    expect(notices.length).toBeGreaterThanOrEqual(2)
    expect(live.map(entry => entry.method)).toEqual(expect.arrayContaining(['runtime.status', 'runtime.notice.updated', 'runtime.catalog.updated']))

    // A resend of the same batch converges (identical upserts do not tick the clock).
    const head = page.headSeq
    await ledger.publish([{ method: 'timeline.itemUpsert', params: { sessionId: 's1', item: item(1) } }])
    expect((await store.timeline.read('s1', 'latest', null, 10, 1 << 20)).headSeq).toBe(head)

    // hidden removes the item; a turn end marks the session.
    await ledger.publish([{ method: 'timeline.itemUpsert', params: { sessionId: 's1', item: item(2, { status: 'hidden' }) } },
      { method: 'session.turnEnded', params: { sessionId: 's1' } }, { method: 'session.source.updated', params: { sessionId: 's1', availability: 'unavailable' } }])
    expect((await store.timeline.read('s1', 'latest', null, 10, 1 << 20)).items.map(entry => entry.id)).toEqual([hash(1)])
    expect((await store.sessions.get('s1'))?.sourceAvailability).toBe('missing')
  })

  test('a capture replaces the timeline with a reset fence; checkpoints live in the runtime KV', async () => {
    await ledger.publish([{ method: 'timeline.itemUpsert', params: { sessionId: 's1', item: item(9) } }])
    await ledger.replaceSession('s1', { externalSessionId: 'native-1', title: 't' }, [item(1), item(2)])
    const page = await store.timeline.read('s1', 'latest', null, 10, 1 << 20)
    expect(page.items.map(entry => entry.id)).toEqual([hash(1), hash(2)])
    expect(notices.at(-1)?.reset).toBe(true)
    await ledger.writeState(checkpointKey('native-1'), { version: 1 })
    expect(await store.kv.get('rti_dsh', checkpointKey('native-1'))).toEqual({ version: 1 })
    await ledger.deleteState(checkpointKey('native-1'))
    expect(await ledger.readState(checkpointKey('native-1'))).toBeUndefined()
  })

  test('relay + store: a batch is acknowledged after it is committed, and its checkpoint after that', async () => {
    const calls: Bridge2Calls = {
      request: async () => ({}),
      async *stream(_m, _p, signal) {
        yield { kind: 'subscribed', projectionVersion: 3, checkpointVersion: 1 }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    }
    const relay = new Bridge2SyncRelay(ledger, calls)
    const abort = new AbortController()
    await new Promise<void>(resolve => { void relay.subscribe('sub', abort.signal, resolve) })
    await relay.ingestBatch({ subscriptionId: 'sub', batchSeq: 1, projectionVersion: 3,
      operations: [{ kind: 'notifications', notifications: [{ method: 'timeline.itemUpsert', params: { sessionId: 's1', item: item(1) } }] }] })
    expect((await store.timeline.get('s1', hash(1)))?.content).toEqual({ text: 'm1' })
    const checkpoint = { version: 1, projectionVersion: 3, throughSeq: 1, historyHash: 'a'.repeat(64), settled: true }
    await relay.saveCheckpoint('sub', 'native-1', checkpoint)
    expect(await relay.loadCheckpoint('sub', 'native-1')).toEqual(checkpoint)
    abort.abort()
    await relay.close()
  })
})
