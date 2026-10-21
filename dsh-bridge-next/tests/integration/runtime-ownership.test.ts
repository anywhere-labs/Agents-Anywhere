import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { BridgeConnection } from '../../src/host/dsh-runtime/connection.js'

const reader = { query: { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => { throw new Error('unused') } }, status: () => undefined }

/** A syntactically valid rendezvous whose Router does not exist: the plugin must stay unlinked. */
function staleRendezvous(): string {
  const endpoint = process.platform === 'win32'
    ? { pipe: 'agents-anywhere-missing-owner' }
    : { unixPath: join(tmpdir(), 'agents-anywhere-missing-router.sock') }
  return JSON.stringify({ version: 2, protocol: 'meshcall', instanceId: 'crashed-owner', pid: process.pid, endpoint, key: 'mk_crashed_owner' })
}

function isLockHeld(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'MANAGER_LOCK_HELD'
}

// The 1.0 descriptor ownership checks are gone: the plugin no longer publishes an
// endpoint and the manager lock, not a descriptor, decides which instance serves.
for (const descriptor of [staleRendezvous(), '{truncated', 'null']) {
  test(`a stale rendezvous ${descriptor.slice(0, 24)} never blocks the manager lock, and a later owner takes over`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'bridge-stale-'))
    const file = join(home, 'bridge', 'connector.json')
    await mkdir(join(home, 'bridge'))
    await writeFile(file, descriptor)
    const owner = new BridgeConnection(file, reader, undefined, 20)
    const contender = new BridgeConnection(file, reader, undefined, 20)
    t.after(async () => { await Promise.all([owner.close(), contender.close()]); await rm(home, { recursive: true, force: true }) })
    await owner.start()
    // An unparseable or unreachable rendezvous is ignored rather than fatal: no Connector is served.
    assert.equal(owner.connectorInstance, undefined)
    await assert.rejects(contender.start(), isLockHeld)
    await owner.close()
    await contender.start()
    assert.equal(contender.connectorInstance, undefined)
  })
}

test('a crashed bridge releases the lease and a fresh instance reclaims the directory', { timeout: 15_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-crash-'))
  const file = join(home, 'bridge', 'connector.json')
  const module = new URL('../../src/host/dsh-runtime/connection.ts', import.meta.url).href
  const script = `import { BridgeConnection } from ${JSON.stringify(module)}; const connection = new BridgeConnection(process.argv[1], { query: { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => { throw new Error('unused') } }, status: () => undefined }, undefined, 50); await connection.start(); process.send('ready'); setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const owner = new BridgeConnection(file, reader, undefined, 20)
  const ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; await owner.close(); await rm(home, { recursive: true, force: true }) })
  await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('bridge child failed before readiness') })])
  child.kill('SIGKILL')
  await ended
  await owner.start()
  assert.equal(owner.connectorInstance, undefined)
})

test('concurrent starts cannot both manage the directory, and closing twice releases the lease', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-owner-'))
  const file = join(home, 'bridge', 'connector.json')
  const connections = [new BridgeConnection(file, reader, undefined, 20), new BridgeConnection(file, reader, undefined, 20)]
  t.after(async () => { await Promise.all(connections.map(connection => connection.close())); await rm(home, { recursive: true, force: true }) })
  const started = await Promise.allSettled(connections.map(connection => connection.start()))
  assert.equal(started.filter(result => result.status === 'fulfilled').length, 1)
  const winner = started.findIndex(result => result.status === 'fulfilled')
  assert.ok(isLockHeld((started[1 - winner] as PromiseRejectedResult).reason))
  await Promise.all([connections[winner]!.close(), connections[winner]!.close()])
  await connections[1 - winner]!.start()
})
