// The fixtures the Server and the device share, against the device-meshcall JSON Schemas.
//
// `server/tests/fixtures/device_shapes.json` and `runtime_control_commands.json` hold what the Server sends and
// what the device answers or reports. The Server validates every entry with its pydantic models
// (`test_device_shapes.py`, `test_device_runtime_control.py`); this file validates the same entries with the
// generated JSON Schemas of `contracts/device-meshcall/1.0`, so a schema that drifts from either side fails here.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import { parseRequest } from '../../src/application/inbound/index.js'
import { COMMAND_ROUTES, READ_ROUTES, type CommandMethod } from '../../src/generated/device-meshcall/v1_0/payloads.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FIXTURES = join(ROOT, 'server/tests/fixtures')

interface ArtifactRef { contract: string; version: string; slug: string; model: string }
interface MethodRef { request: ArtifactRef; response: ArtifactRef }
interface Payloads {
  commands: Record<string, MethodRef>
  reads: Record<string, MethodRef>
  events: Record<string, ArtifactRef>
  outbox: Record<string, ArtifactRef>
}

const payloads = JSON.parse(readFileSync(join(ROOT, 'contracts/device-meshcall/1.0/payloads.json'), 'utf8')) as Payloads

/** Every schema of the contracts the payloads reference, by `$id`. */
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
for (const contract of ['device-meshcall/1.0', 'protocol/1.2', 'preview/1.0']) {
  const dir = join(ROOT, 'contracts', contract, 'schemas')
  for (const file of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(join(dir, file), 'utf8')) as object)
}

function schemaId(ref: ArtifactRef): string {
  return `urn:agents-anywhere:${ref.contract}:${ref.version}:${ref.slug}`
}

type Part = 'request' | 'response'
/**
 * A fixture entry's schema: a method's request or response, or a schema by `$id`; `wrap` places the entry where
 * that schema has it.
 */
type Target = ({ method: string; part: Part } | { id: string }) & { wrap?: (value: unknown) => unknown }

function idOf(target: Target): string {
  if ('id' in target) return target.id
  const method = payloads.commands[target.method] ?? payloads.reads[target.method]
  if (method === undefined) throw new Error(`no payloads for ${target.method}`)
  return schemaId(method[target.part])
}

function check(fixture: Record<string, Record<string, unknown> | unknown>, entries: Record<string, Target>): void {
  const names = Object.entries(fixture).flatMap(([key, value]) => (
    key === 'requests' || key === 'results' || key === 'deviceReports'
      ? Object.keys(value as Record<string, unknown>).map(name => `${key}.${name}`)
      : [key]
  ))
  expect(names.sort(), 'every fixture entry needs its schema').toEqual(Object.keys(entries).sort())
  for (const [name, target] of Object.entries(entries)) {
    const [kind, ...rest] = name.split('.')
    const value = kind === 'requests' || kind === 'results' || kind === 'deviceReports'
      ? (fixture[kind!] as Record<string, unknown>)[rest.join('.')]
      : fixture[name]
    const validate = ajv.getSchema(idOf(target))
    if (validate === undefined) throw new Error(`no schema ${idOf(target)}`)
    expect(validate(target.wrap?.(value) ?? value), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true)
  }
}

const req = (method: string): Target => ({ method, part: 'request' })
const res = (method: string): Target => ({ method, part: 'response' })
const STATUS_EVENT: Target = { id: 'urn:agents-anywhere:device-meshcall:1.0:runtime-status-event' }

