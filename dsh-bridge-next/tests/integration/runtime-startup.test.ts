import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { acquireManagerLock } from '../../src/host/storage/files.js'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import type { OnboardingSnapshot } from '../../src/contracts/index.js'
import type { BridgeStatus } from '../../src/contracts/bridge-status.js'
import { startupFailure } from '../../src/host/dsh-runtime/startup-status.js'

test('a busy local bridge keeps the management gateway available and can restart after release', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-startup-retry-'))
  const endpointPath = join(home, 'agents-anywhere/bridge/endpoint.json')
  const release = await acquireManagerLock(endpointPath)
  const releaseManager = await acquireManagerLock(join(home, 'account/manager.lock'))
  let fixture: Awaited<ReturnType<typeof nativeRuntime>> | undefined
  try {
    fixture = await nativeRuntime(home)
    for (let i = 0; i < 100 && !fixture.ctx.get('agentsAnywhereOnboarding'); i++) await delay(5)
    const gateway = fixture.ctx.typertGateway
    const invoke = (method: string) => gateway.invoke({ namespace: 'agentsAnywhereOnboarding', method, args: {} })
    const snapshot = await invoke('inspect') as OnboardingSnapshot
    assert.equal(snapshot.bridge?.state, 'failed')
    assert.equal(snapshot.bridge?.code, 'BRIDGE_IN_USE')
    assert.match(snapshot.bridge!.hint, /退出其他/)
    assert.equal((await invoke('restartBridge') as BridgeStatus).state, 'failed')
    await release()
    await releaseManager()
    assert.equal((await invoke('restartBridge') as BridgeStatus).state, 'ready')
    const runtime = fixture.ctx.agentsAnywhereRuntime
    const first = runtime.restart()
    assert.equal(runtime.restart(), first, 'concurrent retries share one attempt')
    assert.equal((await first).state, 'ready')
    assert.equal((await invoke('inspect') as OnboardingSnapshot).bridge?.state, 'ready')
    const endpoint = JSON.parse(await readFile(endpointPath, 'utf8'))
    assert.ok(endpoint.port > 0)
    assert.doesNotMatch(JSON.stringify(runtime.status()), new RegExp(endpoint.token))
  } finally { await releaseManager(); await release(); await fixture?.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('startup guidance distinguishes permission, storage and unknown failures without exposing raw exceptions', () => {
  assert.match(startupFailure({ code: 'EACCES' }).hint, /权限/)
  assert.match(startupFailure({ code: 'ENOSPC' }).hint, /释放磁盘空间/)
  assert.match(startupFailure({ code: 'EROFS' }).hint, /只读/)
  assert.doesNotMatch(JSON.stringify(startupFailure(new Error('PRIVATE_TOKEN'))), /PRIVATE_TOKEN/)
})
