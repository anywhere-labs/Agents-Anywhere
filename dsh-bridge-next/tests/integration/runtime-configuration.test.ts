import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { initialSelections, mountAgents, TextAdapter } from '../fixtures/agent-runtime.js'
import { modelSelectionId, permissionSelectionId } from '../../src/host/dsh-runtime/selections.js'
import { RuntimeRouter } from '../../src/host/dsh-runtime/router.js'
import { sessionId } from '../../src/host/dsh-runtime/identity.js'

const signal = () => new AbortController().signal
const model = (name: string, effort?: string, provider = 'test') => modelSelectionId({ provider, model: name, ...(effort ? { reasoningEffort: effort } : {}) })
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) { if (check()) return; await delay(10) }
  assert.ok(check(), 'expected native progress within 5 seconds')
}

test('AA creation overrides DSH defaults before the first request; live switches and retries preserve session choices', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-config-'))
  const adapter = new TextAdapter()
  const f = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const runtime = f.ctx.agentsAnywhereRuntime.native
  const id = SessionId('configuration-session')
  try {
    await f.ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'thinking', reasoningEffort: 'high' })
    assert.equal(f.ctx.agentPresets.defaultId, 'minimal')
    assert.equal(f.ctx.permissionPresets.defaultPreset, 'danger-full-access')
    await runtime.send(id, 'first', 'first-id', home, true, initialSelections, 'standard')
    await until(() => adapter.requests.length === 1 && !!adapter.release)
    const agent = f.ctx.agents.get(id)!
    assert.equal(adapter.requests[0]!.model, 'text')
    assert.equal(adapter.requests[0]!.reasoningEffort, undefined)
    assert.equal(agent.session.header.cwd, await realpath(home))
    assert.equal((await runtime.configuration.state(id)).metadata.agentPreset, 'standard')
    assert.equal(f.ctx.permissionPresets.current(agent.session), 'workspace-write')

    const next = { model: model('thinking', 'high'), permission: permissionSelectionId('danger-full-access') }
    await runtime.updateSelections(id, next, signal())
    assert.equal(agent.status, 'running', 'configuration does not wait for completion or stop the turn')
    const state = await runtime.configuration.state(id)
    assert.deepEqual(state.selections, next)
    assert.equal(state.metadata.lastUsedModel?.model, 'text')
    assert.equal((await runtime.capabilities('aa-session', id)).capabilities.find(c => c.capabilityId === 'catalog.effort')?.allowed, true)
    assert.deepEqual(f.ctx.agentDefaultModel.currentSelection(), { provider: 'test', model: 'thinking', reasoningEffort: 'high' })

    await runtime.send(id, 'first', 'first-id', home, true, initialSelections, 'standard')
    assert.deepEqual((await runtime.configuration.state(id)).selections, next, 'retry must not reset a changed session')
    await assert.rejects(runtime.send(id, 'first', 'first-id', home, true, next, 'standard'), /different initialization/)
    await assert.rejects(runtime.updateSelections(id, { model: model('text', 'high') }, signal()), /provider, model or effort/)
    await runtime.send(id, 'second', 'second-id')
    adapter.release!()
    await until(() => adapter.requests.length === 2 && !!adapter.release)
    assert.equal(adapter.requests[1]!.model, 'thinking')
    assert.equal(adapter.requests[1]!.reasoningEffort, 'high')
    adapter.release!()
    for (let n = 0; n < 500 && agent.status !== 'idle'; n++) { adapter.release?.(); await delay(10) }
    assert.equal(agent.status, 'idle')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 2)
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('native-created sessions use the same official control state and changing permissions does not answer pending approval', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-native-config-'))
  const adapter = new TextAdapter()
  const f = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const runtime = f.ctx.agentsAnywhereRuntime.native
  const id = SessionId('native-config')
  try {
    await f.ctx.sessionController.create({ sessionId: id, cwd: home, agentPreset: 'minimal' })
    await f.ctx.sessionController.selectModel({ sessionId: id, provider: 'test', model: 'text' })
    const agent = f.ctx.agents.get(id)!
    f.ctx.permissionPresets.set(agent.session, 'workspace-write')
    await f.ctx.sessionController.prompt({ sessionId: id, requestId: 'native-first' as never, mode: 'queue', content: [{ type: 'text', text: 'hello' }] }, signal())
    await until(() => !!adapter.release)
    let answer: (() => void) | undefined
    let settled = false
    f.ctx.on('approval/request', () => new Promise(resolve => { answer = () => resolve('rejected') }))
    const approval = f.ctx.approval.request({ agent, toolName: 'fixture-tool', signal: signal() }).then(outcome => { settled = true; return outcome })
    await until(() => !!answer)
    await runtime.updateSelections(id, { model: model('thinking', 'low'), permission: permissionSelectionId('danger-full-access') }, signal())
    assert.equal(settled, false)
    answer!()
    assert.equal(await approval, 'rejected')
    await f.ctx.sessionController.selectModel({ sessionId: id, provider: 'test', model: 'thinking', reasoningEffort: 'high' })
    assert.equal((await runtime.configuration.state(id)).selections.model, model('thinking', 'high'))
    await runtime.send(id, 'followup', 'followup')
    adapter.release!()
    await until(() => adapter.requests.length === 2 && !!adapter.release)
    assert.equal(adapter.requests[1]!.reasoningEffort, 'high')
    adapter.release!()
    for (let n = 0; n < 500 && agent.status !== 'idle'; n++) { adapter.release?.(); await delay(10) }
    assert.equal(agent.status, 'idle')
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('partial initialization never sends a prompt; retry completes the same blank session and restart reads durable configuration', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-config-restart-'))
  const adapter = new TextAdapter()
  let f = await nativeRuntime(home, ctx => mountAgents(ctx, adapter))
  const id = SessionId('initialization-retry')
  try {
    let runtime = f.ctx.agentsAnywhereRuntime.native
    await assert.rejects(runtime.send(id, 'hello', 'retry', home, true, initialSelections, 'missing'), /mode is missing/)
    assert.equal(f.ctx.sessions.get(id), undefined)
    const setter = f.ctx.permissionPresets.set
    f.ctx.permissionPresets.set = () => { throw new Error('fixture permission write failure') }
    await assert.rejects(runtime.send(id, 'hello', 'retry', home, true, initialSelections, 'standard'), /fixture/)
    assert.equal(adapter.requests.length, 0)
    assert.ok(!f.ctx.sessions.get(id)!.snapshotEvents().some(event => event.type === 'turn/start'))
    f.ctx.permissionPresets.set = setter
    await runtime.send(id, 'hello', 'retry', home, true, initialSelections, 'standard')
    await until(() => !!adapter.release)
    await runtime.updateSelections(id, { model: model('thinking', 'high') }, signal())
    adapter.release!()
    await f.ctx.agents.get(id)!.whenIdle()
    await f.ctx.sessions.flush(f.ctx.sessions.get(id)!)
    await f.ctx.fiber.dispose()
    f = await nativeRuntime(home, ctx => mountAgents(ctx, new TextAdapter()), 'restarted-')
    runtime = f.ctx.agentsAnywhereRuntime.native
    assert.equal(f.ctx.agents.get(id), undefined)
    const state = await runtime.configuration.state(id)
    assert.equal(state.selections.model, model('thinking', 'high'))
    assert.equal(state.selections.permission, initialSelections.permission)
    assert.equal(state.metadata.agentPreset, 'standard')
    assert.equal(f.ctx.agents.get(id), undefined, 'reading a cold session must not start an agent')
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('catalogs omit defaults, distinguish provider routes before filtering and tolerate one unavailable provider', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-catalogs-'))
  const f = await nativeRuntime(home, ctx => mountAgents(ctx, new TextAdapter()))
  try {
    f.ctx.llm.registerAdapter(['other'], new TextAdapter())
    class Offline extends TextAdapter { override async listModels(): Promise<never> { throw new Error('fixture offline') } }
    f.ctx.llm.registerAdapter(['offline'], new Offline())
    const runtime = f.ctx.agentsAnywhereRuntime.native
    const catalog = await runtime.catalogs.models(true)
    assert.equal(catalog.models.length, 4)
    assert.equal(catalog.models.find(item => item.metadata.provider === 'test' && item.metadata.model === 'text')?.title, 'Text（test）')
    assert.equal(catalog.metadata.failures[0]?.provider, 'offline')
    assert.ok(catalog.models.every(item => !('default' in item) && item.reasoningItems.every(effort => !('default' in effort))))
    assert.ok(runtime.catalogs.permissions().permissions.every(item => !('default' in item)))
    const modes = await runtime.catalogs.agentPresets()
    assert.equal(modes.configField.default, 'standard')
    assert.ok(modes.presets.every(item => !('isDefault' in item) && !('path' in item)))
    const router = new RuntimeRouter({ native: runtime, query: f.ctx.sessionQuery, status: id => runtime.status(id) }, 'test')
    const filtered = await router.request('catalog.listModels', { query: 'other', limit: 1 }, signal()) as typeof catalog
    assert.equal(filtered.models[0]?.title, 'Text（other）')
    const caps = await router.request('session.getCapabilities', { externalSessionId: f.session.id, sessionId: sessionId('test', f.session.id) }, signal()) as Awaited<ReturnType<typeof runtime.capabilities>>
    assert.equal(caps.capabilities.find(c => c.capabilityId === 'catalog.model')?.allowed, true)
    router.close()
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
