// What the device really answers the Server, locked in a fixture both sides test against.
//
// `server/tests/fixtures/device_shapes.json` holds two kinds of entries:
// - `requests.*`: payloads the Server sends (server/tests/test_device_shapes.py checks the Server still sends them);
//   this file feeds them to the real CommandInbox.
// - everything else: what the real device code answers or emits; this file checks the device still produces them
//   exactly, and the Server tests feed them to the Server (fake device, service-level tests).
// A Server-side or device-side change that breaks the other side fails one of the two. Regenerate the device
// entries with `UPDATE_DEVICE_SHAPES=1 npx vitest run test/application/server-shapes.test.ts` and review the diff.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandInbox } from '../../src/application/inbound/index.js'
import { ConversationService } from '../../src/application/index.js'
import type { ConfigChange, ConfigOption, ConfigResult, GoalPort, OpenTarget, PlanningPort, RuntimeHandle, RuntimeHandles } from '../../src/application/ports/index.js'
import type { GoalState as GoalWire } from '../../src/generated/protocol/v1_2/goal-state.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, MemoryChangeFeed, type RuntimeFacts } from '../../src/sync/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../server/tests/fixtures/device_shapes.json')
const UPDATE = process.env.UPDATE_DEVICE_SHAPES === '1'
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
const produced: Record<string, unknown> = {}

/** The Server's payloads (owned by the Server tests; kept here when regenerating). */
const REQUESTS = fixture.requests as Record<string, Record<string, unknown>>

function shape(name: string, value: unknown): void {
  const plain = JSON.parse(JSON.stringify(value)) as unknown
  produced[name] = plain
  if (!UPDATE) expect(plain, `device shape ${name} drifted from ${FIXTURE}`).toEqual(fixture[name])
}

afterAll(() => {
  if (UPDATE) writeFileSync(FIXTURE, `${JSON.stringify({ requests: REQUESTS, ...produced }, null, 2)}\n`)
})

const SID = 'sess_shape'
let dir: string
let store: RemoteStore
let live: { method: string; payload: Record<string, unknown> }[]
let service: ConversationService
let readers: DeviceReaders
let inbox: CommandInbox
let sessions: ShapeSession[]
let ms = 0
let counter = 0

const clock = { nowIso: () => new Date(Date.UTC(2026, 10, 16, 0, 0, 0, ms)).toISOString(), nowMs: () => ms }
const ids = { newId: (prefix: string) => `${prefix}${++counter}` }

/** A Runtime session with configuration options, a planning mode and a session goal. */
class ShapeSession extends FakeRuntimeSession {
  options: ConfigOption[] = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-5', values: [{ value: 'gpt-5', name: 'GPT-5' }, { value: 'gpt-5-mini', name: 'GPT-5 mini' }] },
    { id: 'permission', name: 'Permission', category: 'permission', type: 'select', currentValue: 'ask', values: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }] },
    { id: 'effort', name: 'Effort', category: 'effort', type: 'select', currentValue: 'medium', values: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  ]
  modes: string[] = []
  goalCalls: string[] = []
  native: NonNullable<GoalWire['goal']> | null = null

  override async configure(change: ConfigChange): Promise<ConfigResult> {
    await super.configure(change)
    this.options = this.options.map(option => (option.id === change.optionId || option.category === change.optionId ? { ...option, currentValue: change.value } : option))
    return { options: this.options, appliesFrom: 'now' }
  }

  readonly planning: PlanningPort = {
    setMode: async mode => {
      this.modes.push(mode)
      this.calls.push({ method: 'command', name: `mode:${mode}`, args: undefined })
    },
    current: async () => ({ mode: 'plan' }),
  }

  private goalWire(): GoalWire {
    return { sessionId: this.sessionId, runtime: 'codex', goal: this.native }
  }

  readonly goal: GoalPort = {
    get: async () => this.goalWire(),
    set: async objective => {
      this.goalCalls.push(`set:${objective}`)
      this.native = { id: 'native_goal_1', objective, status: 'active', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z' }
      return this.goalWire()
    },
    pause: async () => this.goalWire(),
    resume: async () => this.goalWire(),
    clear: async () => {
      this.native = null
    },
  }
}

