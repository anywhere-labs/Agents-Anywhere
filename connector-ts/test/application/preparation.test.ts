import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService, PreparationService } from '../../src/application/index.js'
import type { RuntimeHandles } from '../../src/application/ports/index.js'
import { PREPARATION_TTL_MS, type Preparation } from '../../src/domain/creation/index.js'
import { acpFingerprint } from '../../src/domain/identity/index.js'
import type { CommandAck } from '../../src/generated/device-meshcall/v1_0/command-ack.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { JsonRpcError } from '../../src/runtime/acp/jsonrpc.js'
import { genericDialect } from '../../src/runtime/profiles/generic/dialect.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed } from '../../src/sync/index.js'
import { FakeAcpAgent, type Json } from '../support/fake-acp-agent.js'

let dir: string
let store: RemoteStore
let agent: FakeAcpAgent
let handle: AcpRuntimeHandle
let service: ConversationService
let preparations: PreparationService
let inbox: CommandInbox
let readers: DeviceReaders
let ms = 0
let counter = 0

const clock = { nowIso: () => new Date(Date.UTC(2026, 10, 17) + ms).toISOString(), nowMs: () => ms }
const ids = { newId: (prefix: string) => `${prefix}${++counter}` }
const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'rti_fake' ? handle : null) }
const RUNTIME = { runtime: 'opencode', runtimeId: 'rti_fake' }

function useHandle(dialect: AcpDialect = genericDialect('opencode'), connect = peerConnection(agent.clientPeer, dialect)): void {
  handle = new AcpRuntimeHandle({ type: 'opencode', instanceId: 'rti_fake', dialect, connect, workspacePreparation: true })
}

function compose(): void {
  service = new ConversationService({ store, feed: new MemoryChangeFeed(), live: { emit: () => undefined }, runtimes, clock, ids, coalesceMs: 5 })
  preparations = new PreparationService({ store, runtimes, clock, ids, conversation: service, directoryExists: async cwd => cwd.startsWith('/') })
  inbox = new CommandInbox(store, clock, service, {}, preparations)
  readers = new DeviceReaders(store, clock.nowIso, undefined, null, preparations)
}

