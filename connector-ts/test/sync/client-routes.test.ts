// Shape equivalence with the Server (docs/v3/14-unified-client-path.md §G): server/tests/test_client_routes_record.py
// recorded what the Server answered for every client route a v3 device owns (a real Server, Router and TS Connector,
// normal mode). Here DeviceTunnelApi answers the same requests from a device in the same state, and each answer must
// have the recorded shape.
//
// Rules (the same as the recorder's `shape_mismatches`): values are not compared, only JSON types and object keys;
// `null` matches any type (ids, timestamps and optional fields differ between runs); the keys of the open maps
// (`OPEN_MAPS`: selections, metadata, parameters, ...) are not compared; array items are compared by their `type`
// when they have one, else against the other side's first item; an empty array matches any array. An error must
// have the recorded status, and the recorded `detail.code` (or, where the Server answered a plain string, that string
// as `detail.message`). `DEVIATIONS` lists the routes where the device deliberately answers otherwise, with why.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TunnelCallContext } from '../../src/application/inbound/tunnel-api.js'
import { DEVICE, RUNTIME, settle, testDevice, type TestDevice } from '../support/client-device.js'

/** What the Server owns about a call (`ClientServerFacts`), plus the preview file the Server verified. */
type ServerFacts = Record<string, unknown>

const FIXTURES = new URL('../../../server/tests/fixtures/client_routes/', import.meta.url)

interface Fixture {
  route: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  query: Record<string, unknown> | null
  body: unknown
  status: number
  response: unknown
  note?: string
}

