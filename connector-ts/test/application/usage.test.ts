import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationService, UsageMeter } from '../../src/application/index.js'
import type { OpenTarget, OutboxStore, RuntimeHandle, RuntimeHandles } from '../../src/application/ports/index.js'
import type { UsageReportOut } from '../../src/generated/device-meshcall/v1_0/usage-report-out.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { MemoryChangeFeed } from '../../src/sync/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
const validateReport = ajv.compile(JSON.parse(readFileSync(join(ROOT, 'contracts/device-meshcall/1.0/schemas/usage-report-out.schema.json'), 'utf8')) as object)

let now = Date.UTC(2026, 10, 18, 10, 0, 0)
let counter = 0
const clock = { nowIso: () => new Date(now).toISOString(), nowMs: () => now }
const ids = { newId: (prefix: string) => `${prefix}${++counter}` }

/** An outbox that keeps what was appended. */
function memoryOutbox(): Pick<OutboxStore, 'append'> & { reports: UsageReportOut[]; fail: boolean } {
  const outbox = {
    reports: [] as UsageReportOut[],
    fail: false,
    async append(kind: string, _sessionId: string | null, payload: unknown): Promise<number> {
      if (outbox.fail) throw new Error('disk full')
      expect(kind).toBe('usage.report')
      outbox.reports.push(payload as UsageReportOut)
      return outbox.reports.length
    },
  }
  return outbox
}

const session = { sessionId: 'sess_1', runtimeType: 'pi', runtimeId: 'rti_pi' }

beforeEach(() => {
  now = Date.UTC(2026, 10, 18, 10, 0, 0)
  counter = 0
})

describe('UsageMeter', () => {
  it('aggregates counts per activity, session and outcome into one report', async () => {
    const outbox = memoryOutbox()
    let pokes = 0
    const meter = new UsageMeter({ outbox, clock, ids, onReport: () => pokes++ })
    meter.count({ name: 'message.sent', ...session })
    now += 1000
    meter.count({ name: 'message.sent', ...session })
    meter.count({ name: 'turn.ended', ...session, outcome: 'completed', durationMs: 1500.4 })
    meter.count({ name: 'turn.ended', ...session, outcome: 'completed', durationMs: null })
    meter.count({ name: 'turn.ended', ...session, outcome: 'failed', durationMs: 20 })
    meter.count({ name: 'message.sent', sessionId: 'sess_2', runtimeType: 'codex', runtimeId: 'rti_codex' })
    now += 1000
    await meter.flush()
    expect(outbox.reports).toEqual([{
      reportId: 'usage_1',
      periodStart: '2026-11-18T10:00:00.000Z',
      periodEnd: '2026-11-18T10:00:02.000Z',
      counters: [
        { name: 'message.sent', value: 2, ...session },
        { name: 'turn.ended', value: 2, ...session, outcome: 'completed', durationsMs: [1500] },
        { name: 'turn.ended', value: 1, ...session, outcome: 'failed', durationsMs: [20] },
        { name: 'message.sent', value: 1, sessionId: 'sess_2', runtimeType: 'codex', runtimeId: 'rti_codex' },
      ],
    }])
    expect(validateReport(outbox.reports[0]), ajv.errorsText(validateReport.errors)).toBe(true)
    expect(pokes).toBe(1)
    // Counted once: the next report starts empty, and nothing is sent without counts.
    await meter.flush()
    expect(outbox.reports).toHaveLength(1)
    meter.count({ name: 'runtime.error', ...session })
    await meter.flush()
    expect(outbox.reports[1]).toMatchObject({ reportId: 'usage_2', counters: [{ name: 'runtime.error', value: 1 }] })
  })

  it('carries ids, names and numbers only', async () => {
    const outbox = memoryOutbox()
    const meter = new UsageMeter({ outbox, clock, ids })
    meter.count({ name: 'approval.resolved', ...session, outcome: 'resolved', durationMs: 5 })
    await meter.flush()
    const counter = outbox.reports[0]!.counters![0]!
    expect(Object.keys(counter).sort()).toEqual(['durationsMs', 'name', 'outcome', 'runtimeId', 'runtimeType', 'sessionId', 'value'])
    expect(Object.keys(outbox.reports[0]!).sort()).toEqual(['counters', 'periodEnd', 'periodStart', 'reportId'])
  })

  it('starts a new report with every UTC hour and keeps each count in its hour', async () => {
    const outbox = memoryOutbox()
    const meter = new UsageMeter({ outbox, clock, ids })
    now = Date.UTC(2026, 10, 18, 10, 59, 58)
    meter.count({ name: 'message.sent', ...session })
    now = Date.UTC(2026, 10, 18, 10, 59, 59)
    meter.count({ name: 'message.sent', ...session })
    now = Date.UTC(2026, 10, 18, 11, 0, 1)
    meter.count({ name: 'message.sent', ...session })
    await meter.flush()
    expect(outbox.reports.map(report => [report.periodStart, report.periodEnd, report.counters![0]!.value])).toEqual([
      ['2026-11-18T10:59:58.000Z', '2026-11-18T10:59:59.000Z', 2],
      ['2026-11-18T11:00:01.000Z', '2026-11-18T11:00:01.000Z', 1],
    ])
    // A timed report that fires after the hour ended ends at its last count.
    meter.count({ name: 'turn.ended', ...session, outcome: 'completed' })
    now = Date.UTC(2026, 10, 18, 12, 0, 30)
    await meter.flush()
    expect(outbox.reports[2]).toMatchObject({ periodStart: '2026-11-18T11:00:01.000Z', periodEnd: '2026-11-18T11:00:01.000Z' })
  })

  it('reports a failed append and keeps counting', async () => {
    const outbox = memoryOutbox()
    const errors: unknown[] = []
    const meter = new UsageMeter({ outbox, clock, ids, onError: error => errors.push(error) })
    outbox.fail = true
    meter.count({ name: 'message.sent', ...session })
    await meter.flush()
    expect(errors).toHaveLength(1)
    outbox.fail = false
    meter.count({ name: 'message.sent', ...session })
    await meter.close()
    expect(outbox.reports).toMatchObject([{ counters: [{ name: 'message.sent', value: 1 }] }])
  })
})

