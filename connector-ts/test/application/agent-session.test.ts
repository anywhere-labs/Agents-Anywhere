import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox, commandRoute } from '../../src/application/inbound/index.js'
import { ConversationService } from '../../src/application/index.js'
import type { ConfigChange, ConfigOption, ConfigResult, JsonObject, OpenTarget, RuntimeHandle, RuntimeHandles } from '../../src/application/ports/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

/** A Runtime session with options and Agent operations. */
class AgentSession extends FakeRuntimeSession {
  options: ConfigOption[] = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', values: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }] },
    { id: 'thinking', name: 'Thinking', category: 'other', type: 'boolean', currentValue: false },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'normal', values: [{ value: 'plan', name: 'Plan' }, { value: 'normal', name: 'Normal' }] },
  ]
  readonly planningOptionId = 'mode'
  readonly operations: { operation: string; values: JsonObject }[] = []

  get configOptions(): readonly ConfigOption[] {
    return this.options
  }

  override async configure(change: ConfigChange): Promise<ConfigResult> {
    await super.configure(change)
    this.options = this.options.map(option => (option.id === change.optionId ? { ...option, currentValue: change.value } : option))
    return { options: this.options, appliesFrom: 'now' }
  }

  async operate(operation: string, values: JsonObject): Promise<JsonObject> {
    this.operations.push({ operation, values })
    return { message: `ran ${operation}` }
  }
}

let dir: string
let store: RemoteStore
let service: ConversationService
let inbox: CommandInbox
let sessions: AgentSession[]
let opened: OpenTarget[]
let live: { method: string; payload: Record<string, unknown> }[]
let ms = 0
let counter = 0
let capabilityItems: { id: string; supported: boolean }[]

const clock = { nowIso: () => new Date(Date.UTC(2026, 10, 18, 0, 0, 0, ms)).toISOString(), nowMs: () => ms }
const ids = { newId: (prefix: string) => `${prefix}${++counter}` }

function handle(): RuntimeHandle {
  return {
    type: 'pi',
    instanceId: 'rti_pi',
    capabilities: () => ({ revision: 1, items: [] }),
    catalogs: async () => ({}),
    listNativeSessions: async () => ({ sessions: [] }),
    readNativeHistory: async () => ({ items: [] }),
    open: async (target, options) => {
      opened.push(target)
      const native = target.kind === 'existing' ? target.ref.nativeSessionId : `native_new_${sessions.length}`
      const session = new AgentSession(options.sessionId, native, { revision: 1, items: capabilityItems })
      sessions.push(session)
      return session
    },
    events: (async function* () {})(),
    stop: async () => undefined,
  }
}

const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'rti_pi' ? handle() : null) }

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

async function makeSession(takeover = true): Promise<void> {
  await store.sessions.create({ sessionId: 'sess_1', runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: 'native_1', cwd: '/w', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover, at: clock.nowIso() })
}

async function run(method: string, commandId: string, p: Record<string, unknown>) {
  return inbox.handle(commandRoute(method), { commandId, m: commandRoute(method), p } as never)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-agent-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  sessions = []
  opened = []
  live = []
  ms = 0
  counter = 0
  capabilityItems = [{ id: 'session.send_message', supported: true }, { id: 'session.authentication.read', supported: true }, { id: 'session.resources.read', supported: true }]
  service = new ConversationService({ store, feed: { publish: () => undefined, subscribe: () => () => undefined } as never, live: { emit: (method, payload) => live.push({ method, payload }) }, runtimes, clock, ids, coalesceMs: 100 })
  inbox = new CommandInbox(store, clock, service)
})