function fixture(route: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${route}.json`, FIXTURES), 'utf8')) as Fixture
}

// ------------------------------------------------------------------------------------------------ shape rules

const OPEN_MAPS = new Set(['selections', 'metadata', 'parameters', 'context', 'input', 'content', 'env', 'config', 'catalogs', 'r', 'payload', 'source', 'details'])

function kind(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

/** Where `actual` does not have the shape of `expected` (empty when it does). */
export function shapeMismatches(expected: unknown, actual: unknown, path = '$'): string[] {
  const a = kind(expected)
  const b = kind(actual)
  if (a === 'null' || b === 'null') return []
  if (a !== b) return [`${path}: ${a} != ${b}`]
  if (a === 'object') {
    if (OPEN_MAPS.has(path.slice(path.lastIndexOf('.') + 1))) return []
    const e = expected as Record<string, unknown>
    const g = actual as Record<string, unknown>
    const out: string[] = []
    const missing = Object.keys(e).filter(key => !(key in g)).sort()
    const extra = Object.keys(g).filter(key => !(key in e)).sort()
    if (missing.length > 0) out.push(`${path}: missing ${JSON.stringify(missing)}`)
    if (extra.length > 0) out.push(`${path}: extra ${JSON.stringify(extra)}`)
    for (const key of Object.keys(e).filter(key => key in g).sort()) out.push(...shapeMismatches(e[key], g[key], `${path}.${key}`))
    return out
  }
  if (a === 'array') {
    const e = expected as unknown[]
    const g = actual as unknown[]
    if (e.length === 0 || g.length === 0) return []
    const typed = [...e, ...g].every(item => kind(item) === 'object' && 'type' in (item as object))
    const out: string[] = []
    if (typed) {
      const byType = new Map(e.map(item => [(item as { type: unknown }).type, item]))
      g.forEach((item, index) => {
        const match = byType.get((item as { type: unknown }).type)
        if (match !== undefined) out.push(...shapeMismatches(match, item, `${path}[${index}]`))
      })
      return out
    }
    g.forEach((item, index) => out.push(...shapeMismatches(e[0], item, `${path}[${index}]`)))
    return out
  }
  return []
}

/**
 * Routes where the device answers otherwise on purpose. `status` is what the device answers; `shape`, when given,
 * is the response model the device must match instead of the recorded failure.
 */
const DEVIATIONS: Record<string, { status: number; reason: string; shape?: unknown }> = {
  'session.snapshot': { status: 200, reason: 'the Server fails to join the device snapshot chunks at 4c8012369 (raw JSON slices vs base64 deflate)' },
  'device.runtime.catalog.model': {
    status: 200,
    reason: 'a v3 device serves Runtime-level catalogs; the Server asked Runtime/catalogs without a session and got session_not_found',
    shape: { catalog: { runtime: 'x', revision: 1, models: [{ displayName: 'x', id: 'x', selectionId: 'x', description: null, default: false, reasoningItems: [], group: null, metadata: {} }] }, serverTime: 'x' },
  },
  'device.runtime.catalog.permission': {
    status: 200,
    reason: 'as the model catalog',
    shape: { catalog: { runtime: 'x', revision: 1, permissions: [] }, serverTime: 'x' },
  },
  'device.runtime.commands': { status: 200, reason: 'the Server has no v3 route (device_method_unsupported); slash commands are per session', shape: { commands: [], serverTime: 'x' } },
  'device.terminals_v1.create': { status: 200, reason: 'v1 terminals relied on terminal.relay.connect, which v3 devices never had', shape: { terminal: TERMINAL_V1(), serverTime: 'x' } },
  'session.terminals_v1.create': { status: 200, reason: 'as the device v1 terminals (the Server lost the connection binding)', shape: { terminal: TERMINAL_V1(), serverTime: 'x' } },
}

function TERMINAL_V1(): Record<string, unknown> {
  return { terminalId: 'x', sessionId: 'x', label: 'x', root: 'x', cwd: 'x', cols: 1, rows: 1, purpose: 'user', pid: 1, status: 'running', exitCode: null, scrollbackBytes: 0, scrollbackSeq: 0, ephemeralGroupId: null, persistent: false, createdAt: 'x' }
}

// --------------------------------------------------------------------------------------------- the device

const SESSION = 'sess_shape'

let device: TestDevice
const names: Record<string, string> = {}

function fill(value: unknown): unknown {
  if (value === null || value === undefined) return value
  return JSON.parse(JSON.stringify(value).replace(/\{(\w+)\}/gu, (match, name: string) => names[name] ?? match))
}

async function call(route: string, server?: ServerFacts): Promise<{ fixture: Fixture; status: number; body: unknown }> {
  const recorded = fixture(route)
  const query = fill(recorded.query) as Record<string, unknown> | null
  const search = query === null ? '' : `?${new URLSearchParams(Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]))}`
  const options: TunnelCallContext = server === undefined ? {} : { server: server as never }
  const response = await device.request(recorded.method, `${fill(recorded.path) as string}${search}`, fill(recorded.body) ?? {}, options)
  return { fixture: recorded, status: response.status, body: response.body }
}

const checked = new Set<string>()

/** Calls the route as recorded and asserts the answer has the recorded shape (or the deviation's). */
async function check(route: string, server?: ServerFacts): Promise<unknown> {
  const { fixture: recorded, status, body } = await call(route, server)
  checked.add(route)
  const deviation = DEVIATIONS[route]
  const context = `${route}: ${JSON.stringify(body).slice(0, 600)}`
  if (deviation !== undefined) {
    expect(status, context).toBe(deviation.status)
    if (deviation.shape !== undefined) expect(shapeMismatches(deviation.shape, body), context).toEqual([])
    return body
  }
  expect(status, context).toBe(recorded.status)
  if (recorded.status < 400) {
    expect(shapeMismatches(recorded.response, body), context).toEqual([])
    return body
  }
  const detail = (recorded.response as { detail?: unknown }).detail
  const got = (body as { detail?: { code?: string; message?: string } }).detail
  if (typeof detail === 'string') expect(fill(detail), context).toBe(got?.message)
  else expect(got?.code, context).toBe((detail as { code: string }).code)
  return body
}

beforeAll(async () => {
  device = await testDevice()
  device.commands.observe('runtime.status', { sessionId: SESSION, status: { event: 'commands.updated', fact: { commands: [{ name: 'review', description: 'Review the working tree', inputHint: 'path' }, { name: 'compact', description: 'Compact the context' }] } } })
  Object.assign(names, { root: device.root, connectorId: DEVICE, sessionId: SESSION, runtimeId: RUNTIME })
})

afterAll(async () => {
  await device?.close()
})

describe('client routes: the device answers with the shapes the Server answered', () => {
  it('serves every recorded route', async () => {
    await device.start(SESSION)
    const { root, sessions, inbox } = device
    const runTurn = device.runTurn
    const tunnelGet = async (path: string) => (await device.request('GET', path)).body

    // Reads.
    await check('session.snapshot')
    await check('session.timeline')
    await check('session.events')
    await check('session.runtime.state')
    await check('session.runtime.capabilities')
    await check('session.runtime.notices')
    await check('session.runtime.queue')
    await check('session.planning')
    await check('session.goal')
    await check('session.catalog.model')
    await check('session.catalog.permission')
    await check('session.commands.list')

    // Commands.
    await check('session.selections')
    await check('session.commands.execute')
    await runTurn('/review src')
    await check('session.commands.execute.unavailable')
    await check('session.messages')
    await runTurn('plain')
    await check('session.notices.respond.missing')
    await check('session.sync')

    // Plans: the Runtime proposes a Markdown plan.
    await device.request('POST', `/sessions/${SESSION}/runtime/messages`, { content: '#plan the fix', clientMessageId: 'cm_plan' })
    await expect.poll(() => sessions[0]!.calls.filter(c => c.method === 'prompt').length).toBe(4)
    sessions[0]!.emit({ type: 'turn.started', turnId: 'tp', origin: 'user', clientMessageId: 'cm_plan' })
    sessions[0]!.emit({ type: 'plan.updated', turnId: 'tp', planId: 'plan-e2e', entries: [], document: { planId: 'plan-e2e', markdown: '# E2E plan\n\n1. Read the code\n', title: 'Plan', revision: 0, contentHash: '', contentState: 'ready', createdAt: null, sourceTurnId: 'tp' } as never })
    sessions[0]!.emit({ type: 'turn.ended', turnId: 'tp', reason: 'end_turn' })
    await settle()
    const plans = (await tunnelGet(`/sessions/${SESSION}/plans`)) as { planId: string; revision: number }[]
    expect(plans.length).toBeGreaterThan(0)
    names.planId = plans[0]!.planId
    await check('session.plans')
    await checkPlan('session.plan', plans[0]!.revision)
    await checkPlan('session.plan.markdown', plans[0]!.revision)
    await check('session.plan.missing')

    // A running turn: steer and the queue.
    await device.request('POST', `/sessions/${SESSION}/runtime/messages`, { content: '#slow task', clientMessageId: 'cm_slow' })
    await runTurn('working slowly', true)
    await check('session.steer')
    await check('session.messages.queued')
    await device.request('POST', `/sessions/${SESSION}/runtime/messages`, { content: 'queued two', clientMessageId: 'cm_rec_q2', queue: 'auto' })
    const queue = (await tunnelGet(`/sessions/${SESSION}/runtime/queue`)) as { items: { messageId: string }[] }
    names.q1 = queue.items[0]!.messageId
    names.q2 = queue.items[1]!.messageId
    await check('session.queue.update')
    await check('session.queue.reorder')
    await check('session.queue.delete')
    await check('session.queue.retry.missing')
    await check('session.queue.clear')
    await check('session.queue.resume')
    await check('session.interrupt')
    sessions[0]!.emit({ type: 'turn.ended', turnId: 't6', reason: 'cancelled' })
    await settle()
    await check('session.steer.idle')

    // Read-only (the Server's takeover switch) and archived sessions.
    await check('session.messages.read_only', { takeover: false })
    await check('session.selections.read_only', { takeover: false })
    await inbox.handle('sessionSync', { commandId: 'c_archive', p: { sessionId: SESSION, archived: true } } as never)
    await check('session.messages.archived')
    await inbox.handle('sessionSync', { commandId: 'c_unarchive', p: { sessionId: SESSION, archived: false } } as never)

    // Files.
    await check('device.fs.list')
    await check('device.fs.list.empty_path')
    await check('device.fs.list.parent')
    await check('device.fs.readText')
    await check('device.fs.readText.missing')
    await check('device.fs.write')
    const transfer = { transferId: 'fsdl_1', token: 'tok_1', path: '/api/v3/device/transfers/fsdl_1' }
    await check('device.fs.read', { transfer })
    names.previewAccessToken = 'pat_1'
    await check('device.fs.preview.readText', { preview: { root, path: join(root, 'notes', 'a.txt') } })
    await check('device.fs.preview.read', { preview: { root, path: join(root, 'notes', 'a.txt') }, transfer: { ...transfer, downloadUrl: '/api/v2/connectors/x/fs/transfers/fsdl_1?token=tok_1&previewAccessToken=pat_1' } })
    await check('device.shell.exec')

    // Terminals.
    const terminal = (await check('device.terminals.create')) as { result: { terminalId: string } }
    names.terminalId = terminal.result.terminalId
    await check('device.terminals.list')
    await check('device.terminals.rename')
    await check('device.terminals.persistence')
    await check('device.terminals.write')
    await check('device.terminals.resize')
    await check('device.terminals.snapshot')
    await check('device.terminals.close')
    await check('device.terminals.missing')
    await check('device.terminals_v1.create')
    await check('device.terminals_v1.list')
    await check('session.terminals_v1.create')
    await check('session.terminals_v1.list')

    // Runtime-level catalogs.
    await check('device.runtime.catalog.model')
    await check('device.runtime.catalog.permission')
    await check('device.runtime.commands')

    const recorded = readdirSync(FIXTURES).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    expect(recorded.filter(route => !checked.has(route))).toEqual([])
  }, 30_000)
})

/** A plan route at the revision this device stored (the recording's revision may differ). */
async function checkPlan(route: string, revision: number): Promise<void> {
  const recorded = fixture(route)
  const path = recorded.path.replace(/\/\d+(\/markdown)?$/u, `/${revision}$1`)
  const response = await device.request('GET', fill(path) as string)
  checked.add(route)
  expect(response.status, JSON.stringify(response.body)).toBe(recorded.status)
  expect(shapeMismatches(recorded.response, response.body)).toEqual([])
}

describe('shape rules', () => {
  it('compares types and keys, not values', () => {
    expect(shapeMismatches({ a: 1, b: null }, { a: 2, b: 'x' })).toEqual([])
    expect(shapeMismatches({ a: 1 }, { a: '1' })).toEqual(['$.a: number != string'])
    expect(shapeMismatches({ a: 1 }, { a: 1, b: 2 })).toEqual(['$: extra ["b"]'])
    expect(shapeMismatches({ selections: { m: '1' } }, { selections: {} })).toEqual([])
    expect(shapeMismatches([{ type: 'x', v: 1 }], [{ type: 'y', w: 1 }])).toEqual([])
    expect(shapeMismatches([], [{ z: 1 }])).toEqual([])
  })
})