describe('counted use cases', () => {
  let dir: string
  let store: RemoteStore
  let service: ConversationService
  let outbox: ReturnType<typeof memoryOutbox>
  let meter: UsageMeter
  let sessions: FakeRuntimeSession[]

  function handle(): RuntimeHandle {
    return {
      type: 'pi',
      instanceId: 'rti_pi',
      capabilities: () => ({ revision: 1, items: [] }),
      catalogs: async () => ({}),
      listNativeSessions: async () => ({ sessions: [] }),
      readNativeHistory: async () => ({ items: [] }),
      open: async (target: OpenTarget, options) => {
        const native = target.kind === 'existing' ? target.ref.nativeSessionId : `native_${sessions.length}`
        const runtime = new FakeRuntimeSession(options.sessionId, native, { revision: 1, items: [{ id: 'session.send_message', supported: true }, { id: 'session.steer', supported: true }] })
        sessions.push(runtime)
        return runtime
      },
      events: (async function* () {})(),
      stop: async () => undefined,
    }
  }
  const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'rti_pi' ? handle() : null) }
  const ctx = (commandId: string | null = null) => ({ commandId, inputDigest: null, actor: 'usr_1' })

  async function settle(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
  }

  async function makeSession(takeover = true): Promise<void> {
    await store.sessions.create({ sessionId: 'sess_1', runtimeType: 'pi', runtimeId: 'rti_pi', externalSessionId: 'native_sess_1', cwd: '/w', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover, at: clock.nowIso() })
  }

  /** Every counter reported so far, summed by name and outcome. */
  function totals(): Record<string, number> {
    const sums: Record<string, number> = {}
    for (const report of outbox.reports) {
      for (const c of report.counters ?? []) {
        const key = c.outcome != null ? `${c.name}:${c.outcome}` : c.name
        sums[key] = (sums[key] ?? 0) + c.value
      }
    }
    return sums
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aa-usage-'))
    store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
    outbox = memoryOutbox()
    meter = new UsageMeter({ outbox, clock, ids })
    sessions = []
    service = new ConversationService({ store, feed: new MemoryChangeFeed(), live: { emit: () => undefined }, runtimes, clock, ids, coalesceMs: 10, usage: meter })
  })

  afterEach(async () => {
    await service.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts a turn with its message, approval and Runtime error, and reports when the turn ends', async () => {
    await makeSession()
    await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'hello' }, ctx('c1'))
    // A replay of the same message is not another message.
    await service.sendMessage({ sessionId: 'sess_1', clientMessageId: 'm1', content: 'hello' }, ctx('c1'))
    await settle()
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user', clientMessageId: 'm1' })
    await settle()
    now += 2000
    runtime.emit({ type: 'interaction.opened', interactionId: 'perm1', kind: 'approval', title: 'Run ls?', options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }], turnId: 't1' })
    await settle()
    now += 3000
    await service.respondNotice('sess_1', 'perm1', 'r1', { kind: 'option', optionId: 'allow' })
    runtime.emit({ type: 'interaction.resolved', interactionId: 'perm1', resolution: 'answered' })
    runtime.emit({ type: 'notice', itemId: 'n1', level: 'error', kind: 'error', text: 'model overloaded' })
    // The same notice item again (an update) is not another error.
    runtime.emit({ type: 'notice', itemId: 'n1', level: 'error', kind: 'error', text: 'model overloaded' })
    await settle()
    expect(outbox.reports).toEqual([])
    now += 5000
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await settle()
    expect(totals()).toEqual({
      'message.sent': 1,
      'approval.requested': 1,
      'approval.resolved:resolved': 1,
      'runtime.error': 1,
      'turn.ended:completed': 1,
    })
    const counters = outbox.reports.flatMap(report => report.counters ?? [])
    expect(counters.find(c => c.name === 'turn.ended')).toMatchObject({ sessionId: 'sess_1', runtimeType: 'pi', runtimeId: 'rti_pi', durationsMs: [10_000] })
    expect(counters.find(c => c.name === 'approval.resolved')?.durationsMs).toEqual([3000])
    for (const report of outbox.reports) expect(validateReport(report), ajv.errorsText(validateReport.errors)).toBe(true)
  })

  it('expires an open approval at the turn end and counts it as expired', async () => {
    await makeSession()
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user' })
    runtime.emit({ type: 'interaction.opened', interactionId: 'perm1', kind: 'approval', title: 'Run ls?', turnId: 't1' })
    await settle()
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'cancelled' })
    await settle()
    // A late resolution of the expired approval is not counted again.
    runtime.emit({ type: 'interaction.resolved', interactionId: 'perm1', resolution: 'answered' })
    await settle()
    await meter.flush()
    expect(totals()).toEqual({ 'approval.requested': 1, 'approval.resolved:expired': 1, 'turn.ended:interrupted': 1 })
  })

  it('counts a new session with its first message, and steering as a message', async () => {
    await service.createSession({ sessionId: 'sess_new', runtimeId: 'rti_pi', runtimeType: 'pi', cwd: '/w', clientMessageId: 'cm1', content: 'start' }, ctx('c_new'))
    await service.createSession({ sessionId: 'sess_new', runtimeId: 'rti_pi', runtimeType: 'pi', cwd: '/w', clientMessageId: 'cm1', content: 'start' }, ctx('c_new')).catch(() => undefined)
    await settle()
    sessions[0]!.emit({ type: 'turn.started', turnId: 't1', origin: 'user', clientMessageId: 'cm1' })
    await settle()
    await service.steer({ sessionId: 'sess_new', clientMessageId: 'cm2', content: 'also this' }, ctx('c_steer'))
    await meter.flush()
    expect(totals()).toEqual({ 'session.created': 1, 'message.sent': 2 })
    expect(outbox.reports[0]!.counters![0]).toMatchObject({ sessionId: 'sess_new', runtimeType: 'pi', runtimeId: 'rti_pi' })
  })

  it('does not count turns of a session the platform does not drive', async () => {
    await makeSession(false)
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user' })
    await settle()
    runtime.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await settle()
    await meter.flush()
    expect(totals()).toEqual({})
  })

  it('counts a turn the Runtime lost as failed, with a Runtime error', async () => {
    await makeSession()
    await service.binding('sess_1')
    const runtime = sessions[0]!
    runtime.emit({ type: 'turn.started', turnId: 't1', origin: 'user' })
    await settle()
    runtime.emit({ type: 'session.lost', error: { code: 'runtime_exited', message: 'gone' } })
    await settle()
    expect(totals()).toEqual({ 'turn.ended:failed': 1, 'runtime.error': 1 })
  })
})