afterEach(async () => {
  await service.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the Agent configuration of a session', () => {
  it('lists the options without the plan mode switch, with the read-only operations the Agent offers', async () => {
    await makeSession()
    const view = await service.agentConfiguration('sess_1') as { configuration: { revision: number; options: { id: string }[] }; ownerGeneration: string; actions: unknown[] }
    expect(view.configuration.options.map(option => option.id)).toEqual(['model', 'thinking'])
    expect(view.configuration.revision).toBeGreaterThan(0)
    expect(view.ownerGeneration).toBe('native_1')
    expect(view.actions).toEqual([{ operation: 'authentication.status', title: '认证状态' }, { operation: 'resources.get', title: '资源状态' }])
  })

  it('never opens the Agent session of a session the platform does not drive', async () => {
    await makeSession(false)
    await expect(service.agentConfiguration('sess_1')).rejects.toMatchObject({ code: 'agent_session_not_open' })
    expect(opened).toEqual([])
  })

  it('applies options at the current revision once, and refuses a stale revision, plan mode and unknown values', async () => {
    await makeSession()
    const { configuration } = await service.agentConfiguration('sess_1') as { configuration: { revision: number } }
    const ack = await run('session.configuration.update', 'op_1', { sessionId: 'sess_1', operationId: 'op_1', expectedRevision: configuration.revision, values: { model: 'm2', thinking: true } })
    expect(ack.outcome).toBe('accepted')
    expect(ack.r).toMatchObject({ operationId: 'op_1', phase: 'completed', configuration: { options: [{ id: 'model', currentValue: 'm2' }, { id: 'thinking', currentValue: true }] } })
    expect(sessions[0]!.calls.filter(call => call.method === 'configure')).toHaveLength(2)
    expect(live.some(event => (event.payload.status as { event?: string } | undefined)?.event === 'config.updated')).toBe(true)
    // A retry of the same operation replays the receipt.
    expect((await run('session.configuration.update', 'op_1', { sessionId: 'sess_1', operationId: 'op_1', expectedRevision: configuration.revision, values: { model: 'm2', thinking: true } })).r).toEqual(ack.r)
    expect(sessions[0]!.calls.filter(call => call.method === 'configure')).toHaveLength(2)
    const stale = await run('session.configuration.update', 'op_2', { sessionId: 'sess_1', operationId: 'op_2', expectedRevision: configuration.revision, values: { model: 'm1' } })
    expect(stale).toMatchObject({ outcome: 'rejected', e: { code: 'configuration_changed' } })
    const current = (ack.r as { configuration: { revision: number } }).configuration.revision
    expect(await run('session.configuration.update', 'op_3', { sessionId: 'sess_1', operationId: 'op_3', expectedRevision: current, values: { mode: 'plan' } })).toMatchObject({ outcome: 'rejected', e: { code: 'invalid_argument' } })
    expect(await run('session.configuration.update', 'op_4', { sessionId: 'sess_1', operationId: 'op_4', expectedRevision: current, values: { model: 'nope' } })).toMatchObject({ outcome: 'rejected', e: { code: 'invalid_configuration_value' } })
  })
})

describe('Agent operations', () => {
  it('runs an operation the Agent declares, fenced by the native session', async () => {
    await makeSession()
    const ack = await run('session.agent.operate', 'op_a', { sessionId: 'sess_1', operation: 'resources.get', operationId: 'op_a', expectedGeneration: 'native_1', values: {} })
    expect(ack).toMatchObject({ outcome: 'accepted', r: { operationId: 'op_a', phase: 'completed', result: { message: 'ran resources.get' } } })
    expect(await run('session.agent.operate', 'op_b', { sessionId: 'sess_1', operation: 'resources.get', operationId: 'op_b', expectedGeneration: 'other', values: {} })).toMatchObject({ outcome: 'rejected', e: { code: 'owner_changed' } })
    expect(await run('session.agent.operate', 'op_c', { sessionId: 'sess_1', operation: 'session.fork', operationId: 'op_c', expectedGeneration: 'native_1', values: {} })).toMatchObject({ outcome: 'rejected', e: { code: 'agent_capability_unsupported' } })
    expect(await run('session.agent.operate', 'op_d', { sessionId: 'sess_1', operation: 'nothing', operationId: 'op_d', expectedGeneration: 'native_1', values: {} })).toMatchObject({ outcome: 'rejected', e: { code: 'unsupported_operation' } })
    expect(sessions[0]!.operations).toEqual([{ operation: 'resources.get', values: {} }])
  })

  it('passes the Runtime\'s refusal on with its code', async () => {
    await makeSession()
    await service.binding('sess_1')
    sessions[0]!.operate = async () => {
      throw Object.assign(new Error('no'), { error: { code: 'pi_authentication_required', message: 'log in first' } })
    }
    expect(await run('session.agent.operate', 'op_x', { sessionId: 'sess_1', operation: 'authentication.status', operationId: 'op_x', expectedGeneration: 'native_1', values: {} }))
      .toMatchObject({ outcome: 'rejected', e: { code: 'pi_authentication_required', message: 'log in first' } })
  })

  it('reads the session tree only when the Agent declares the execution position', async () => {
    await makeSession()
    await expect(service.agentTree('sess_1', { limit: 500 })).rejects.toMatchObject({ code: 'agent_capability_unsupported' })
    capabilityItems.push({ id: 'session.execution_position.read', supported: true }, { id: 'session.execution_position.select', supported: true })
    await service.close()
    service = new ConversationService({ store, feed: { publish: () => undefined, subscribe: () => () => undefined } as never, live: { emit: () => undefined }, runtimes, clock, ids })
    inbox = new CommandInbox(store, clock, service)
    expect(await service.agentTree('sess_1', { limit: 500 })).toEqual({ message: 'ran session.tree' })
    const ack = await run('session.position.select', 'c_pos', { sessionId: 'sess_1', fileEntriesDigest: 'd', sourceEpoch: 'e', positionRevision: 1, leafId: 'leaf' })
    expect(ack).toMatchObject({ outcome: 'accepted', r: { operationId: 'c_pos', phase: 'completed' } })
    expect(sessions.at(-1)!.operations.at(-1)).toEqual({ operation: 'session.position.select', values: { fileEntriesDigest: 'd', sourceEpoch: 'e', positionRevision: 1, leafId: 'leaf' } })
  })
})

