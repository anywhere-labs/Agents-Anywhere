import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { commandRuntime } from '../fixtures/command-runtime.js'
import { SyncFeed, type SyncOperation, type SyncTransport } from '../../src/host/dsh-runtime/sync.js'
import { BridgeError } from '../../src/host/dsh-runtime/errors.js'
import { nativeRuntime } from '../fixtures/native-runtime.js'
import { mountAgents } from '../fixtures/agent-runtime.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const signal = () => new AbortController().signal
type Descriptor = { id: string, description: string, acceptsArgs: boolean, enabled: boolean, metadata: Record<string, any> }
type Result = { ok: boolean, code?: string, message?: string, result: Record<string, any> }
async function fixture(run: (f: Awaited<ReturnType<typeof commandRuntime>>) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'aa-native-commands-'))
  const f = await commandRuntime(home)
  try { await run(f) } finally { await f.close(); await rm(home, { recursive: true, force: true }) }
}

test('AA exposes and executes only compact even when UI-dependent commands are registered', async () => fixture(async f => {
  const { agent, params } = await f.create('compact-only')
  const calls: string[] = []
  for (const name of ['about', 'compact', 'export', 'goal', 'plan', 'model', 'file', 'feedback']) {
    f.ctx.commands.register({ name, description: name, handler: () => { calls.push(name); return { kind: 'success' } } })
  }
  const list = async (values = {}) => (await f.router.request('listCommands', { ...params, ...values }, signal()) as { commands: Descriptor[] }).commands
  assert.deepEqual((await list()).map(c => c.id), ['compact'])
  assert.deepEqual((await list({ limit: 1 })).map(c => c.id), ['compact'])
  assert.deepEqual(await list({ query: 'export' }), [])
  for (const command of ['about', 'export', 'goal', 'plan', 'model', 'file', 'feedback', 'permission', 'compact-thread']) {
    const result = await f.router.request('executeCommand', { ...params, command, raw: `/${command}` }, signal()) as Result
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unknown_command')
  }
  assert.deepEqual(calls, [])
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'command/run').length, 0)
  const result = await f.router.request('executeCommand', { ...params, command: 'compact', raw: '/compact' }, signal()) as Result
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['compact'])
}))

test('AA does not invent compact when the native Agent has no compact command', async () => fixture(async f => {
  const { params } = await f.create('without-compact')
  const result = await f.router.request('listCommands', params, signal()) as { commands: Descriptor[] }
  assert.deepEqual(result.commands, [])
  const execution = await f.router.request('executeCommand', { ...params, command: 'compact', raw: '/compact' }, signal()) as Result
  assert.equal(execution.ok, false)
  assert.equal(execution.code, 'unknown_command')
}))

test('command catalog uses actual scoped registry metadata and filters before applying limit', async () => fixture(async f => {
  const first = await f.create('first'), second = await f.create('second')
  f.ctx.commands.register({ name: 'compact', definitionId: CommandDefinitionId('plugin.compact'), description: 'global compact', input: { hint: 'exact text', attachments: true }, handler: () => ({ kind: 'success' }) })
  // An injected plugin under the exact authoritative Agent shadows only its own catalog.
  const scoped = first.agent.ctx.plugin({ inject: ['commands'], apply: (ctx: typeof f.ctx) => {
    ctx.commands.register({ name: 'compact', description: 'scoped compact', input: { hint: 'scoped text' }, handler: () => ({ kind: 'success' }) })
  } })
  await scoped.await()
  const list = async (params: Record<string, unknown>) => (await f.router.request('listCommands', params, signal()) as { commands: Descriptor[] }).commands
  const own = await list({ ...first.params, query: 'scoped', limit: 1 })
  assert.equal(own.length, 1)
  assert.equal(own[0]!.id, 'compact')
  assert.equal(own[0]!.description, 'scoped compact')
  assert.equal(own[0]!.acceptsArgs, true)
  assert.equal(own[0]!.metadata.ui.kind, 'execute')
  assert.equal(own[0]!.metadata.ui.acceptsMultiline, true)
  assert.ok(own[0]!.metadata.ui.allowedStatuses.includes('running'))
  assert.ok(own[0]!.metadata.ui.allowedStatuses.includes('error'))
  const other = await list({ ...second.params, query: 'global' })
  assert.equal(other[0]!.metadata.definitionId, 'plugin.compact')
  assert.deepEqual(other[0]!.metadata.input, { hint: 'exact text', attachments: true })
  assert.equal(other[0]!.metadata.attachmentsAvailable, false)
  await scoped.dispose()
  assert.equal((await list({ ...first.params, query: 'global' }))[0]!.description, 'global compact')
  await assert.rejects(list({ ...first.params, limit: 0 }), (e: unknown) => e instanceof BridgeError && e.code === 'INVALID_PARAMS')
}))

