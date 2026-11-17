// Runtime Control 3.0 on the device, against what the Server really sends.
//
// `server/tests/fixtures/runtime_control_commands.json` is shared with server/tests/test_device_runtime_control.py:
// - `requests.*`: the `runtime.apply` / `channel.switch` / `device.settings.apply` payloads the Server builds
//   (`device_runtime_entry`, `device_settings_command_payload`); owned by the Server test. Here they go through
//   the real `CommandInbox` into the real Claude provider's settings check and the real registry.
// - `results.*` and `deviceReports.*`: what this device code answers and reports; owned by this test. The Server
//   test feeds them to `DeviceRuntimeService` (ingestion of the type descriptors, the stored status).
// Regenerate this side with `UPDATE_RUNTIME_CONTROL_FIXTURE=1 npx vitest run test/entry/runtime-control.test.ts`.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox, runtimeControlCommands } from '../../src/application/inbound/index.js'
import type { ConversationService } from '../../src/application/index.js'
import type { LiveEvents, ProviderFacts, RuntimeInstanceConfig } from '../../src/application/ports/index.js'
import { RuntimeRegistry, announceRuntimes, applyDesiredRuntimes, runtimeTypeDescriptor } from '../../src/application/runtimes/index.js'
import { claudeProvider } from '../../src/runtime/profiles/claude/index.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../server/tests/fixtures/runtime_control_commands.json')
const UPDATE = process.env.UPDATE_RUNTIME_CONTROL_FIXTURE === '1'
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  requests: Record<string, Record<string, unknown>>
  results?: Record<string, unknown>
  deviceReports?: Record<string, unknown>
}
const produced: { results: Record<string, unknown>; deviceReports: Record<string, unknown> } = { results: {}, deviceReports: {} }

function shape(kind: 'results' | 'deviceReports', name: string, value: unknown): void {
  const plain = JSON.parse(JSON.stringify(value)) as unknown
  produced[kind][name] = plain
  if (!UPDATE) expect(plain, `device ${kind}.${name} drifted from ${FIXTURE}`).toEqual(fixture[kind]?.[name])
}

afterAll(() => {
  if (UPDATE) writeFileSync(FIXTURE, `${JSON.stringify({ requests: fixture.requests, ...produced }, null, 2)}\n`)
})

/** The Server's payload with the instance id it really used (the fixture keeps a placeholder). */
function request(name: string, runtimeId = 'rti_work'): Record<string, unknown> {
  const payload = fixture.requests[name]
  expect(payload, `the Server test has not written requests.${name}`).toBeDefined()
  return 'runtimeId' in payload! ? { ...payload, runtimeId, revision: 10 } : { ...payload }
}

const CLAUDE_FACTS: ProviderFacts = { type: 'claude', displayName: 'Claude Code', installed: true, problems: [], instancePolicy: 'multiple', processScope: 'shared' }
const log = () => undefined
const clock = { nowIso: () => '2026-11-17T00:00:00.000Z', nowMs: () => 0 }

let dir: string
let store: RemoteStore
let registry: RuntimeRegistry
let started: RuntimeInstanceConfig[]
let deviceSettings: Record<string, unknown>[]
let inbox: CommandInbox
let calls = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-runtime-control-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  const claude = claudeProvider({ dataDir: dir })
  started = []
  // The real provider (its settings check and gateway handling); only `start` is watched.
  const watched = Object.assign(Object.create(Object.getPrototypeOf(claude)) as typeof claude, claude, {
    start: async (instance: RuntimeInstanceConfig) => {
      started.push(instance)
      return claude.start(instance)
    },
  })
  registry = new RuntimeRegistry({ connectorId: 'dev_fixture', providers: [watched], log, processId: 'dp_fixture' })
  deviceSettings = []
  const handlers = runtimeControlCommands({ registry, deviceSettings: settings => deviceSettings.push(settings) })
  // Runtime Control commands never touch the conversation use cases.
  inbox = new CommandInbox(store, clock, {} as ConversationService, handlers)
})

