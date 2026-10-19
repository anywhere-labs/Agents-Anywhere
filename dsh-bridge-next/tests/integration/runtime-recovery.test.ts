import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LocalRouter, Mesh, MeshCallError, Router, mutates, query, service, z } from 'meshcall'
import { BridgeConnection } from '../../src/host/dsh-runtime/connection.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import { writeJson } from '../../src/host/storage/files.js'
import { nativeRuntime } from '../fixtures/native-runtime.js'

async function until(check: () => boolean | Promise<boolean>, label: string, attempts = 800) {
  for (let n = 0; n < attempts; n++) { if (await check()) return; await delay(10) }
  assert.fail(label)
}

const code = (wanted: string) => (error: unknown) => error instanceof MeshCallError && error.code === wanted

function localEndpoint(prefix: string) {
  return process.platform === 'win32'
    ? { pipe: `agents-anywhere-${prefix}-${randomUUID()}` }
    : { unixPath: join(tmpdir(), `.aa-${prefix}-${randomUUID().slice(0, 8)}.sock`) }
}

/** A Bridge with a Connector Router that serves nothing: RPC behaviour only. */
async function plainBridge(reader: Parameters<typeof BridgeConnection>[1]) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rpc-'))
  const endpoint = localEndpoint('rpc')
  const router = await LocalRouter.start(endpoint)
  const key = `mk_rpc_${randomUUID()}`
  const path = join(home, 'bridge', 'connector.json')
  await writeJson(path, { version: 2, protocol: 'meshcall', instanceId: 'rpc-connector', pid: process.pid, endpoint, key })
  const connection = new BridgeConnection(path, reader, undefined, 20)
  await connection.start()
  const client = new Mesh(new Router(endpoint), { token: key, peerId: `rpc-client-${randomUUID()}` })
  return {
    connection, client, home,
    async close() { await client.close().catch(() => undefined); await connection.close(); await router.stop().catch(() => undefined); await rm(home, { recursive: true, force: true }) },
  }
}

interface WireBatch { subscriptionId: string, batchSeq: number, projectionVersion: number, operations: Record<string, unknown>[] }
interface SnapshotRequest { subscriptionId: string, sessionId: string, meta: Record<string, unknown>, throughSeq: number }

/** The Connector side of `aa.dsh.v2.Sync`, with switchable failures. */
class SyncBackend {
  batches: WireBatch[] = []
  snapshots: { request: SnapshotRequest, accepted: boolean, pages: unknown[][], reason?: string }[] = []
  checkpoints = new Map<string, Record<string, unknown>>()
  failBatch: Error | undefined
  snapshotRejection: (request: SnapshotRequest) => string | undefined = () => undefined

  async ingestBatch(batch: WireBatch): Promise<void> {
    if (this.failBatch) throw this.failBatch
    this.batches.push(batch)
  }
  checkpoint(id: string): Record<string, unknown> | null { return this.checkpoints.get(id) ?? null }
  async recordSnapshot(request: SnapshotRequest, pages: AsyncIterable<{ items: unknown[] }>): Promise<{ accepted: boolean, quarantined?: boolean, reason?: string }> {
    const collected: unknown[][] = []
    for await (const page of pages) collected.push(page.items)
    const reason = this.snapshotRejection(request)
    this.snapshots.push({ request, accepted: !reason, pages: collected, ...(reason ? { reason } : {}) })
    return reason ? { accepted: false, quarantined: true, reason } : { accepted: true }
  }
}

@service('aa.dsh.v2.Sync', { description: 'Fake Connector Sync for recovery tests.' })
class FakeSync {
  constructor(private readonly backend: SyncBackend) {}

  @mutates({ description: 'Batch', request: z.looseObject({ batch: z.any() }), response: z.looseObject({ ok: z.boolean().optional() }) })
  async ingestBatch(request: { batch: WireBatch }): Promise<{ ok: boolean }> {
    await this.backend.ingestBatch(request.batch)
    return { ok: true }
  }

  @query({ description: 'Load checkpoint', request: z.looseObject({ subscriptionId: z.string(), externalSessionId: z.string() }),
    response: z.looseObject({ checkpoint: z.any().nullable().optional() }) })
  async loadCheckpoint(request: { externalSessionId: string }): Promise<{ checkpoint: Record<string, unknown> | null }> {
    return { checkpoint: this.backend.checkpoint(request.externalSessionId) }
  }

  @mutates({ description: 'Save checkpoint', request: z.looseObject({ subscriptionId: z.string(), externalSessionId: z.string(), checkpoint: z.any() }),
    response: z.looseObject({ ok: z.boolean().optional() }) })
  async saveCheckpoint(request: { externalSessionId: string, checkpoint: Record<string, unknown> }): Promise<{ ok: boolean }> {
    this.backend.checkpoints.set(request.externalSessionId, request.checkpoint)
    return { ok: true }
  }

