import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { LocalRouter, Mesh, MeshCallError, Router } from 'meshcall'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'
import { BridgeConnection } from '../../src/host/dsh-runtime/connection.js'
import { writeJson } from '../../src/host/storage/files.js'
import dshProtocol from '@deepseek-ai/dsh-typert-protocol/package.json' with { type: 'json' }
import bridgePackage from '../../package.json' with { type: 'json' }

const execute = promisify(execFile)

async function until(check: () => boolean | Promise<boolean>, label: string, attempts = 800) {
  for (let n = 0; n < attempts; n++) { if (await check()) return; await delay(10) }
  assert.fail(label)
}

const code = (wanted: string) => (error: unknown) => error instanceof MeshCallError && error.code === wanted
const serviceGone = (error: unknown) => error instanceof MeshCallError
  && ['unavailable', 'method_not_found'].includes(error.code)

/**
 * The probe's mock Host asserts as soon as `DshRuntime.start()` returns, while the real
 * DshRuntime schedules a retry when the plugin registers just after the Connector published
 * its rendezvous. The plugin polls that file once a second, so grant `initialize` the same
 * bounded retry the production runtime performs instead of requiring the registration to
 * win a ~50 ms race.
 */
async function runNativeProbe(home: string): Promise<string> {
  const hook = join(home, 'probe-hook')
  await mkdir(hook, { recursive: true })
  await writeFile(join(hook, 'sitecustomize.py'), `
import asyncio
from connector.runtimes.dsh.bridge.client import BridgeClient, BridgeUnavailableError
_original_start = BridgeClient.start
async def _start(self):
    for attempt in range(100):
        try:
            return await _original_start(self)
        except BridgeUnavailableError:
            if attempt == 99:
                raise
            await asyncio.sleep(0.05)
BridgeClient.start = _start
`)
  const cwd = new URL('../../../connector/', import.meta.url)
  const { stdout } = await execute('uv', ['run', '--frozen', 'python', 'tests/dsh_native_probe.py', home],
    { cwd, timeout: 40_000, env: { ...process.env, PYTHONPATH: hook } })
  return stdout
}

/** A Connector Router and the rendezvous document it publishes for the plugin. */
async function connectorRouter() {
  const endpoint = process.platform === 'win32'
    ? { pipe: `agents-anywhere-runtime-${randomUUID()}` }
    : { unixPath: join(tmpdir(), `.aa-runtime-${randomUUID().slice(0, 8)}.sock`) }
  const router = await LocalRouter.start(endpoint)
  return { router, endpoint }
}

const reader = { query: { listSessions: async () => [], readTitleSnapshots: async () => [], readSession: async () => { throw new Error('unused') } }, status: () => undefined }

