import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { readJson } from '../../src/host/storage/files.js'

test('published Host is callable through the actual rc.1 Gateway and disposes its resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aa-gateway-'))
  const originalUserInfo = os.userInfo
  const homeMock = t.mock.method(os, 'userInfo', () => ({ ...originalUserInfo(), homedir: join(root, 'home') }))
  syncBuiltinESMExports()
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry).await()
    await ctx.plugin(Gateway).await()
    const host = await import('../../lib/index.js')
    const plugin = ctx.plugin(host, { stateRoot: root, dshHome: join(root, 'dsh'), connectorSourceDir: root })
    await plugin.await()
    for (let n = 0; n < 100 && !ctx.get('agentsAnywhereOnboarding'); n++) await delay(5)
    const result = await ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method: 'inspect', args: {} }) as { stage: string }
    assert.equal(result.stage, 'idle')
    await assert.rejects(ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method: 'begin', args: {
      input: { target: 'server', serverUrl: 'https://api.example.test/login' },
    } }), /页面路径/)
    await assert.rejects(ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method: 'configure', args: {} }))
    assert.equal(await ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method: 'cancel', args: {} }), null)
    await assert.rejects(ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method: 'dispose', args: {} }))
    await plugin.dispose()
    assert.equal(await readJson(join(root, 'manager.lock')), null)
    await assert.rejects(ctx.typertGateway.invoke({ namespace: 'agentsAnywhereOnboarding', method: 'inspect', args: {} }))
  } finally { await ctx.fiber.dispose(); homeMock.mock.restore(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
})