describe('shared fixtures against device-meshcall 1.0', () => {
  it('maps every method to a MeshCall route', () => {
    expect(Object.keys(COMMAND_ROUTES).sort()).toEqual(Object.keys(payloads.commands).sort())
    expect(Object.keys(READ_ROUTES).sort()).toEqual(Object.keys(payloads.reads).sort())
    expect(COMMAND_ROUTES['session.queue.sendNow']).toBe('aa.device.v1.Commands/sessionQueueSendNow')
    expect(READ_ROUTES['client.call']).toBe('aa.device.v1.Client/call')
  })

  it('device_shapes.json', () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, 'device_shapes.json'), 'utf8')) as Record<string, unknown>
    check(fixture, {
      'requests.select': req('session.select'),
      'requests.creationPlan': req('session.creation.begin'),
      'requests.creationGoal': req('session.creation.begin'),
      'requests.workspacePrepare': req('workspace.prepare'),
      'requests.workspacePreparationReserve': req('workspace.preparation.reserve'),
      'requests.creationPrepared': req('session.creation.begin'),
      'select.result': res('session.select'),
      'state.goal.unobserved': res('session.state'),
      'state.planning': res('session.state'),
      'state.goal': res('session.state'),
      'planning.result': res('session.planning'),
      'goal.result': res('session.goal'),
      'event.planning': STATUS_EVENT,
      'event.goal': STATUS_EVENT,
      'planDocument.list': res('store.planDocument'),
      'planDocument.one': res('store.planDocument'),
      'runtime.capabilities.prepared': { id: 'urn:agents-anywhere:protocol:1.2:capability-set' },
      'workspacePrepare.result': res('workspace.prepare'),
      'workspacePreparation.ready': res('workspace.preparation.get'),
      'workspacePreparationReserve.stale': res('workspace.preparation.reserve'),
      'workspacePreparationReserve.result': res('workspace.preparation.reserve'),
      'creationPrepared.result': res('session.creation.begin'),
      'creationPrepared.accepted': res('session.creation.get'),
    })
  })

  it('runtime_control_commands.json', () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, 'runtime_control_commands.json'), 'utf8')) as Record<string, unknown>
    check(fixture, {
      'requests.runtimeApply': req('runtime.apply'),
      'requests.runtimeApplyStop': req('runtime.apply'),
      'requests.channelSwitch': req('channel.switch'),
      'requests.deviceSettingsApply': req('device.settings.apply'),
      'results.runtimeApply': res('runtime.apply'),
      'results.runtimeApplyStop': res('runtime.apply'),
      'results.channelSwitch': res('channel.switch'),
      'results.deviceSettingsApply': res('device.settings.apply'),
      // The descriptor as the device reports it (`runtime.types`); the frozen Runtime Control 2.1 schema predates
      // optional `modelConnection.modelsField`.
      'deviceReports.claudeDescriptor': {
        ...STATUS_EVENT,
        wrap: descriptor => ({ runtimeId: '*', status: { event: 'runtime.types', runtimeTypes: [descriptor], features: [] } }),
      },
      'deviceReports.runtimeTypes': STATUS_EVENT,
    })
  })

  it('the device\'s request checks accept every command request the Server sends', () => {
    const requests: [string, CommandMethod, string][] = [
      ['device_shapes.json', 'session.select', 'select'],
      ['device_shapes.json', 'session.creation.begin', 'creationPlan'],
      ['device_shapes.json', 'session.creation.begin', 'creationGoal'],
      ['device_shapes.json', 'session.creation.begin', 'creationPrepared'],
      ['device_shapes.json', 'workspace.prepare', 'workspacePrepare'],
      ['device_shapes.json', 'workspace.preparation.reserve', 'workspacePreparationReserve'],
      ['runtime_control_commands.json', 'runtime.apply', 'runtimeApply'],
      ['runtime_control_commands.json', 'runtime.apply', 'runtimeApplyStop'],
      ['runtime_control_commands.json', 'channel.switch', 'channelSwitch'],
      ['runtime_control_commands.json', 'device.settings.apply', 'deviceSettingsApply'],
    ]
    for (const [file, method, name] of requests) {
      const fixture = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as { requests: Record<string, unknown> }
      expect(fixture.requests[name], `${file} requests.${name}`).toBeDefined()
      expect(() => parseRequest(method, fixture.requests[name]), `${file} requests.${name}`).not.toThrow()
    }
  })

  it('refuses a payload that breaks the contract', () => {
    const validate = ajv.getSchema(schemaId(payloads.commands['session.select']!.request))!
    expect(validate({ selections: { model: 'm' } })).toBe(false)
    const item = ajv.getSchema('urn:agents-anywhere:device-meshcall:1.0:client-call-item')!
    expect(item({ kind: 'head', status: 200 })).toBe(true)
    expect(item({ kind: 'chunk', seq: 0, chunk: '{"a":', end: false })).toBe(true)
    expect(item({ kind: 'head', status: 99 })).toBe(false)
  })
})