describe('releasing and reopening the Agent session', () => {
  it('closes the Agent session between turns; the next message opens it again', async () => {
    await makeSession()
    await service.binding('sess_1')
    expect(await service.lifecycleCapabilities('sess_1')).toMatchObject([{ id: 'session.close', available: true }, { id: 'session.recover', supported: true, available: false }])
    expect(await run('session.close', 'c_close_x', { sessionId: 'sess_1', ownerGeneration: 'other' })).toMatchObject({ outcome: 'rejected', e: { code: 'owner_changed' } })
    expect(await run('session.close', 'c_close', { sessionId: 'sess_1', ownerGeneration: 'native_1' })).toEqual({ outcome: 'accepted', r: { closed: true } })
    expect(sessions[0]!.calls.at(-1)).toEqual({ method: 'close' })
    expect(service.isBound('sess_1')).toBe(false)
    // Released on purpose: nothing to recover, and the session stays idle.
    expect(await service.lifecycleCapabilities('sess_1')).toMatchObject([{ id: 'session.close', available: false }, { id: 'session.recover', available: false }])
    expect((await store.sessions.get('sess_1'))?.status).toBe('idle')
    await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'again' }, { commandId: null, inputDigest: null, actor: 'usr_1' })
    await settle()
    expect(opened).toHaveLength(2)
  })

  it('refuses to close during a turn', async () => {
    await makeSession()
    await service.binding('sess_1')
    sessions[0]!.emit({ type: 'turn.started', turnId: 't1', origin: 'user' })
    await settle()
    expect(await run('session.close', 'c_close', { sessionId: 'sess_1', ownerGeneration: 'native_1' })).toMatchObject({ outcome: 'rejected', e: { code: 'session_busy' } })
  })

  it('offers recovery after the Runtime lost the session and reopens it at once', async () => {
    await makeSession()
    await service.binding('sess_1')
    sessions[0]!.emit({ type: 'session.lost', error: { code: 'adapter_exited', message: 'gone' } })
    await settle(40)
    expect(service.isBound('sess_1')).toBe(false)
    expect(await service.lifecycleCapabilities('sess_1')).toMatchObject([{ id: 'session.close', available: false }, { id: 'session.recover', supported: true, available: true }])
    const ack = await run('session.recover', 'op_r', { sessionId: 'sess_1', operationId: 'op_r', expectedGeneration: 'native_1' })
    expect(ack).toMatchObject({ outcome: 'accepted', r: { operationId: 'op_r', phase: 'completed', state: { sessionId: 'sess_1', metadata: { ownerGeneration: 'native_1' } } } })
    expect(opened).toEqual([{ kind: 'existing', ref: { nativeSessionId: 'native_1', cwd: '/w' } }, { kind: 'existing', ref: { nativeSessionId: 'native_1', cwd: '/w' } }])
    expect(service.isBound('sess_1')).toBe(true)
    expect(await service.lifecycleCapabilities('sess_1')).toMatchObject([{ id: 'session.close', available: true }, { id: 'session.recover', available: false }])
    // The same operation again replays its receipt; nothing opens twice.
    expect((await run('session.recover', 'op_r', { sessionId: 'sess_1', operationId: 'op_r', expectedGeneration: 'native_1' })).r).toEqual(ack.r)
    expect(opened).toHaveLength(2)
  })
})
