import { describe, expect, test } from 'vitest'
import { Bridge2SyncRelay, BACKEND_UNAVAILABLE, HistoryRefusedError, SUBSCRIPTION_UNKNOWN, checkpointKey,
  type Bridge2Calls, type Json, type SnapshotPage } from '../../../src/runtime/dsh-bridge2/relay.js'
import { MemoryLedger } from '../../fixtures/bridge2-ledger.js'

/** The plugin side of the sync stream: emits `subscribed`, then stays open until aborted. */
class FakeCalls implements Bridge2Calls {
  readonly requests: { method: string, params: Json }[] = []
  subscribed: Json = { kind: 'subscribed', projectionVersion: 3, checkpointVersion: 1 }
  async request(method: string, params: Json = {}) { this.requests.push({ method, params }); return { accepted: true } }
  async *stream(_method: string, _params: Json, signal: AbortSignal) {
    yield this.subscribed
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  }
}

const hash = 'a'.repeat(64)
const checkpoint = { version: 1, projectionVersion: 3, throughSeq: 7, historyHash: hash, settled: true }
const item = (sessionId: string, id: string, status = 'completed') => ({ id, sessionId, type: 'message', status, source: { time: 1_700_000_000_000 } })
const upsert = (sessionId: string, id: string, status = 'completed') => ({ method: 'timeline.itemUpsert', params: { sessionId, item: item(sessionId, id, status) } })
const ops = (...notifications: Json[]) => [{ kind: 'notifications', notifications }]

async function* pages(...list: SnapshotPage[]) { for (const page of list) yield page }

async function subscribed(options: ConstructorParameters<typeof Bridge2SyncRelay>[2] = {}) {
  const ledger = new MemoryLedger()
  const calls = new FakeCalls()
  let clock = 1_000_000
  const sleeps: number[] = []
  const relay = new Bridge2SyncRelay(ledger, calls, { now: () => clock, sleep: async ms => { sleeps.push(ms) }, ...options })
  const abort = new AbortController()
  let ready!: () => void
  const confirmed = new Promise<void>(resolve => { ready = resolve })
  const running = relay.subscribe('sub-1', abort.signal, ready)
  await confirmed
  return { ledger, calls, relay, sleeps, abort, running, advance: (ms: number) => { clock += ms } }
}

