import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { readJson } from '../../src/host/storage/files.js'

test('published Host is callable through the actual rc.1 Gateway and disposes its resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-gateway-'))
  const originalUserInfo = os.userInfo
  const homeMock = t.mock.method(os, 'userInfo', () => ({ ...originalUserInfo(), homedir: join(root, 'home') }))
  syncBuiltinESMExports()
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry).await()
    // 0.2.1 Gateway injects ["typert", "remoteAccess"]; the policy service is an official peer.
    let remoteAccess: string | undefined
    try { remoteAccess = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-remote-access') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error }
    if (remoteAccess) await ctx.plugin((await import(pathToFileURL(remoteAccess).href)).default).await()
    await ctx.plugin(Gateway).await()
    // 0.2.1 requires every in-process call to speak for a live owner Peer (0.2.0 named it operator).
    const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
    const peer = (connection as any).browserPeer ?? (connection as any).operator
    const invoke = (method: string, args: Record<string, unknown> = {}) => ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method, args, peer })
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