test('native execution preserves exact raw line, correlations and known errors without opening a turn', async () => fixture(async f => {
  const { agent, params } = await f.create('execute')
  const initialTurns = agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length
  f.ctx.commands.register({ name: 'compact', description: 'compact', input: { hint: 'text' }, handler: invocation => {
    if (invocation.rawInput.trim() === 'invalid') return { kind: 'error', text: 'invalid compact input' }
    const event = invocation.agent.session.append('session/title', { title: invocation.rawInput, source: { kind: 'user' }, messageSeqs: [] })
    return { kind: 'success', text: invocation.rawInput, sourceEventSeq: event.seq }
  } })
  const raw = '/compact  first\n second  '
  const result = await f.router.request('executeCommand', { ...params, command: 'compact', raw, args: ['ignored'] }, signal()) as Result
  assert.equal(result.ok, true)
  assert.equal(result.message, '  first\n second  ')
  assert.equal(result.result.executionState, 'accepted')
  const events = agent.session.snapshotEvents()
  const run = events.findLast(e => e.type === 'command/run')!
  const done = events.findLast(e => e.type === 'command/done')!
  assert.equal((run.data as any).args, '  first\n second  ')
  assert.equal((run.data as any).commandId, result.result.commandId)
  assert.equal((done.data as any).commandId, result.result.commandId)
  assert.equal(result.result.sourceEventSeq, Number(events.findLast(e => e.type === 'session/title')!.seq))
  const denied = await f.router.request('executeCommand', { ...params, command: 'compact', raw: '/compact invalid' }, signal()) as Result
  assert.equal(denied.ok, false)
  assert.equal(denied.result.kind, 'error')
  assert.equal(denied.result.executionState, 'completed')
  assert.ok(denied.result.commandId)
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/start').length, initialTurns)
}))

test('admission rejects mismatched IDs, malformed raw, ambiguous args and attachments without command logs', async () => fixture(async f => {
  const { agent, params } = await f.create('admission')
  for (const request of [
    { command: 'compact', raw: '/other text' }, { command: 'compact', raw: '' },
    { command: 'compact', raw: ' /compact' }, { command: 'compact', raw: '/compact?' },
    { command: 'compact', args: ['one', 'two'] }, { command: 'compact', args: [{}] },
    { command: 'compact', args: null }, { command: 'compact', raw: 12 },
    { command: 'compact', raw: '/compact', attachments: [{ type: 'file', receiptId: 'unused' }] },
  ]) {
    const result = await f.router.request('executeCommand', { ...params, ...request }, signal()) as Result
    assert.equal(result.ok, false)
    assert.equal(result.result.commandId, undefined)
  }
  const unknown = await f.router.request('executeCommand', { ...params, command: 'unknown', raw: '/unknown' }, signal()) as Result
  assert.equal(unknown.code, 'unknown_command')
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'command/run').length, 0)
  await assert.rejects(f.router.request('executeCommand', { ...params, sessionId: 'another-runtime', command: 'compact' }, signal()), (e: unknown) => e instanceof BridgeError && e.code === 'INVALID_PARAMS')
  f.native.source.archived.add(agent.id)
  await assert.rejects(f.router.request('executeCommand', { ...params, command: 'compact' }, signal()), (e: unknown) => e instanceof BridgeError && e.code === 'SESSION_ARCHIVED')
  const caps = await f.router.request('getSessionCapabilities', params, signal()) as { capabilities: { capabilityId: string, available: boolean }[] }
  assert.equal(caps.capabilities.find(c => c.capabilityId === 'session.commands')!.available, false)
  await assert.rejects(f.router.request('listCommands', { externalSessionId: 'missing', query: '' }, signal()), (e: unknown) => e instanceof BridgeError && e.code === 'SESSION_NOT_FOUND')
}))

