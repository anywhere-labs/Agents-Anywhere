import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents, TextAdapter, initialSelections } from '../fixtures/agent-runtime.js'
import { nativeSessionId } from '../../src/host/dsh-runtime/identity.js'
import { bridge2Connector, connectorTsInstalled, v3RouterBinary } from '../helpers/ts-connector.js'

const routerBinary = v3RouterBinary()
const skip = !connectorTsInstalled ? 'connector-ts is not installed' : !routerBinary ? 'no meshcall 9334405 Router binary' : false

test('the plugin declares the DSH default mode, and a session created with it starts in that mode', { timeout: 60_000, skip }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-dsh-default-preset-'))
  const adapter = new TextAdapter()
  const fixture = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const release = setInterval(() => adapter.release?.(), 10)
  let connector: Awaited<ReturnType<typeof bridge2Connector>> | undefined
  try {
    const expected = fixture.ctx.agentPresets.defaultId
    assert.equal(expected, 'minimal', 'the fixture default differs from standard so the two rules are told apart')
    connector = await bridge2Connector(home, 'preset-wire', routerBinary!)
    // The plugin declares the initial mode in the catalog the Runtime config form uses.
    const catalog = await connector.runtime.client.request('listAgentPresets') as { configField?: { default?: string } }
    assert.equal(catalog.configField?.default, expected)
    const result = await connector.runtime.client.request('createAndStartSession', { sessionId: 'sess_default_preset', content: 'hello',
      clientMessageId: 'preset-1', cwd: home, selections: initialSelections, planningIntent: false, agentPreset: catalog.configField!.default })
    assert.notEqual(result.ok, false, JSON.stringify(result))
    const id = SessionId(nativeSessionId('preset-wire', 'sess_default_preset'))
    const state = await fixture.ctx.agentsAnywhereRuntime.native.configuration.state(id)
    assert.equal(state.metadata.agentPreset, expected)
  } finally {
    clearInterval(release); adapter.release?.()
    await connector?.close()
    await fixture.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
