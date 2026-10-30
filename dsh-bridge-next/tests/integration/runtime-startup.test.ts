import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { LocalRouter, Mesh, Router } from 'meshcall'
import { acquireManagerLock, writeJson } from '../../src/host/storage/files.js'
import { bridgePath, nativeRuntime } from '../fixtures/native-runtime.js'
import { ownerPeer } from '../fixtures/gateway-host.js'
import type { OnboardingSnapshot } from '../../src/contracts/index.js'
import type { BridgeStatus } from '../../src/contracts/bridge-status.js'
import type { StartupFailureDiagnostic } from '../../src/contracts/logs.js'
import { startupFailure } from '../../src/host/dsh-runtime/startup-status.js'

/** A Connector Router on a private endpoint, as the Connector itself would start one. */
async function localRouter(): Promise<{ router: LocalRouter, endpoint: { unixPath: string } | { pipe: string } }> {
  if (process.platform === 'win32') {
    const pipe = `agents-anywhere-startup-${randomUUID()}`
    return { router: await LocalRouter.start({ pipe }), endpoint: { pipe } }
  }
  // Unix socket paths are length-limited; keep the endpoint outside the temp home.
  const unixPath = join(tmpdir(), `.aa-startup-${randomUUID().slice(0, 8)}.sock`)
  return { router: await LocalRouter.start({ unixPath }), endpoint: { unixPath } }
}

test('a busy local bridge keeps the management gateway available and can restart after release', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-startup-retry-'))
  // The manager lock lives next to the rendezvous the Connector publishes.
  const rendezvousPath = bridgePath(home, 'connector.json')
  const release = await acquireManagerLock(rendezvousPath)
  const releaseManager = await acquireManagerLock(join(home, 'account/manager.lock'))
  let fixture: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  let router: LocalRouter | undefined
  let client: Mesh | undefined
  try {
    fixture = await nativeRuntime(home)
    for (let i = 0; i < 100 && !fixture.ctx.get('agentsAnywhereOnboarding'); i++) await delay(5)
    const gateway = fixture.ctx.typertGateway, peer = ownerPeer(fixture.ctx)
    const invoke = (method: string) => gateway.invoke({ namespace: 'agentsAnywhereOnboarding', method, args: {}, peer })
    const snapshot = await invoke('inspect') as OnboardingSnapshot
    assert.equal(snapshot.bridge?.state, 'failed')
    assert.equal(snapshot.bridge?.code, 'BRIDGE_IN_USE')
    assert.match(snapshot.bridge!.hint, /退出其他/)
    const startup = await invoke('readStartupDiagnostics') as StartupFailureDiagnostic[]
    assert.ok(startup.some(entry => entry.source === 'plugin' && entry.event === 'onboarding.start_failed'))
    assert.match(JSON.stringify(startup), /MANAGER_LOCK_HELD/)
    assert.equal((await invoke('restartBridge') as BridgeStatus).state, 'failed')
    await release()
    await releaseManager()
    assert.equal((await invoke('restartBridge') as BridgeStatus).state, 'ready')
    const runtime = fixture.ctx.agentsAnywhereRuntime
    const first = runtime.restart()
    assert.equal(runtime.restart(), first, 'concurrent retries share one attempt')
    assert.equal((await first).state, 'ready')
    assert.equal((await invoke('inspect') as OnboardingSnapshot).bridge?.state, 'ready')
    assert.deepEqual(await invoke('readStartupDiagnostics'), [], 'successful restart clears active startup failures')
    // A Connector publishes the MeshCall rendezvous; the restarted Bridge serves it.
    const local = await localRouter()
    router = local.router
    const key = `mk_startup_${randomUUID()}`
    await writeJson(rendezvousPath, { version: 2, protocol: 'meshcall', instanceId: randomUUID(),
      pid: process.pid, endpoint: local.endpoint, key })
    client = new Mesh(new Router(local.endpoint), { token: key, peerId: `startup-client-${randomUUID()}` })
    let served = false
    for (let i = 0; i < 200 && !served; i++) {
      try {
        const ping = await client.unary('aa.dsh.v2.Bridge', 'ping', {},
          { metadata: { 'aa-session-namespace': 'startup' }, timeoutMs: 2_000 })
        served = (ping as { ok?: boolean }).ok === true
      } catch { await delay(25) }
    }
    assert.equal(served, true, 'the restarted Bridge follows the Connector rendezvous')
    assert.doesNotMatch(JSON.stringify(runtime.status()), new RegExp(key))
  } finally {
    await client?.close().catch(() => undefined)
    await router?.stop().catch(() => undefined)
    await releaseManager(); await release(); await fixture?.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true })
  }
})

test('permission failures remain readable through the management RPC without Connector or writable log files', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-startup-permission-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const fixture = await nativeRuntime(home)
  for (let i = 0; i < 100 && !fixture.ctx.get('agentsAnywhereOnboarding'); i++) await delay(5)
  const runtime = fixture.ctx.agentsAnywhereRuntime
  await runtime.restart()
  const initialize = runtime.native.attachments.initialize.bind(runtime.native.attachments)
  try {
    runtime.native.attachments.initialize = async () => {
      throw Object.assign(new Error('PRIVATE_TOKEN PRIVATE_PROMPT', {
        cause: Object.assign(new Error('PRIVATE_PATH'), { code: 'EPERM' }),
      }), { code: 'EACCES' })
    }
    assert.equal((await runtime.restart()).code, 'EACCES')
    const logs = join(home, 'account', 'logs')
    await rm(logs, { recursive: true, force: true })
    await writeFile(logs, 'not a log directory')
    const peer = ownerPeer(fixture.ctx)
    const invoke = (method: string) => fixture.ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method, args: {}, peer })
    await assert.rejects(invoke('readConnectorLogs'))
    const failures = await invoke('readStartupDiagnostics') as StartupFailureDiagnostic[]
    assert.equal(failures.length, 1)
    assert.equal(failures[0]!.source, 'bridge')
    assert.equal(failures[0]!.event, 'bridge.restart_failed')
    const details = JSON.parse(failures[0]!.details)
    assert.equal(details.errorCode, 'EACCES')
    assert.equal(details.cause.errorCode, 'EPERM')
    assert.ok(details.stack.length > 0)
    assert.doesNotMatch(JSON.stringify(failures), /PRIVATE_/)
    assert.equal(runtime.hasLogConnection(), false)
    runtime.native.attachments.initialize = initialize
    assert.equal((await runtime.restart()).state, 'ready')
    assert.deepEqual(await invoke('readStartupDiagnostics'), [])
  } finally {
    runtime.native.attachments.initialize = initialize
    await fixture.ctx.fiber.dispose()
  }
})

test('startup guidance distinguishes permission, storage and unknown failures without exposing raw exceptions', () => {
  assert.equal(startupFailure({ code: 'MANAGER_LOCK_HELD' }).code, 'BRIDGE_IN_USE')
  assert.match(startupFailure({ code: 'EACCES' }).hint, /权限/)
  assert.match(startupFailure({ code: 'ENOSPC' }).hint, /释放磁盘空间/)
  assert.match(startupFailure({ code: 'EROFS' }).hint, /只读/)
  assert.doesNotMatch(JSON.stringify(startupFailure(new Error('PRIVATE_TOKEN'))), /PRIVATE_TOKEN/)
})