test('capability cannot advertise native commands after the actual registry unloads', async () => fixture(async f => {
  const { params } = await f.create('service-unload')
  await f.ctx.commands.ctx.fiber.dispose()
  const caps = await f.router.request('getSessionCapabilities', params, signal()) as { capabilities: { capabilityId: string, supported: boolean, available: boolean, allowed: boolean }[] }
  const row = caps.capabilities.find(c => c.capabilityId === 'session.commands')!
  assert.equal(row.supported, false)
  assert.equal(row.available, false)
  assert.equal(row.allowed, false)
}))

test('raw-absent single free-form arg retains whitespace and native thrown/aborted handlers have unknown outcomes', async () => fixture(async f => {
  const { agent, params } = await f.create('outcomes')
  const disposeEcho = f.ctx.commands.register({ name: 'compact', description: 'echo', input: { hint: 'text' }, handler: inv => ({ kind: 'success', text: inv.rawInput }) })
  const echoed = await f.router.request('executeCommand', { ...params, command: 'compact', args: [' first\nlast '] }, signal()) as Result
  assert.equal(echoed.message, '  first\nlast ')
  disposeEcho()
  const disposeFail = f.ctx.commands.register({ name: 'compact', description: 'fail', handler: () => { throw new Error('private native detail') } })
  const failed = await f.router.request('executeCommand', { ...params, command: 'compact' }, signal()) as Result
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'command_failed')
  assert.deepEqual(failed.result, { executionState: 'unknown', retryable: false })
  assert.ok(!failed.message?.includes('private native detail'))
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  disposeFail()
  f.ctx.commands.register({ name: 'compact', description: 'wait', handler: () => { enter(); return new Promise(() => {}) } })
  const abort = new AbortController()
  const pending = f.router.request('executeCommand', { ...params, command: 'compact' }, abort.signal) as Promise<Result>
  await entered
  abort.abort()
  const cancelled = await pending
  assert.equal(cancelled.code, 'command_outcome_unknown')
  assert.deepEqual(cancelled.result, { executionState: 'unknown', retryable: false })
  assert.equal((agent.session.snapshotEvents().findLast(e => e.type === 'command/done')!.data as any).kind, 'error')
  const count = agent.session.snapshotEvents().filter(e => e.type === 'command/run').length
  await assert.rejects(f.router.request('executeCommand', { ...params, command: 'compact' }, AbortSignal.abort()))
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'command/run').length, count)
}))

