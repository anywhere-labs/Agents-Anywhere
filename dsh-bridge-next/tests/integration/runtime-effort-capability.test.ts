import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { initialSelections, mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { modelSelectionId } from '../../src/host/dsh-runtime/selections.js'

async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), 'expected native progress within 5 seconds')
}

test('a model catalog failure cannot disable text messaging and recovers on retry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-catalog-recovery-'))
  const f = await nativeRuntime(home, ctx => mountAgents(ctx, new TextAdapter()))
  const runtime = f.ctx.agentsAnywhereRuntime.native
  const models = runtime.catalogs.models.bind(runtime.catalogs)
  try {
    runtime.catalogs.models = async () => { throw new Error('temporary model catalog failure') }
    const degraded = await runtime.capabilities()
    assert.equal(degraded.capabilities.find(item => item.capabilityId === 'session.send_message')?.available, true)
    assert.equal(degraded.capabilities.find(item => item.capabilityId === 'catalog.model')?.available, false)
    runtime.catalogs.models = models
    const recovered = await runtime.capabilities()
    assert.equal(recovered.capabilities.find(item => item.capabilityId === 'catalog.model')?.available, true)
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('interrupting a model without effort preserves the ability to select another model with effort', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-effort-interrupt-'))
  const adapter = new TextAdapter()
  const f = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const runtime = f.ctx.agentsAnywhereRuntime.native
  const id = SessionId('effort-interrupt')
  try {
    await runtime.send(id, 'first', 'first-id', home, true, initialSelections, 'standard')
    await until(() => !!adapter.release)
    await runtime.interrupt(id)
    await f.ctx.agents.get(id)!.whenIdle()

    for (const capabilitySet of [await runtime.capabilities(), await runtime.capabilities('aa-session', id)]) {
      for (const capabilityId of ['catalog.model', 'catalog.effort']) {
        const value = capabilitySet.capabilities.find(item => item.capabilityId === capabilityId)
        assert.equal(value?.supported && value.available && value.allowed, true)
      }
    }
    const catalog = await runtime.catalogs.models()
    assert.deepEqual(catalog.models.find(item => item.metadata.model === 'text')?.reasoningItems, [])
    assert.equal(catalog.models.find(item => item.metadata.model === 'thinking')?.reasoningItems.length, 2)

    const next = modelSelectionId({ provider: 'test', model: 'thinking', reasoningEffort: 'high' })
    await runtime.updateSelections(id, { model: next }, new AbortController().signal)
    assert.equal((await runtime.configuration.state(id)).selections.model, next)
    await assert.rejects(runtime.updateSelections(id, {
      model: modelSelectionId({ provider: 'test', model: 'text', reasoningEffort: 'high' }),
    }, new AbortController().signal), /provider, model or effort/)
    await runtime.send(id, 'second', 'second-id')
    await until(() => adapter.requests.length === 2 && !!adapter.release)
    assert.equal(adapter.requests[1]!.model, 'thinking')
    assert.equal(adapter.requests[1]!.reasoningEffort, 'high')
    await runtime.interrupt(id)
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('a model catalog without any reasoning options does not advertise effort selection', async () => {
  class TextOnlyAdapter extends TextAdapter {
    override async listModels(provider: string) {
      return (await super.listModels(provider)).filter(item => item.id === 'text')
    }
  }
  const home = await mkdtemp(join(tmpdir(), 'aa-effort-unavailable-'))
  const f = await nativeRuntime(home, ctx => mountAgents(ctx, new TextOnlyAdapter()))
  try {
    for (const id of [undefined, f.session.id]) {
      const capabilities = await f.ctx.agentsAnywhereRuntime.native.capabilities(id ? 'aa-session' : undefined, id)
      assert.equal(capabilities.capabilities.find(item => item.capabilityId === 'catalog.model')?.supported, true)
      assert.equal(capabilities.capabilities.find(item => item.capabilityId === 'catalog.effort')?.supported, false)
    }
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