function handle(): RuntimeHandle {
  return {
    type: 'codex',
    instanceId: 'codex',
    capabilities: () => ({ revision: 1, items: [] }),
    catalogs: async () => ({}),
    listNativeSessions: async () => ({ sessions: [] }),
    readNativeHistory: async () => ({ items: [] }),
    open: async (target: OpenTarget, options) => {
      const native = target.kind === 'existing' ? target.ref.nativeSessionId : `thr_${options.sessionId}`
      const session = new ShapeSession(options.sessionId, native)
      sessions.push(session)
      return session
    },
    events: (async function* () {})(),
    stop: async () => undefined,
  }
}

const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'codex' ? handle() : null) }

/** Session capabilities as `capabilitySet()` reports them for a Codex session. */
const facts: RuntimeFacts = {
  sessionCapabilities: async sessionId => ({
    revision: 1,
    capabilities: [
      { capabilityId: 'session.planning', supported: true, available: true, runtime: 'codex', scope: 'session', sessionId },
      { capabilityId: 'session.plan_review', supported: true, available: true, runtime: 'codex', scope: 'session', sessionId },
      { capabilityId: 'session.goal', supported: true, available: true, parameters: { actions: ['set', 'pause', 'resume', 'clear'] }, runtime: 'codex', scope: 'session', sessionId },
    ],
  }),
  catalogs: async () => ({}),
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

function lastStatus(event: string): Record<string, unknown> {
  const found = live.filter(entry => entry.method === 'runtime.status' && (entry.payload.status as Record<string, unknown> | undefined)?.event === event)
  expect(found.length, `no ${event} on runtime.status`).toBeGreaterThan(0)
  return found[found.length - 1]!.payload
}

async function command(route: string, commandId: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ack = await inbox.handle(route, { commandId, deadline: '2026-11-16T00:01:00.000Z', p } as never)
  expect(ack, `${route} was rejected`).toMatchObject({ outcome: 'accepted' })
  return ack.r as Record<string, unknown>
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aa-shapes-'))
  store = inProcessStore(openSqliteStore({ dataDir: dir, durability: 'normal', now: clock.nowIso }))
  live = []
  sessions = []
  ms = 0
  counter = 0
  service = new ConversationService({ store, feed: new MemoryChangeFeed(), live: { emit: (method, payload) => live.push({ method, payload }) }, runtimes, clock, ids, coalesceMs: 100 })
  readers = new DeviceReaders(store, clock.nowIso, facts)
  inbox = new CommandInbox(store, clock, service)
  await store.sessions.create({ sessionId: SID, runtimeType: 'codex', runtimeId: 'codex', externalSessionId: `thr_${SID}`, cwd: '/repo', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: true, at: clock.nowIso() })
})