describe('dsh-bridge 2.0 sync relay (DSH-3)', () => {
  test('batches apply in order; a redelivered batch is acknowledged again without reapplying', async () => {
    const { ledger, relay } = await subscribed()
    await relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 1, projectionVersion: 3, operations: ops(upsert('s', 'a')) })
    await relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 1, projectionVersion: 3, operations: ops(upsert('s', 'a')) })
    await relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 2, projectionVersion: 3, operations: [{ kind: 'workspace.inventory' }, ...ops(upsert('s', 'b'))] })
    expect(ledger.published.map(n => (n.params.item as Json).id)).toEqual(['a', 'b'])
    await expect(relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 4, projectionVersion: 3, operations: [] })).rejects.toThrow(/Out-of-order/)
    await expect(relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 3, projectionVersion: 2, operations: [] })).rejects.toThrow(/Invalid DSH event batch/)
    await expect(relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 3, projectionVersion: 3, operations: [{ kind: 'snapshot.begin' }] })).rejects.toThrow(/Unsupported bridge operation/)
    await expect(relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 3, projectionVersion: 3, operations: ops({ method: 'mystery', params: {} }) }))
      .rejects.toThrow(/Unsupported runtime notification/)
    await expect(relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 3, projectionVersion: 3,
      operations: ops({ method: 'timeline.itemUpsert', params: { sessionId: 'other', item: item('s', 'c') } }) })).rejects.toThrow(/different session/)
  })

  test('a batch of an ended subscription is not acknowledged: subscription_unknown', async () => {
    const { relay, abort, running } = await subscribed()
    abort.abort()
    await running
    await expect(relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 1, projectionVersion: 3, operations: [] }))
      .rejects.toMatchObject({ code: SUBSCRIPTION_UNKNOWN })
    await expect(relay.saveCheckpoint('sub-1', 'ext', checkpoint)).rejects.toMatchObject({ code: SUBSCRIPTION_UNKNOWN })
  })

  test('a store that is briefly unavailable fails the batch as retryable, and the resent batch applies', async () => {
    const { ledger, relay } = await subscribed()
    ledger.unavailable = 1
    const batch = { subscriptionId: 'sub-1', batchSeq: 1, projectionVersion: 3, operations: ops(upsert('s', 'a')) }
    await expect(relay.ingestBatch(batch)).rejects.toMatchObject({ code: BACKEND_UNAVAILABLE, retryable: true })
    await relay.ingestBatch(batch)
    expect(ledger.published).toHaveLength(1)
  })

  test('checkpoints mean "committed locally": stored after acknowledgement, validated, deletable', async () => {
    const { ledger, relay } = await subscribed()
    expect(await relay.loadCheckpoint('sub-1', 'ext')).toBeNull()
    await relay.saveCheckpoint('sub-1', 'ext', checkpoint)
    expect(ledger.state.get(checkpointKey('ext'))).toEqual(checkpoint)
    expect(await relay.loadCheckpoint('sub-1', 'ext')).toEqual(checkpoint)
    await expect(relay.saveCheckpoint('sub-1', 'ext', { ...checkpoint, historyHash: 'nope' })).rejects.toThrow(/Invalid DSH checkpoint/)
    ledger.state.set(checkpointKey('bad'), { version: 2 })
    expect(await relay.loadCheckpoint('sub-1', 'bad')).toBeNull()
    await relay.deleteCheckpoint('sub-1', 'ext')
    expect(ledger.state.has(checkpointKey('ext'))).toBe(false)
  })

  test('without durable checkpoints (old plugin), checkpoints are neither stored nor handed back', async () => {
    const ledger = new MemoryLedger()
    const calls = new FakeCalls()
    calls.subscribed = { kind: 'subscribed', projectionVersion: 2 }
    const relay = new Bridge2SyncRelay(ledger, calls)
    const abort = new AbortController()
    await new Promise<void>(resolve => { void relay.subscribe('sub-1', abort.signal, resolve) })
    await relay.saveCheckpoint('sub-1', 'ext', checkpoint)
    expect(ledger.state.size).toBe(0)
    expect(await relay.loadCheckpoint('sub-1', 'ext')).toBeNull()
    abort.abort()
  })

  test('an unsupported projection version ends the subscription', async () => {
    const calls = new FakeCalls()
    calls.subscribed = { kind: 'subscribed', projectionVersion: 9 }
    const relay = new Bridge2SyncRelay(new MemoryLedger(), calls)
    await expect(relay.subscribe('sub-1', new AbortController().signal)).rejects.toThrow(/projection version/)
  })

  test('snapshots assemble per capture, are dated, and a stale capture cannot pollute the next', async () => {
    const { ledger, relay } = await subscribed()
    const request = { captureId: 'cap-1', subscriptionId: 'sub-1', sessionId: 's', meta: { externalSessionId: 'ext', lastActivityAt: '2026-01-01T00:00:00.000Z' }, throughSeq: 4 }
    const result = await relay.ingestSnapshot(request, pages({ captureId: 'cap-1', items: [item('s', 'a')] }, { captureId: 'cap-1', items: [{ id: 'b', sessionId: 's' }] }))
    expect(result).toEqual({ accepted: true })
    const stored = ledger.sessions.get('s')!.items
    expect(stored.map(entry => entry.id)).toEqual(['a', 'b'])
    expect(stored[0]!.createdAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(stored[1]!.createdAt).toBe('2026-01-01T00:00:00.000Z')
    await expect(relay.ingestSnapshot({ ...request, captureId: 'cap-2' }, pages({ captureId: 'cap-1', items: [] }))).rejects.toThrow(/different capture/)
    await expect(relay.ingestSnapshot({ ...request, captureId: 'cap-3' }, pages({ captureId: 'cap-3', items: [item('s', 'a'), item('s', 'a')] })))
      .rejects.toThrow(/item identity/)
  })

  test('a refused history quarantines the session: no checkpoint, no live history, withheld captures, retry, release', async () => {
    const { ledger, calls, relay, advance } = await subscribed({ retryMs: 1_000 })
    ledger.refuse = new HistoryRefusedError('history_too_large')
    const request = { captureId: 'cap-1', subscriptionId: 'sub-1', sessionId: 's', meta: { externalSessionId: 'ext' }, throughSeq: 4 }
    expect(await relay.ingestSnapshot(request, pages({ captureId: 'cap-1', items: [item('s', 'a')] })))
      .toEqual({ accepted: false, quarantined: true, reason: 'history_too_large' })
    expect(ledger.published.at(-1)).toMatchObject({ method: 'session.source.updated', params: { sessionId: 's', availability: 'unavailable', reason: 'history_too_large' } })
    // The checkpoint the plugin saves after its commit is withheld.
    await relay.saveCheckpoint('sub-1', 'ext', checkpoint)
    expect(ledger.state.size).toBe(0)
    // Live history of the session is withheld; its meta is rewritten as unavailable.
    const before = ledger.published.length
    await relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 1, projectionVersion: 3, operations: ops(upsert('s', 'b'),
      { method: 'session.meta.upsert', params: { sessionId: 's', sourceState: { availability: 'available' } } }, upsert('t', 'c')) })
    const added = ledger.published.slice(before)
    expect(added.map(n => n.method)).toEqual(['session.meta.upsert', 'timeline.itemUpsert'])
    expect(added[0]!.params.sourceState).toMatchObject({ availability: 'unavailable' })
    // Before the retry is due, a capture is acknowledged without storing it.
    ledger.refuse = undefined
    expect(await relay.ingestSnapshot({ ...request, captureId: 'cap-2' }, pages({ captureId: 'cap-2', items: [item('s', 'a')] })))
      .toMatchObject({ accepted: false, quarantined: true })
    expect(ledger.sessions.has('s')).toBe(false)
    // The retry asks the plugin for a fresh capture.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.requests).toContainEqual({ method: 'refreshSync', params: { sessionId: 's', externalSessionId: 'ext' } })
    // Once due, the capture is stored and the session released.
    advance(5 * 60_000 + 1)
    expect(await relay.ingestSnapshot({ ...request, captureId: 'cap-3' }, pages({ captureId: 'cap-3', items: [item('s', 'a')] }))).toEqual({ accepted: true })
    expect(relay.quarantined.size).toBe(0)
    expect(ledger.published.at(-1)).toMatchObject({ method: 'session.source.updated', params: { sessionId: 's', availability: 'available' } })
    await relay.saveCheckpoint('sub-1', 'ext', checkpoint)
    expect(ledger.state.size).toBe(1)
    await relay.close()
  })

  test('streaming drafts: the second draft batch in a row is held until 0.25 s after its commit began', async () => {
    const { relay, sleeps } = await subscribed()
    const draft = (seq: number) => ({ subscriptionId: 'sub-1', batchSeq: seq, projectionVersion: 3, operations: ops(upsert('s', 'a', 'running')) })
    await relay.ingestBatch(draft(1))
    expect(sleeps).toEqual([])
    await relay.ingestBatch(draft(2))
    expect(sleeps).toEqual([250])
    await relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 3, projectionVersion: 3, operations: ops(upsert('s', 'a')) })
    await relay.ingestBatch(draft(4))
    expect(sleeps).toEqual([250])
  })

  test('a batch that races ahead of the subscribed item waits for it', async () => {
    const ledger = new MemoryLedger()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: Bridge2Calls = {
      request: async () => ({}),
      async *stream(_m, _p, signal) {
        await gate
        yield { kind: 'subscribed', projectionVersion: 3, checkpointVersion: 1 }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    }
    const relay = new Bridge2SyncRelay(ledger, calls)
    const abort = new AbortController()
    void relay.subscribe('sub-1', abort.signal)
    const batch = relay.ingestBatch({ subscriptionId: 'sub-1', batchSeq: 1, projectionVersion: 3, operations: ops(upsert('s', 'a')) })
    release()
    await batch
    expect(ledger.published).toHaveLength(1)
    abort.abort()
  })
})
