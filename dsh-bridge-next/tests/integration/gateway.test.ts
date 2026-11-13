import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { readJson } from '../../src/host/storage/files.js'
import { mountRemoteAccess, ownerPeer } from '../fixtures/gateway-host.js'

test('published Host is callable through the actual rc.1 Gateway and disposes its resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-gateway-'))
  const originalUserInfo = os.userInfo
  const homeMock = t.mock.method(os, 'userInfo', () => ({ ...originalUserInfo(), homedir: join(root, 'home') }))
  syncBuiltinESMExports()
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry).await()
    await mountRemoteAccess(ctx)
    await ctx.plugin(Gateway).await()
    const peer = ownerPeer(ctx)
    const invoke = (method: string, args: Record<string, unknown> = {}) =>
      ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method, args, peer })
    const host = await import('../../lib/index.js')
    const plugin = ctx.plugin(host, { stateRoot: root, dshHome: join(root, 'dsh'), connectorSourceDir: root })
    await plugin.await()
    for (let n = 0; n < 100 && !ctx.get('agentsAnywhereOnboarding'); n++) await delay(5)
    const result = await invoke('inspect') as { stage: string }
    assert.equal(result.stage, 'idle')
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(join(root, 'logs', 'dsh-runtime.jsonl'), JSON.stringify({ time: new Date().toISOString(), level: 'error', event: 'sync.failed', errorCode: 'PERSISTENCE_ERROR' }) + '\n')
    const logs = await invoke('readBridgeLogs') as { entries: { event: string }[] }
    assert.deepEqual(logs.entries, [], 'Legacy runtime files are no longer read outside Connector')
    const connectorLogs = await invoke('readConnectorLogs', { query: {} }) as { entries: unknown[] }
    assert.deepEqual(connectorLogs.entries, [], 'Connector logs are available through the Host RPC even before startup')
    await assert.rejects(invoke('begin', {
      input: { target: 'server', serverUrl: 'https://api.example.test/login' },
    }), /页面路径/)
    await assert.rejects(invoke('configure'))
    assert.equal(await invoke('cancel'), null)
    await assert.rejects(invoke('dispose'))
    await plugin.dispose()
    assert.equal(await readJson(join(root, 'manager.lock')), null)
    await assert.rejects(invoke('inspect'))
  } finally { await ctx.fiber.dispose(); homeMock.mock.restore(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
})