async function command(route: string, commandId: string, p: Json): Promise<CommandAck> {
  return inbox.handle(route, { commandId, deadline: '2026-11-17T01:00:00.000Z', p })
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const view = (preparationId = 'prep_1') => readers.workspacePreparation({ preparationId })
const ready = (preparationId = 'prep_1') => until(() => view(preparationId), v => v.phase !== 'opening', `${preparationId} to open`)
const calls = (method: string) => agent.received.filter(call => call.method === method)

async function prepare(preparationId = 'prep_1', cwd = '/work/repo'): Promise<Record<string, unknown>> {
  const ack = await command('workspacePrepare', `c_${preparationId}_${++counter}`, { ...RUNTIME, preparationId, clientPreparationId: `client_${preparationId}`, cwd, projectId: 'prj_1' })
  expect(ack.outcome).toBe('accepted')
  return ready(preparationId)
}

/** The model selection of `model` with `effort`, as the prepared catalog names it. */
function selectionOf(prepared: Record<string, unknown>, model: string, effort: string): string {
  const models = (prepared.catalog as { models: { id: string; reasoningItems: { id: string; selectionId: string }[] }[] }).models
  return models.find(item => item.id === model)!.reasoningItems.find(item => item.id === effort)!.selectionId
}

function reservation(prepared: Record<string, unknown>, overrides: Json = {}): Json {
  return {
    ...RUNTIME,
    preparationId: prepared.preparationId,
    createOperationId: 'op_1',
    platformSessionId: 'sess_1',
    expectedRevision: prepared.revision,
    catalogRevision: prepared.catalogRevision,
    selections: { model: selectionOf(prepared, 'm2', 'high'), permission: null },
    configuration: { mode: 'default' },
    ...overrides,
  }
}

function creation(prepared: Record<string, unknown>, overrides: Json = {}): Json {
  const { expectedRevision: _e, catalogRevision: _c, platformSessionId: _p, ...rest } = reservation(prepared)
  return { ...rest, sessionId: 'sess_1', clientMessageId: 'm1', content: 'hello prepared', ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-prep-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  agent = new FakeAcpAgent()
  agent.onPrompt = async params => {
    agent.text(String(params.sessionId), `echo from ${String(params.sessionId)}`)
    return { stopReason: 'end_turn' }
  }
  ms = 0
  counter = 0
  useHandle()
  compose()
})

afterEach(async () => {
  await preparations.close()
  await service.close()
  await handle.stop()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace preparation', () => {
  it('opens the Agent session ahead of time and the creation consumes that same session', async () => {
    const prepared = await prepare()
    expect(prepared).toMatchObject({ phase: 'ready', revision: 1, catalogRevision: 1, canRespond: true, canCancel: true, cwd: '/work/repo', interactions: [] })
    expect((prepared.catalog as { models: { id: string }[] }).models.map(model => model.id)).toEqual(['m1', 'm2'])
    expect((prepared.configuration as { options: { id: string }[] }).options.map(option => option.id)).toEqual(['mode', 'model', 'effort'])
    expect(calls('session/new')).toHaveLength(1)
    expect(calls('session/new')[0]!.params.cwd).toBe('/work/repo')

    // Preparing again is idempotent; another directory under the same id is a conflict.
    expect((await command('workspacePrepare', 'c_again', { ...RUNTIME, preparationId: 'prep_1', clientPreparationId: 'client_prep_1', cwd: '/work/repo' })).r).toMatchObject({ phase: 'ready' })
    expect((await command('workspacePrepare', 'c_other', { ...RUNTIME, preparationId: 'prep_1', clientPreparationId: 'client_prep_1', cwd: '/elsewhere' })).e?.code).toBe('operation_input_conflict')

    expect((await command('workspacePreparationReserve', 'c_reserve', reservation(prepared))).r).toEqual({ reserved: true })
    // Retried with the same reservation (a lost answer): reserved again, nothing changes.
    expect((await command('workspacePreparationReserve', 'c_reserve_again', reservation(prepared))).r).toEqual({ reserved: true })
    expect((await view()).phase).toBe('reserved')

    const begun = await command('sessionCreationBegin', 'wf_begin', creation(prepared))
    expect(begun.outcome).toBe('accepted')
    expect(begun.r).toMatchObject({ createOperationId: 'op_1', platformSessionId: 'sess_1', platformSessionCreated: true, created: true })
    const created = await until(() => readers.creation({ createOperationId: 'op_1' }), v => v.messageAccepted === true, 'the first message')
    expect(created).toMatchObject({ phase: 'accepted', messageAccepted: true, failure: null })

    // One Agent session: the prompt went to the prepared one, under the AA session's identity.
    expect(calls('session/new')).toHaveLength(1)
    expect(calls('session/prompt').map(call => call.params.sessionId)).toEqual(['native-1'])
    expect((await store.sessions.get('sess_1'))).toMatchObject({ externalSessionId: 'native-1', cwd: '/work/repo', projectId: 'prj_1', runtimeType: 'opencode' })
    expect((await store.timeline.findByClientMessageId('sess_1', 'm1'))?.id).toBe(acpFingerprint(['sess_1', 'user_message_chunk', 'm1']))
    // The frozen selection reached the session before the first message.
    expect(calls('session/set_config_option').map(call => [call.params.configId, call.params.value])).toEqual([['model', 'm2'], ['effort', 'high']])
    expect((await view()).phase).toBe('consumed')
    expect(preparations.held).toBe(0)

    // A replay (a retried command) answers the same creation and sends nothing again.
    expect((await command('sessionCreationBegin', 'wf_begin_again', creation(prepared))).r).toMatchObject({ createOperationId: 'op_1', messageAccepted: true })
    expect((await command('sessionCreationBegin', 'wf_begin_other', creation(prepared, { content: 'something else' }))).e?.code).toBe('operation_input_conflict')
    expect(calls('session/prompt')).toHaveLength(1)
  })

  it('refuses stale, mismatched and unmappable reservations with a definite reason', async () => {
    const prepared = await prepare()
    const refused = async (overrides: Json) => (await command('workspacePreparationReserve', `c_${++counter}`, reservation(prepared, overrides))).r
    expect(await refused({ catalogRevision: 0 })).toMatchObject({ reserved: false, failure: { code: 'preparation_stale' } })
    expect(await refused({ expectedRevision: 0 })).toMatchObject({ reserved: false, failure: { code: 'preparation_stale' } })
    expect(await refused({ selections: { model: 'no-such-model' } })).toMatchObject({ reserved: false, failure: { code: 'invalid_configuration_value' } })
    expect(await refused({ configuration: { mode: 'nonsense' } })).toMatchObject({ reserved: false, failure: { code: 'invalid_configuration_value' } })
    expect(await refused({ configuration: { gone: true } })).toMatchObject({ reserved: false, failure: { code: 'configuration_changed' } })
    expect(await refused({ planningIntent: { mode: 'plan', operationId: 'pl_1' } })).toMatchObject({ reserved: false, failure: { code: 'planning_unavailable' } })
    expect(await refused({ preparationId: 'prep_missing' })).toMatchObject({ reserved: false, failure: { code: 'preparation_not_found' } })
    expect(await refused({})).toEqual({ reserved: true })
    expect(await refused({ createOperationId: 'op_2' })).toMatchObject({ reserved: false, failure: { code: 'operation_input_conflict' } })
    // A creation the preparation was not reserved for is refused.
    expect((await command('sessionCreationBegin', 'wf_x', creation(prepared, { createOperationId: 'op_2' }))).e?.code).toBe('preparation_not_reserved')
    // The Agent reporting other options moves the catalog revision.
    const other = await prepare('prep_2', '/work/other')
    agent.update('native-2', { sessionUpdate: 'config_option_update', configOptions: [...agent.configOptions, { id: 'extra', name: 'Extra', category: 'other', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }] })
    const moved = await until(() => view('prep_2'), v => v.catalogRevision === 2, 'the catalog revision to move')
    expect(moved.revision).toBe(other.revision)
    expect((await command('workspacePreparationReserve', 'c_moved', reservation(other, { createOperationId: 'op_3', platformSessionId: 'sess_3' }))).r).toMatchObject({ reserved: false, failure: { code: 'preparation_stale' } })
  })

  it('expires an unreserved preparation and closes its Agent session', async () => {
    const prepared = await prepare()
    ms = PREPARATION_TTL_MS - 1
    await preparations.expireDue()
    expect((await view()).phase).toBe('ready')
    ms = PREPARATION_TTL_MS
    await preparations.expireDue()
    expect(await view()).toMatchObject({ phase: 'expired', revision: 2, canCancel: false, canRespond: false })
    expect(calls('session/close').map(call => call.params.sessionId)).toEqual(['native-1'])
    expect(preparations.held).toBe(0)
    expect((await command('workspacePreparationReserve', 'c_late', reservation(prepared))).r).toMatchObject({ reserved: false, failure: { code: 'preparation_stale' } })
  })

  it('cancels and closes a preparation; a reserved one can only be cancelled through its creation', async () => {
    const prepared = await prepare()
    expect((await command('workspacePreparationCancel', 'c_cancel', { ...RUNTIME, preparationId: 'prep_1' })).r).toMatchObject({ phase: 'cancelled', canCancel: false })
    expect(calls('session/close')).toHaveLength(1)
    expect((await command('workspacePreparationReserve', 'c_after', reservation(prepared))).r).toMatchObject({ reserved: false, failure: { code: 'preparation_stale' } })
    const second = await prepare('prep_2', '/work/two')
    await command('workspacePreparationReserve', 'c_r2', reservation(second, { createOperationId: 'op_2', platformSessionId: 'sess_2' }))
    expect((await command('workspacePreparationCancel', 'c_cancel2', { ...RUNTIME, preparationId: 'prep_2' })).e?.code).toBe('preparation_consumed')
  })

  it('fails definitely when the Agent never started, and with an unknown outcome after it did', async () => {
    useHandle(genericDialect('opencode'), async () => {
      throw new Error('spawn opencode ENOENT')
    })
    await command('workspacePrepare', 'c1', { ...RUNTIME, preparationId: 'prep_down', clientPreparationId: 'x', cwd: '/w' })
    expect(await ready('prep_down')).toMatchObject({ phase: 'failed', failure: { code: 'agent_open_failed' } })

    useHandle()
    agent.peer.onRequest('session/new', () => {
      throw new JsonRpcError(-32603, 'internal error while creating the session')
    })
    await command('workspacePrepare', 'c2', { ...RUNTIME, preparationId: 'prep_unknown', clientPreparationId: 'y', cwd: '/w' })
    expect(await ready('prep_unknown')).toMatchObject({ phase: 'outcome_unknown' })

    agent.peer.onRequest('session/new', () => {
      throw new JsonRpcError(-32000, 'authentication required')
    })
    await command('workspacePrepare', 'c3', { ...RUNTIME, preparationId: 'prep_auth', clientPreparationId: 'z', cwd: '/w' })
    expect(await ready('prep_auth')).toMatchObject({ phase: 'failed', failure: { code: 'runtime_auth_required' } })

    expect((await command('workspacePrepare', 'c4', { ...RUNTIME, preparationId: 'prep_rel', clientPreparationId: 'r', cwd: 'relative/dir' })).e?.code).toBe('invalid_cwd')
    expect((await command('workspacePrepare', 'c5', { runtime: 'x', runtimeId: 'rti_none', preparationId: 'prep_none', cwd: '/w' })).e?.code).toBe('runtime_unavailable')
  })

  it('answers a request the Agent makes during the preparation', async () => {
    await prepare()
    const answer = agent.ask('elicitation/create', { sessionId: 'native-1', mode: 'form', message: 'Sign in', requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } })
    const asked = await until(() => view(), v => (v.interactions as unknown[]).length === 1, 'the request in the view')
    const [interaction] = asked.interactions as Json[]
    expect(interaction).toMatchObject({ kind: 'form', status: 'open', requestRevision: 1, metadata: { formSchema: { type: 'object' } } })
    const respond = (overrides: Json) => command('workspacePreparationRespond', `c_${++counter}`, {
      ...RUNTIME, preparationId: 'prep_1', interactionId: interaction!.interactionId, requestRevision: 1,
      ownerGeneration: interaction!.ownerGeneration, responseOperationId: 'resp_1', actionId: 'accept', input: { kind: 'form', values: { token: 'secret' } }, ...overrides,
    })
    expect((await respond({ ownerGeneration: 'gen_other' })).e?.code).toBe('owner_changed')
    expect((await respond({})).r).toEqual({ disposition: 'applied', responseOperationId: 'resp_1' })
    expect(await answer).toEqual({ action: 'accept', content: { token: 'secret' } })
    expect((await respond({})).r).toEqual({ disposition: 'already_applied', responseOperationId: 'resp_1' })
    expect(((await view()).interactions as Json[])[0]).toMatchObject({ status: 'answered' })
  })

  it('enters plan mode before the first message of a planned creation and keeps the plan switch out of the options', async () => {
    const dialect: AcpDialect = { ...genericDialect('opencode'), planMode: () => ({ optionId: 'mode', planValue: 'plan' }) }
    useHandle(dialect)
    compose()
    const prepared = await prepare()
    expect((prepared.configuration as { options: { id: string }[] }).options.map(option => option.id)).toEqual(['model', 'effort'])
    const planned = { configuration: {}, planningIntent: { mode: 'plan', operationId: 'pl_1' } }
    expect((await command('workspacePreparationReserve', 'c_plan_cfg', reservation(prepared, { configuration: { mode: 'plan' } }))).r).toMatchObject({ reserved: false, failure: { code: 'planning_unavailable' } })
    expect((await command('workspacePreparationReserve', 'c_plan', reservation(prepared, planned))).r).toEqual({ reserved: true })
    await command('sessionCreationBegin', 'wf_plan', creation(prepared, planned))
    await until(() => readers.creation({ createOperationId: 'op_1' }), v => v.messageAccepted === true, 'the planned first message')
    const modeChange = agent.received.findIndex(call => call.method === 'session/set_config_option' && call.params.configId === 'mode' && call.params.value === 'plan')
    expect(modeChange).toBeGreaterThan(-1)
    expect(modeChange).toBeLessThan(agent.received.findIndex(call => call.method === 'session/prompt'))
    expect((await store.planning.load('sess_1'))?.effectiveMode).toBe('plan')
  })

  it('after a restart expires what it held, rejects creations that never started and leaves no Agent session open', async () => {
    const first = await prepare('prep_held', '/work/a')
    const second = await prepare('prep_reserved', '/work/b')
    await command('workspacePreparationReserve', 'c_r', reservation(second, { createOperationId: 'op_r', platformSessionId: 'sess_r' }))
    // A creation consumed its preparation but the process stopped before the session took the first message.
    const consumed: Preparation = {
      ...((await store.preparations.get('prep_held'))!),
      preparationId: 'prep_consumed', phase: 'consumed',
      reservation: { createOperationId: 'op_c', platformSessionId: 'sess_c', selections: {}, configuration: {}, planningIntent: null },
      creation: { createOperationId: 'op_c', sessionId: 'sess_c', clientMessageId: 'm_c', inputDigest: 'd', settled: null, recoveredBeforeSubmission: false },
    }
    await store.preparations.save(consumed)
    expect(first.phase).toBe('ready')

    // The process stops: every held Agent session is closed, nothing is left running.
    await preparations.close()
    expect(preparations.held).toBe(0)
    expect(calls('session/close').map(call => call.params.sessionId).sort()).toEqual(['native-1', 'native-2'])

    compose()
    await preparations.recover()
    expect(await view('prep_held')).toMatchObject({ phase: 'expired', canRespond: false })
    expect(await view('prep_reserved')).toMatchObject({ phase: 'expired' })
    expect(await readers.creation({ createOperationId: 'op_r' })).toMatchObject({ phase: 'rejected', messageAccepted: false, platformSessionCreated: null, failure: { code: 'initialization_interrupted' } })
    expect(await readers.creation({ createOperationId: 'op_c' })).toMatchObject({ phase: 'rejected', messageAccepted: false, failure: { code: 'initialization_interrupted' } })
    // The recovered creation answers its replay definitely, without opening anything.
    expect((await command('sessionCreationBegin', 'wf_after', creation(second, { createOperationId: 'op_r', sessionId: 'sess_r' }))).r).toMatchObject({ phase: 'rejected', messageAccepted: false })
    expect(calls('session/new')).toHaveLength(2)
    await expect(readers.creation({ createOperationId: 'op_unknown' })).rejects.toMatchObject({ code: 'creation_not_found' })
  })

  it('cancels a creation whose first message has no outcome yet as unknown', async () => {
    const prepared = await prepare()
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    agent.peer.onRequest('session/set_config_option', async params => {
      await gate
      const { configId, value } = params as Json
      agent.configOptions = agent.configOptions.map(option => (option.id === configId ? { ...option, currentValue: value } : option))
      return { configOptions: agent.configOptions }
    })
    await command('workspacePreparationReserve', 'c_r', reservation(prepared))
    expect((await command('sessionCreationBegin', 'wf_b', creation(prepared))).r).toMatchObject({ phase: 'submitting', messageAccepted: null, canCancelInitialization: true })
    const cancelled = await command('sessionCreationCancel', 'c_cancel', { ...RUNTIME, createOperationId: 'op_1', cancelOperationId: 'cx' })
    expect(cancelled.r).toMatchObject({ phase: 'outcome_unknown', messageAccepted: null, canCancelInitialization: false })
    release()
    // The outcome stays unknown whatever the session does next; a cancel of an accepted creation changes nothing.
    await until(() => store.deliveries.get('sess_1', 'm1'), delivery => delivery?.state === 'started', 'the first message')
    expect(await readers.creation({ createOperationId: 'op_1' })).toMatchObject({ phase: 'outcome_unknown', messageAccepted: null })
    expect((await command('sessionCreationRespond', 'c_resp', { ...RUNTIME, createOperationId: 'op_1', interactionId: 'i' })).e?.code).toBe('interaction_not_found')
  })

  it('leaves an accepted creation as it is when it is cancelled', async () => {
    const prepared = await prepare()
    await command('workspacePreparationReserve', 'c_r', reservation(prepared))
    await command('sessionCreationBegin', 'wf_b', creation(prepared))
    await until(() => readers.creation({ createOperationId: 'op_1' }), v => v.messageAccepted === true, 'the first message')
    expect((await command('sessionCreationCancel', 'c_cancel', { ...RUNTIME, createOperationId: 'op_1', cancelOperationId: 'cx' })).r).toMatchObject({ phase: 'accepted', messageAccepted: true })
  })
})