afterEach(async () => {
  await registry.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function command(route: string, p: Record<string, unknown>): Promise<{ outcome: string; r?: Record<string, unknown> | null; e?: { code: string } | null }> {
  return (await inbox.handle(route, { commandId: `c_${++calls}`, deadline: '2026-11-17T00:01:00Z', p })) as never
}

describe('runtime.apply with the Server payload', () => {
  it('starts the named instance with its settings and the gateway as modelGateway, and reports it', async () => {
    const ack = await command('runtimeApply', request('runtimeApply'))
    expect(ack.outcome).toBe('accepted')
    shape('results', 'runtimeApply', ack.r)
    expect(ack.r).toMatchObject({ runtimeId: 'rti_work', status: 'running', instanceId: 'dp_fixture', modelConnection: { state: 'applied', protocol: 'anthropic' } })
    expect(started).toHaveLength(1)
    // The Server's config minus the gateway; the gateway as the Profile's injection, its key as authToken.
    expect(started[0]).toMatchObject({ instanceId: 'rti_work', settings: { claudeExecutable: '/opt/claude/bin/claude' }, modelGateway: { baseUrl: 'https://gateway.example/v1', authToken: 'sk-fixture', protocol: 'anthropic' } })
    expect(started[0]!.settings).not.toHaveProperty('modelGateway')
    expect(registry.spec('rti_work')).toMatchObject({ enabled: true, name: 'Work', revision: 10 })
  })

  it('stops it with active=false, and ignores an older revision', async () => {
    await command('runtimeApply', request('runtimeApply'))
    const handle = await registry.started('rti_work')
    const stopped = await command('runtimeApply', request('runtimeApplyStop'))
    shape('results', 'runtimeApplyStop', stopped.r)
    expect(stopped.r).toMatchObject({ status: 'stopped' })
    expect(registry.started('rti_work')).toBeNull()
    expect(handle).not.toBeNull()
    // A late command from before (revision 9) changes nothing.
    const late = await command('runtimeApply', { ...request('runtimeApply'), revision: 9 })
    expect(late.r).toMatchObject({ status: 'stopped', stale: true })
    expect(registry.spec('rti_work')?.enabled).toBe(false)
  })

  it('rejects settings the provider refuses (no value echoed) and unknown types', async () => {
    const invalid = await command('runtimeApply', { ...request('runtimeApply'), config: { command: 'rm -rf /' } })
    expect(invalid).toMatchObject({ outcome: 'rejected', e: { code: 'invalid_config' } })
    expect(JSON.stringify(invalid)).not.toContain('rm -rf')
    expect(registry.spec('rti_work')).toBeNull()
    const unknown = await command('runtimeApply', { ...request('runtimeApply'), runtimeType: 'gemini' })
    expect(unknown).toMatchObject({ outcome: 'rejected', e: { code: 'runtime_type_unknown' } })
  })
})

describe('channel.switch with the Server payload', () => {
  it('always restarts the instance and refuses an older switch revision', async () => {
    await command('runtimeApply', request('runtimeApply'))
    const first = await registry.started('rti_work')
    const switched = await command('channelSwitch', request('channelSwitch'))
    shape('results', 'channelSwitch', switched.r)
    expect(switched.r).toMatchObject({ status: 'running' })
    expect(started).toHaveLength(2)
    expect(await registry.started('rti_work')).not.toBe(first)
    const stale = await command('channelSwitch', { ...request('channelSwitch'), switchRevision: (request('channelSwitch').switchRevision as number) - 1 })
    expect(stale).toMatchObject({ outcome: 'rejected', e: { code: 'switch_revision_stale' } })
  })
})

describe('device.settings.apply with the Server payload', () => {
  it('hands the settings to the host and confirms', async () => {
    const ack = await command('deviceSettingsApply', request('deviceSettingsApply'))
    shape('results', 'deviceSettingsApply', ack.r)
    expect(ack.r).toEqual({ applied: true })
    expect(deviceSettings).toEqual([fixture.requests.deviceSettingsApply!.settings])
  })
})

describe('LinkWelcome.desired with the Server fields', () => {
  it('reads active/config: a configured instance follows active, an unconfigured legacy one keeps the default', async () => {
    await applyDesiredRuntimes(registry, {
      runtimes: [
        // device_link `_desired_runtimes`: the raw row, with the gateway still inside config.
        { runtimeId: 'rti_work', runtimeType: 'claude', name: 'Work', active: true, config: { claudeExecutable: '/c', modelGateway: { baseUrl: 'https://g', apiKey: 'k' } } },
        { runtimeId: 'claude', runtimeType: 'claude', name: 'Claude', active: false, config: null },
        { runtimeId: 'rti_off', runtimeType: 'claude', name: 'Off', active: false, config: { claudeExecutable: '/c' } },
      ],
    }, log)
    expect(registry.spec('rti_work')).toMatchObject({ enabled: true, settings: { claudeExecutable: '/c' }, modelGateway: { baseUrl: 'https://g', authToken: 'k', protocol: 'anthropic' } })
    expect(registry.spec('claude')).toMatchObject({ enabled: true, settings: {} })
    expect(registry.spec('rti_off')?.enabled).toBe(false)
    expect(await registry.handle('rti_off')).toBeNull()
  })
})

describe('runtime.status reports', () => {
  it('announces the type descriptors and each instance', async () => {
    shape('deviceReports', 'claudeDescriptor', runtimeTypeDescriptor('claude', CLAUDE_FACTS, null, registry.provider('claude')))
    const emitted: { method: string; payload: Record<string, unknown> }[] = []
    const live: LiveEvents = { emit: (method, payload) => emitted.push({ method, payload }) }
    // discover() would look for a local Claude: the facts are fixed here.
    registry.discover = async () => registry.instances().map(spec => ({ spec, facts: CLAUDE_FACTS, error: null }))
    await announceRuntimes(registry, live, log)
    const [types, instance] = emitted
    expect(types).toMatchObject({ method: 'runtime.status', payload: { runtimeId: '*', status: { event: 'runtime.types', features: ['channelReconcileFence'] } } })
    shape('deviceReports', 'runtimeTypes', types!.payload)
    expect(instance).toMatchObject({ payload: { runtimeId: 'claude', status: { instance: { status: 'running' } } } })
  })
})