test('published Host + official SessionQuery/JSONL + actual Python adapter complete the read-only workflow', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-native-'))
  let context: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  let router: LocalRouter | undefined
  let mesh: Mesh | undefined
  try {
    context = await nativeRuntime(home)
    // Act as the Connector: publish the 2.0 rendezvous the plugin follows.
    const local = await connectorRouter()
    router = local.router
    const key = `mk_native_${randomUUID()}`
    const instanceId = randomUUID()
    const rendezvous = bridgePath(home, 'connector.json')
    const publish = () => writeJson(rendezvous, { version: 2, protocol: 'meshcall', instanceId,
      pid: process.pid, endpoint: local.endpoint, key })
    await publish()
    mesh = new Mesh(new Router(local.endpoint), { token: key, peerId: `native-client-${randomUUID()}` })
    const call = (method: string, params: Record<string, unknown> = {}, namespace = 'instance') =>
      mesh!.unary<Record<string, unknown>, Record<string, unknown>>('aa.dsh.v2.Bridge', method, params,
        { metadata: { 'aa-session-namespace': namespace }, timeoutMs: 10_000 })
    await until(async () => { try { return (await call('ping')).ok === true } catch { return false } }, 'the plugin serves the published rendezvous')
    const identity = await mesh.unary<Record<string, unknown>, Record<string, unknown>>('aa.dsh.v2.Bridge', 'initialize',
      { protocolVersion: '2.0', runtime: 'dsh' })
    assert.equal(identity.features.readOnly, true)
    assert.equal(identity.identity.runtimeVersion, dshProtocol.version, 'reports the Host DSH version')
    assert.equal(identity.identity.bridgeVersion, bridgePackage.version)
    assert.equal(identity.identity.protocolVersion, '2.0')
    const snapshot = await call('getSessionSnapshot', { sessionId: sessionId('instance', 'native-main'), externalSessionId: 'native-main' })
    assert.equal(snapshot.complete, true)
    assert.equal((snapshot.items as { type: string }[]).filter(item => item.type === 'tool').length, 1)
    const stdout = await runNativeProbe(home)
    assert.match(stdout, /DSH native integration passed/)
    // The probe is its own Connector and removes its rendezvous; the test republishes
    // and the plugin must follow the replacement without a restart.
    await publish()
    await until(async () => { try { return (await call('ping')).ok === true } catch { return false } }, 'the plugin follows the replacement Connector')
    assert.equal(context.ctx.sessions.get('persisted-only' as never), undefined)
    assert.equal(context.ctx.get('agents'), undefined)
    const cold = (await context.ctx.sessionQuery.listSessions()).find(item => item.header.id === 'persisted-only')!
    const location = ({ path: (await (context.ctx.sessionPersistence as import('@deepseek-ai/dsh-session-persistence-jsonl').default).resolveCurrentLog(cold.header.id))! })
    const original = await readFile(location.path)
    const future = { seq: 1007, time: Date.now(), type: 'future/required', data: { message: 'future content' } }
    await appendFile(location.path, `${JSON.stringify(future)}\n`)
    await assert.rejects(call('getSessionSnapshot', { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only' }),
      code('PERSISTENCE_ERROR'))
    await writeFile(location.path, Buffer.concat([original, Buffer.from(`${JSON.stringify({ ...future, ignorable: true })}\n`)]))
    const compatible = await call('getSessionSnapshot', { sessionId: sessionId('instance', 'persisted-only'), externalSessionId: 'persisted-only', limit: 1 })
    assert.equal((compatible.items as { type: string }[])[0]!.type, 'turn.end')
  } finally {
    await mesh?.close().catch(() => undefined)
    await router?.stop().catch(() => undefined)
    await context?.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

test('only the Connector key can call the Bridge, and closing leaves the Connector rendezvous alone', { timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-wire-'))
  const endpoint = process.platform === 'win32'
    ? { pipe: `agents-anywhere-auth-${randomUUID()}` }
    : { unixPath: join(tmpdir(), `.aa-auth-${randomUUID().slice(0, 8)}.sock`) }
  const key = `mk_bridge_${randomUUID()}`
  const authFile = join(home, 'router-auth.json')
  await writeFile(authFile, JSON.stringify({ api_keys: [{
    id: 'bridge', key_hash: createHash('sha256').update(key).digest('hex'), roles: ['client', 'server'],
    register: ['aa.dsh.v2.Bridge'], call: ['aa.dsh.v2.Bridge/*'],
  }] }))
  const router = await LocalRouter.start({ ...endpoint, authFile })
  const path = join(home, 'bridge', 'connector.json')
  const published = () => writeJson(path, { version: 2, protocol: 'meshcall', instanceId: 'auth-connector',
    pid: process.pid, endpoint, key })
  await published()
  const connection = new BridgeConnection(path, reader, undefined, 20)
  let rejected: Mesh | undefined
  t.after(async () => {
    await rejected?.close().catch(() => undefined)
    await connection.close()
    await router.stop().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  await connection.start()
  await until(() => connection.connectorInstance === 'auth-connector', 'the connector announces itself')
  rejected = new Mesh(new Router(endpoint), { token: `mk_bridge_${randomUUID()}`, peerId: `wrong-${randomUUID()}` })
  await assert.rejects(rejected.unary('aa.dsh.v2.Bridge', 'ping', {},
    { metadata: { 'aa-session-namespace': 'instance' }, timeoutMs: 5_000 }), code('unavailable'))
  const before = await readFile(path, 'utf8')
  await connection.close()
  assert.equal(await readFile(path, 'utf8'), before, 'the plugin never deletes or rewrites the Connector rendezvous')
})

test('a replacement Connector is followed, and a malformed rendezvous disconnects until a valid one appears', { timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-handover-'))
  const path = join(home, 'bridge', 'connector.json')
  const first = await connectorRouter()
  const second = await connectorRouter()
  const keyA = `mk_first_${randomUUID()}`, keyB = `mk_second_${randomUUID()}`
  const publish = (endpoint: { unixPath: string } | { pipe: string }, instanceId: string, key: string) =>
    writeJson(path, { version: 2, protocol: 'meshcall', instanceId, pid: process.pid, endpoint, key })
  const clientA = new Mesh(new Router(first.endpoint), { token: keyA, peerId: `a-${randomUUID()}` })
  const clientB = new Mesh(new Router(second.endpoint), { token: keyB, peerId: `b-${randomUUID()}` })
  const connection = new BridgeConnection(path, reader, undefined, 20)
  const ping = (client: Mesh) => client.unary('aa.dsh.v2.Bridge', 'ping', {}, { metadata: { 'aa-session-namespace': 'instance' }, timeoutMs: 2_000 })
  t.after(async () => {
    await connection.close()
    await clientA.close().catch(() => undefined)
    await clientB.close().catch(() => undefined)
    await first.router.stop().catch(() => undefined)
    await second.router.stop().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  await publish(first.endpoint, 'connector-a', keyA)
  await connection.start()
  await until(async () => { try { return (await ping(clientA)).ok === true } catch { return false } }, 'the first Connector is served')
  await publish(second.endpoint, 'connector-b', keyB)
  await until(async () => { try { return (await ping(clientB)).ok === true } catch { return false } }, 'the replacement Connector is served')
  await assert.rejects(ping(clientA), serviceGone)
  await writeFile(path, '{truncated')
  await until(() => connection.connectorInstance === undefined, 'a malformed rendezvous disconnects the bridge')
  await publish(second.endpoint, 'connector-b', keyB)
  await until(async () => { try { return (await ping(clientB)).ok === true } catch { return false } }, 'a valid rendezvous reconnects the bridge')
})
