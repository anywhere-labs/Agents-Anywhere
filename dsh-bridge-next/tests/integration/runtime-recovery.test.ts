import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RuntimeServer, MAX_FRAME_BYTES, type Endpoint } from '../../src/host/dsh-runtime/server.js'
import { SyncFeed, type SyncBatch } from '../../src/host/dsh-runtime/sync.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import { nativeRuntime } from '../fixtures/native-runtime.js'

async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), 'recovery did not complete')
}

function connect(endpoint: Endpoint) {
  const socket = createConnection(endpoint.port, endpoint.host)
  const lines = createInterface({ input: socket })
  const messages: Record<string, any>[] = []
  const pending = new Map<number, (message: Record<string, any>) => void>()
  let id = 0
  let acknowledge = false
  const rpc = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, any>>(resolve => {
    pending.set(++id, resolve)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  lines.on('line', line => {
    const message = JSON.parse(line)
    messages.push(message)
    const resolve = pending.get(message.id)
    pending.delete(message.id)
    resolve?.(message)
    if (acknowledge && message.method === 'runtime.sync.batch') {
      void rpc('runtime.sync.ack', { streamId: message.params.streamId, batchSeq: message.params.batchSeq })
    }
  })
  return { socket, messages, rpc, ack: () => { acknowledge = true },
    initialize: () => rpc('initialize', { authToken: endpoint.token, protocolVersion: '1.0', runtime: 'dsh', connectorId: 'recovery' }),
    close: () => { lines.close(); socket.destroy() } }
}

test('RPC failures, oversized frames, cancellation and timeout preserve other requests and allow retries', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-rpc-recovery-'))
  const fixture = await nativeRuntime(home)
  let readFailed = true, largeTitle = true
  let release: (() => void) | undefined
  const server = new RuntimeServer(join(home, 'rpc/endpoint.json'), {
    query: {
      listSessions: signal => fixture.ctx.sessionQuery.listSessions(signal),
      readTitleSnapshots: async (ids, signal) => (await fixture.ctx.sessionQuery.readTitleSnapshots(ids, signal)).map(title =>
        largeTitle && title.status === 'fulfilled' ? { ...title, value: { ...title.value,
          title: { ...title.value.title!, title: 'x'.repeat(MAX_FRAME_BYTES) } } } : title),
      readSession: async id => {
        if (id === 'hang') await new Promise<void>(resolve => { release = resolve })
        if (readFailed && id === 'fail') throw new Error('PRIVATE_NATIVE_CONTENT')
        return fixture.ctx.sessionQuery.readSession('native-main' as never)
      },
    }, status: () => 'idle',
  }, undefined, 100)
  let wire: ReturnType<typeof connect> | undefined
  try {
    wire = connect(await server.start())
    await wire.initialize()
    const failed = await wire.rpc('session.getState', { externalSessionId: 'fail' })
    assert.equal(failed.error.data.code, 'INTERNAL_ERROR')
    assert.equal(failed.error.data.retryable, true)
    assert.ok(!JSON.stringify(failed).includes('PRIVATE_NATIVE_CONTENT'))
    readFailed = false
    assert.equal((await wire.rpc('session.getState', { externalSessionId: 'fail' })).result.status, 'idle')
    assert.equal((await wire.rpc('unknown.method')).error.data.code, 'METHOD_NOT_FOUND')
    wire.socket.write('{broken json}\n')
    assert.equal((await wire.rpc('ping')).result.ok, true)
    assert.ok(wire.messages.some(message => message.error?.data.code === 'PARSE_ERROR'))
    assert.equal((await wire.rpc('session.list')).error.data.code, 'FRAME_TOO_LARGE')
    largeTitle = false
    assert.ok((await wire.rpc('session.list')).result.sessions.length)
    wire.socket.write('x'.repeat(MAX_FRAME_BYTES + 1))
    wire.socket.write('\n')
    assert.equal((await wire.rpc('ping')).result.ok, true)
    const hung = wire.rpc('session.getState', { externalSessionId: 'hang' })
    assert.equal((await wire.rpc('ping')).result.ok, true, 'a slow request cannot block ping')
    assert.equal((await hung).error.data.code, 'REQUEST_TIMEOUT')
    release?.()
    const cancelled = wire.rpc('session.getState', { externalSessionId: 'hang' })
    await until(() => wire!.messages.some(message => message.error?.data.code === 'REQUEST_TIMEOUT'))
    // This client uses consecutive integer IDs; the hanging request is the last one sent.
    const cancelId = Math.max(...wire.messages.filter(message => typeof message.id === 'number').map(message => message.id)) + 1
    wire.socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: cancelId } })}\n`)
    assert.equal((await cancelled).error.data.code, 'REQUEST_TIMEOUT')
    release?.()
    assert.equal((await wire.rpc('ping')).result.ok, true)
    assert.equal(wire.socket.destroyed, false)
  } finally { release?.(); wire?.close(); await server.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('a failed sync subscription leaves RPC connected and can be replaced on the same connection', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stream-recovery-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const inventory = native.inventory.bind(native)
  let broken = true
  native.inventory = async (signal, visit) => { if (broken) throw new Error('temporary inventory failure'); return inventory(signal, visit) }
  const server = new RuntimeServer(join(home, 'rpc/endpoint.json'), { native,
    query: { listSessions: signal => native.inventory(signal), readSession: id => native.read(id),
      readTitleSnapshots: (...args) => fixture.ctx.sessionQuery.readTitleSnapshots(...args) }, status: id => native.status(id) })
  let wire: ReturnType<typeof connect> | undefined
  try {
    wire = connect(await server.start())
    await wire.initialize()
    wire.ack()
    const first = await wire.rpc('runtime.sync.subscribe')
    await until(() => wire!.messages.some(message => message.method === 'runtime.error'))
    const error = wire.messages.find(message => message.method === 'runtime.error')!
    assert.equal(error.params.data.scope, 'sync')
    assert.equal(error.params.data.streamId, first.result.streamId)
    assert.equal((await wire.rpc('ping')).result.ok, true)
    broken = false
    const second = await wire.rpc('runtime.sync.subscribe')
    assert.notEqual(first.result.streamId, second.result.streamId)
    await until(() => wire!.messages.some(message => message.method === 'runtime.sync.batch' &&
      message.params.operations.some((op: any) => op.notifications?.some((note: any) => note.method === 'session.inventory.complete'))))
    assert.equal((await wire.rpc('ping')).result.ok, true)
  } finally { wire?.close(); await server.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('an oversized session aborts only its snapshot and can recover without losing healthy history', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projection-recovery-'))
  const fixture = await nativeRuntime(home)
  const native = fixture.ctx.agentsAnywhereRuntime.native
  const read = native.read.bind(native)
  let broken = true
  native.read = async id => {
    const snapshot = await read(id)
    return !broken || id !== 'persisted-only' ? snapshot : { ...snapshot, events: snapshot.events.map((event, index) =>
      index === 900 && event.type === 'user/message' ? { ...event, data: { ...event.data,
        content: [{ type: 'text', text: 'x'.repeat(MAX_FRAME_BYTES) }] } } : event) }
  }
  const batches: SyncBatch[] = [], failures: unknown[] = []
  const feed = new SyncFeed(native, 'recovery', batch => {
    batches.push(batch); queueMicrotask(() => feed.ack(batch.batchSeq))
  }, error => failures.push(error))
  const ops = () => batches.flatMap(batch => batch.operations)
  try {
    feed.start()
    await until(() => ops().some(op => op.kind === 'notifications' &&
      (op.notifications as { method: string }[]).some(note => note.method === 'session.inventory.complete')))
    assert.ok(ops().some(op => op.kind === 'snapshot.commit' && op.sessionId === sessionId('recovery', 'native-main')))
    assert.ok(ops().some(op => op.kind === 'snapshot.abort' && op.sessionId === sessionId('recovery', 'persisted-only')))
    assert.ok(!ops().some(op => op.kind === 'snapshot.commit' && op.sessionId === sessionId('recovery', 'persisted-only')))
    broken = false
    native.refresh('persisted-only')
    await until(() => ops().some(op => op.kind === 'snapshot.commit' && op.sessionId === sessionId('recovery', 'persisted-only')))
    assert.deepEqual(failures, [])
  } finally { feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('missing ACK has a bounded wait and reports a recoverable stream failure', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ack-timeout-'))
  const fixture = await nativeRuntime(home)
  const errors: unknown[] = []
  const feed = new SyncFeed(fixture.ctx.agentsAnywhereRuntime.native, 'test', () => {}, error => errors.push(error), 20)
  try { feed.start(); await until(() => errors.length === 1) }
  finally { feed.close(); await fixture.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
