import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { CallCancelledError, MeshCallClient, MeshCallError } from 'meshcall'
import { guardMeshCallResults } from '../../src/host/meshcall-guard.js'

/**
 * A client whose call.open frame takes `writeMs` to leave, like a frame queued
 * behind a large sync batch on a socket the busy Connector is not reading.
 */
function slowWriter(writeMs: number): MeshCallClient {
  const client = new MeshCallClient('ws://127.0.0.1:9', 'guard-test', { deadlineGraceMs: 0, retry: false })
  Object.assign(client, {
    connectWithin: async () => undefined,
    send: async (frame: { kind: string }) => { if (frame.kind === 'call.open') await delay(writeMs) },
  })
  return client
}

async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try { await run(); await delay(20) }
  finally { process.off('unhandledRejection', listener) }
  return unhandled
}

test('a call aborted while its open frame is still being written does not leave an unhandled rejection', async () => {
  guardMeshCallResults()
  const controller = new AbortController()
  const unhandled = await unhandledDuring(async () => {
    const call = slowWriter(100).unary('aa.test.v1.Svc', 'Method', {}, { signal: controller.signal })
    await delay(10)
    controller.abort() // What SyncFeed.close() does to an in-flight ingestBatch (#499).
    await assert.rejects(call, CallCancelledError)
  })
  assert.deepEqual(unhandled, [])
})

test('a call whose local deadline passes while its open frame is being written does not leave an unhandled rejection', async () => {
  guardMeshCallResults()
  const unhandled = await unhandledDuring(async () => {
    // A short `timeoutMs` call (log upload, Connector state read) behind a slow socket (#517).
    const call = slowWriter(100).unary('aa.test.v1.Svc', 'Method', {}, { timeoutMs: 20 })
    await assert.rejects(call, (error: unknown) => error instanceof MeshCallError && error.code === 'deadline_exceeded')
  })
  assert.deepEqual(unhandled, [])
})

test('guarding is idempotent and leaves results unchanged', async () => {
  guardMeshCallResults()
  guardMeshCallResults()
  const client = new MeshCallClient('ws://127.0.0.1:9', 'guard-test', { retry: false })
  const registered = (client as unknown as { registerCall: (...args: unknown[]) => { pending: { resolve(value: unknown): void }, result: Promise<unknown> } })
    .registerCall('call-1', {}, performance.now())
  registered.pending.resolve({ ok: true })
  assert.deepEqual(await registered.result, { ok: true })
})