afterEach(async () => {
  await service.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('what the device answers the Server', () => {
  it('applies v2 selections one by one and answers the v2 selection result', async () => {
    const result = await command('sessionSelect', 'cmd_select_1', REQUESTS.select!)
    expect(sessions[0]!.calls.filter(call => call.method === 'configure').map(call => (call as { change: ConfigChange }).change)).toEqual([
      { optionId: 'model', value: 'gpt-5-mini' },
      { optionId: 'permission', value: 'auto' },
    ])
    shape('select.result', result)
  })

  it('answers each part of Sessions/state and the plan documents in the Server shapes', async () => {
    shape('state.goal.unobserved', await readers.sessionState({ sessionId: SID, part: 'goal' }))
    shape('planning.result', await command('sessionPlanning', 'op_plan_1', { sessionId: SID, command: 'enter_plan', operationId: 'op_plan_1', attachments: [] }))
    const runtime = sessions[0]!
    ms = 1000
    runtime.emit({
      type: 'interaction.opened',
      interactionId: 'notice_review_1',
      kind: 'plan_review',
      title: 'Review the plan',
      turnId: 'turn_1',
      plan: { planId: 'native_plan_1', revision: 1, title: 'Plan', markdown: '# Plan\n\n- step one', contentHash: 'sha256:0' },
    })
    await settle()
    shape('event.planning', lastStatus('planning.state.updated'))
    shape('state.planning', await readers.sessionState({ sessionId: SID, part: 'planning' }))
    const list = await readers.planDocument({ sessionId: SID })
    shape('planDocument.list', list)
    const [document] = list.plans as { planId: string; revision: number }[]
    shape('planDocument.one', await readers.planDocument({ sessionId: SID, planId: document!.planId, revision: document!.revision }))
    await expect(readers.planDocument({ sessionId: SID, planId: document!.planId, revision: 9 })).rejects.toMatchObject({ code: 'plan_document_not_found' })

    shape('goal.result', await command('sessionGoal', 'op_goal_1', { sessionId: SID, operationId: 'op_goal_1', expectedRevision: 0, action: 'set', objective: 'ship it', attachments: [] }))
    expect(runtime.goalCalls).toEqual(['set:ship it'])
    shape('event.goal', lastStatus('goal.state.updated'))
    shape('state.goal', await readers.sessionState({ sessionId: SID, part: 'goal' }))
  })

  it('switches plan mode on before the first message of a /plan session', async () => {
    const result = await command('sessionCreationBegin', 'm_create_plan', REQUESTS.creationPlan!)
    expect(result).toMatchObject({ delivery: 'accepted' })
    await settle()
    const runtime = sessions[0]!
    expect(runtime.modes).toEqual(['plan'])
    expect(runtime.calls.map(call => (call.method === 'command' ? call.name : call.method))).toEqual(['mode:plan', 'prompt'])
    expect((await store.planning.load(String(REQUESTS.creationPlan!.sessionId)))?.effectiveMode).toBe('plan')
    expect((await store.deliveries.get(String(REQUESTS.creationPlan!.sessionId), 'm_create_plan'))?.state).toBe('started')
  })

  it('sets the goal instead of sending the first message of a /goal session', async () => {
    await command('sessionCreationBegin', 'm_create_goal', REQUESTS.creationGoal!)
    await settle()
    const runtime = sessions[0]!
    expect(runtime.goalCalls).toEqual(['set:ship the release'])
    expect(runtime.calls.filter(call => call.method === 'prompt')).toEqual([])
    const sessionId = String(REQUESTS.creationGoal!.sessionId)
    expect((await store.goals.load(sessionId))?.goal?.objective).toBe('ship the release')
    expect((await store.deliveries.get(sessionId, 'm_create_goal'))?.state).toBe('started')
  })
})

describe('device rules behind those shapes', () => {
  it('answers every part of Sessions/state when the request names none', async () => {
    const body = await readers.sessionState({ sessionId: SID })
    expect(Object.keys(body).sort()).toEqual(['goal', 'planning', 'state'])
    expect(body.state).toMatchObject({ sessionId: SID, runtime: 'codex', runtimeId: 'codex', status: 'idle' })
    expect(body.planning).toMatchObject({ sessionId: SID, freshness: 'unknown', capabilities: { supported: true } })
  })

  it('refuses a creation with both a planning and a goal intent', async () => {
    const ack = await inbox.handle('sessionCreationBegin', { commandId: 'm_both', deadline: '2026-11-16T00:01:00.000Z', p: { ...REQUESTS.creationPlan, sessionId: 'sess_both', clientMessageId: 'm_both', goalIntent: { mode: 'goal', operationId: 'm_both' } } } as never)
    expect(ack).toMatchObject({ outcome: 'rejected', e: { code: 'invalid_argument' } })
    expect(await store.sessions.get('sess_both')).toBeNull()
  })

  it('lets the queue work once session.sync turns takeover on (a session found on the device)', async () => {
    await store.sessions.create({ sessionId: 'sess_native', runtimeType: 'codex', runtimeId: 'codex', externalSessionId: 'thr_native', cwd: '/repo', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: false, at: clock.nowIso() })
    const refused = await inbox.handle('sessionQueueClear', { commandId: 'q1', deadline: '2026-11-16T00:01:00.000Z', p: { sessionId: 'sess_native' } } as never)
    expect(refused).toMatchObject({ outcome: 'rejected', e: { code: 'session_not_taken_over' } })
    await command('sessionSync', 'takeover_1', { sessionId: 'sess_native', takeover: true })
    expect((await store.sessions.get('sess_native'))?.takeover).toBe(true)
    await command('sessionQueueClear', 'q2', { sessionId: 'sess_native' })
    await command('sessionSync', 'takeover_2', { sessionId: 'sess_native', takeover: false })
    expect((await store.sessions.get('sess_native'))?.takeover).toBe(false)
  })
})