test('registry change refreshes existing capability signals with a restart-safe catalog revision', async () => fixture(async f => {
  const { params } = await f.create('invalidation')
  const get = async () => await f.router.request('getSessionCapabilities', params, signal()) as { capabilities: { capabilityId: string, supported: boolean, available: boolean, allowed: boolean, metadata?: { catalogRevision?: string } }[] }
  const initial = (await get()).capabilities.find(c => c.capabilityId === 'session.commands')!
  assert.equal(initial.supported, true)
  assert.equal(initial.available, true)
  assert.equal(initial.allowed, true)
  assert.equal(typeof initial.metadata?.catalogRevision, 'string')
  const { RuntimeCommands } = await import('../../src/host/dsh-runtime/commands.js')
  const restarted = new RuntimeCommands(f.ctx, f.native.configuration, f.native.source, () => {})
  try { assert.notEqual((await restarted.capability()).catalogRevision, initial.metadata?.catalogRevision) }
  finally { restarted.close() }
  const batches: { batchSeq: number, operations: SyncOperation[] }[] = [], errors: unknown[] = []
  const transport: SyncTransport = {
    async ingestBatch(batch) { batches.push(batch as unknown as { batchSeq: number, operations: SyncOperation[] }) },
    async loadCheckpoint() { return null },
    async saveCheckpoint() {},
    async deleteCheckpoint() {},
    async ingestSnapshot(_request, pages) { for await (const _page of pages) { /* drain */ } return { accepted: true } },
  }
  const feed = new SyncFeed(f.native, 'test', 'commands', transport, error => errors.push(error))
  const notes = () => batches.flatMap(b => b.operations).flatMap(op => op.kind === 'notifications' ? op.notifications as { method: string, params: any }[] : [])
  async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await delay(10); assert.ok(check()) }
  try {
    feed.start()
    await until(() => notes().some(n => n.method === 'session.inventory.complete'))
    const dispose = f.ctx.commands.register({ name: 'compact', description: 'compact', handler: () => ({ kind: 'success' }) })
    await until(() => notes().some(n => n.method === 'session.capability.updated' && n.params.sessionId === params.sessionId && n.params.capabilities.some((c: any) => c.capabilityId === 'session.commands' && c.metadata?.catalogRevision !== initial.metadata?.catalogRevision)))
    assert.ok(notes().some(n => n.method === 'runtime.capability.updated'))
    const changed = (await get()).capabilities.find(c => c.capabilityId === 'session.commands')!.metadata!.catalogRevision
    dispose()
    assert.notEqual((await get()).capabilities.find(c => c.capabilityId === 'session.commands')!.metadata!.catalogRevision, changed)
    assert.deepEqual(errors, [])
  } finally { feed.close() }
}))

test('compiled native Host and actual Python public adapters execute commands over authenticated transport', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aa-commands-wire-'))
  const f = await nativeRuntime(home, ctx => mountAgents(ctx))
  try {
    const id = SessionId('commands-wire')
    await f.ctx.sessionController.create({ sessionId: id, cwd: home, agentPreset: 'minimal' })
    const agent = f.ctx.agents.get(id)!
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'seed' }] }), { surfaceOp: 'append' })
    // Test-owned compact handler exercises transport outcomes without a model call.
    f.ctx.commands.register({ name: 'compact', description: 'compact', input: { hint: 'text' }, handler: inv => {
      if (inv.rawInput.trim() === 'wait') return new Promise(() => {})
      if (inv.rawInput.trim() === 'invalid') return { kind: 'error', text: 'invalid compact input' }
      const event = inv.agent.session.append('session/title', { title: 'echo', source: { kind: 'user' }, messageSeqs: [] })
      return { kind: 'success', text: inv.rawInput, sourceEventSeq: event.seq }
    } })
    const { stdout } = await promisify(execFile)('uv', ['run', '--frozen', 'python', 'tests/dsh_commands_probe.py', home], {
      cwd: new URL('../../../connector/', import.meta.url), timeout: 20_000,
    })
    assert.match(stdout, /DSH compiled native command integration passed/)
    assert.equal(f.ctx.permissionPresets.current(agent.session), 'workspace-write')
    const events = agent.session.snapshotEvents()
    assert.equal(events.filter(e => e.type === 'command/run' && e.data.name === 'compact' && e.data.args?.trim() === 'wait').length, 1)
    assert.equal(events.filter(e => e.type === 'turn/start').length, 0)
    assert.equal(events.filter(e => e.type === 'user/message').length, 1)
  } finally { await f.ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