  @mutates({ description: 'Delete checkpoint', request: z.looseObject({ subscriptionId: z.string(), externalSessionId: z.string() }),
    response: z.looseObject({ ok: z.boolean().optional() }) })
  async deleteCheckpoint(request: { externalSessionId: string }): Promise<{ ok: boolean }> {
    this.backend.checkpoints.delete(request.externalSessionId)
    return { ok: true }
  }

  @mutates({ description: 'Snapshot', request: z.looseObject({ request: z.any() }),
    streamInput: z.looseObject({ items: z.array(z.unknown()) }),
    response: z.looseObject({ accepted: z.boolean(), quarantined: z.boolean().optional(), reason: z.string().nullable().optional() }) })
  async ingestSnapshot(request: { request: SnapshotRequest }, pages: AsyncIterable<{ items: unknown[] }>) {
    return this.backend.recordSnapshot(request.request, pages)
  }
}

/** A Bridge served on a Connector Router that answers `aa.dsh.v2.Sync` with `backend`. */
async function syncBridge(backend: SyncBackend, reader: Parameters<typeof BridgeConnection>[1]) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-rpc-'))
  const endpoint = localEndpoint('sync')
  const router = await LocalRouter.start(endpoint)
  const key = `mk_sync_${randomUUID()}`
  const server = new Mesh(new Router(endpoint), { token: key, peerId: `fake-sync-${randomUUID()}` })
  server.mount(new FakeSync(backend))
  await server.startServing()
  // A separate directory: the Host fixture's own plugin bridge owns the canonical one.
  const path = join(home, 'connector-router', 'connector.json')
  await writeJson(path, { version: 2, protocol: 'meshcall', instanceId: 'sync-connector', pid: process.pid, endpoint, key })
  const connection = new BridgeConnection(path, reader, undefined, 20)
  await connection.start()
  const client = new Mesh(new Router(endpoint), { token: key, peerId: `sync-client-${randomUUID()}` })
  return {
    client, home,
    async close() {
      await client.close().catch(() => undefined)
      await connection.close()
      await server.close().catch(() => undefined)
      await router.stop().catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('Bridge RPC failures stay sanitized and retryable, and a slow request never blocks the connection', { timeout: 30_000 }, async t => {
  let readFailed = true
  let release!: () => void
  let releaseCancelled!: () => void
  const hung = new Promise<void>(resolve => { release = resolve })
  const cancelledRead = new Promise<void>(resolve => { releaseCancelled = resolve })
  const reader = {
    query: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => {
        if (id === 'hang') await hung
        if (id === 'hang-cancelled') await cancelledRead
        if (readFailed && id === 'fail') throw new Error('PRIVATE_NATIVE_CONTENT')
        return { session: {}, events: [] }
      },
    },
    status: () => undefined,
  }
  const bridge = await plainBridge(reader)
  const metadata = { 'aa-session-namespace': 'recovery' }
  const call = (method: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    bridge.client.unary('aa.dsh.v2.Bridge', method, params, { metadata, timeoutMs: 5_000, ...options })
  t.after(() => { release(); releaseCancelled(); return bridge.close() })
  await assert.rejects(call('getSessionState', { externalSessionId: 'fail' }), error => {
    assert.ok(error instanceof MeshCallError)
    assert.equal(error.code, 'INTERNAL_ERROR')
    assert.equal(error.retryable, true)
    assert.ok(!JSON.stringify(error).includes('PRIVATE_NATIVE_CONTENT'))
    return true
  })
  readFailed = false
  const retried = await call('getSessionState', { externalSessionId: 'fail' })
  assert.equal(retried.status, 'idle', JSON.stringify(retried))
  await assert.rejects(call('unknown.method'), code('method_not_found'))
  // A deadline is a transport error; it preserves the connection for later calls.
  await assert.rejects(call('getSessionState', { externalSessionId: 'hang' }, { timeoutMs: 200 }), code('deadline_exceeded'))
  const slow = call('getSessionState', { externalSessionId: 'hang' })
  assert.equal((await call('ping')).ok, true, 'a slow request cannot block ping')
  release()
  await slow.catch(() => undefined)
  // Cancellation replaced 1.0's `$/cancelRequest`.
  const controller = new AbortController()
  const cancelled = call('getSessionState', { externalSessionId: 'hang-cancelled' }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(cancelled, code('cancelled'))
  assert.equal((await call('ping')).ok, true)
})

test('a rejected sync delivery fails only the sync stream; the Bridge stays connected and a new subscription replaces it', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stream-recovery-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const backend = new SyncBackend()
  const bridge = await syncBridge(backend, { native,
    query: { listSessions: signal => native.inventory(signal), readSession: id => native.read(id),
      readTitleSnapshots: (...args) => fixture.ctx.sessionQuery.readTitleSnapshots(...args) },
    status: id => native.status(id) })
  const metadata = { 'aa-session-namespace': 'recovery' }
  t.after(async () => { await bridge.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  backend.failBatch = new MeshCallError('INTERNAL_ERROR', 'delivery refused')
  const first: Record<string, unknown>[] = []
  await assert.rejects(async () => {
    for await (const item of bridge.client.serverStream('aa.dsh.v2.Bridge', 'sync',
      { subscriptionId: 'sub', checkpointVersion: 1 }, { metadata })) first.push(item)
  }, code('INTERNAL_ERROR'))
  assert.equal(first[0]?.kind, 'subscribed')
  assert.equal(first[0]?.checkpointVersion, 1)
  assert.equal((await bridge.client.unary('aa.dsh.v2.Bridge', 'ping', {}, { metadata })).ok, true)
  backend.failBatch = undefined
  const controller = new AbortController()
  const items: Record<string, unknown>[] = []
  const consumer = (async () => {
    for await (const item of bridge.client.serverStream('aa.dsh.v2.Bridge', 'sync',
      { subscriptionId: 'sub-2', checkpointVersion: 1 }, { metadata, signal: controller.signal })) items.push(item)
  })().catch(error => { if (!controller.signal.aborted) throw error })
  await until(() => backend.batches.some(batch => batch.subscriptionId === 'sub-2'
    && JSON.stringify(batch.operations).includes('session.inventory.complete')), 'the replacement subscription ingests a fresh inventory')
  assert.equal(items[0]?.kind, 'subscribed')
  assert.equal((await bridge.client.unary('aa.dsh.v2.Bridge', 'ping', {}, { metadata })).ok, true)
  controller.abort()
  await consumer
  assert.ok(backend.checkpoints.size > 0, 'checkpoints are saved behind their data')
})

test('a refused session snapshot is isolated and recovers without losing the healthy session', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projection-recovery-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const backend = new SyncBackend()
  const refused = sessionId('recovery', 'persisted-only')
  let rejectRefused = true
  backend.snapshotRejection = request => rejectRefused && request.sessionId === refused ? 'history_too_large' : undefined
  const bridge = await syncBridge(backend, { native,
    query: { listSessions: signal => native.inventory(signal), readSession: id => native.read(id),
      readTitleSnapshots: (...args) => fixture.ctx.sessionQuery.readTitleSnapshots(...args) },
    status: id => native.status(id) })
  const metadata = { 'aa-session-namespace': 'recovery' }
  const controller = new AbortController()
  const errors: unknown[] = []
  const consumer = (async () => {
    for await (const _item of bridge.client.serverStream('aa.dsh.v2.Bridge', 'sync',
      { subscriptionId: 'catalog' }, { metadata, signal: controller.signal })) void _item
  })().catch(error => { if (!controller.signal.aborted) errors.push(error) })
  t.after(async () => { controller.abort(); await consumer; await bridge.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  await until(() => backend.snapshots.some(snapshot => snapshot.request.sessionId === refused && !snapshot.accepted), 'the refused snapshot is reported')
  await until(() => backend.batches.some(batch => JSON.stringify(batch.operations).includes('session.inventory.complete')), 'the inventory completes despite the refusal')
  const healthy = backend.snapshots.find(snapshot => snapshot.request.sessionId === sessionId('recovery', 'native-main'))!
  assert.equal(healthy.accepted, true)
  assert.ok(healthy.pages.some(page => page.length > 0), 'the healthy session keeps its history')
  const complete = backend.batches.flatMap(batch => batch.operations)
    .find(operation => JSON.stringify(operation).includes('session.inventory.complete'))!
  const refusedState = (complete.notifications as { params: { sessions: { externalSessionId: string, sourceState: { availability: string, reason: string } }[] } }[])
    .flatMap(notification => notification.params.sessions)
    .find(session => session.externalSessionId === 'persisted-only')!
  assert.equal(refusedState.sourceState.availability, 'unavailable')
  assert.equal(refusedState.sourceState.reason, 'history_too_large')
  rejectRefused = false
  native.refresh('persisted-only')
  await until(() => backend.snapshots.filter(snapshot => snapshot.request.sessionId === refused && snapshot.accepted).length === 1,
    'an explicit refresh captures the repaired session')
  await delay(100)
  assert.deepEqual(errors, [], 'neither refusal nor recovery closes the stream')
})
