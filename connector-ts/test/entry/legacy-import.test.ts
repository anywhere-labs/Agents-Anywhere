import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ORDER_ANCHOR_INDEX, orderSeqOf } from '../../src/domain/conversation/index.js'
import { LEGACY_IMPORT_KV, importLegacyV2, planningFromV2 } from '../../src/entry/legacy-import.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'

const CONNECTOR = 'con_home'
let dir: string
let legacy: string
let store: RemoteStore
let logs: string[]

function sqlite(path: string, ddl: string, rows: [string, unknown[]][]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(ddl)
  for (const [sql, values] of rows) db.prepare(sql).run(...(values as never[]))
  db.close()
}

/** A v2 Connector with an ACP Runtime (one AA session, two projected items), planning and goal state for Codex. */
function writeV2(): void {
  const acp = join(legacy, CONNECTOR, 'gemini', 'acp', 'abc123', 'coordination.sqlite')
  const record = 'INSERT INTO records(kind, id, body) VALUES (?, ?, ?)'
  sqlite(acp, 'CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));', [
    [record, ['binding', 'sess_acp', JSON.stringify({ session_id: 'sess_acp', profile_id: 'gemini', agent_session_id: 'native_1', workspace: { canonical_path: '/work/app' } })]],
    [record, ['projection', 'it_2', JSON.stringify({ id: 'it_2', sessionId: 'sess_acp', type: 'message', role: 'assistant', status: 'done', orderSeq: 2, content: { text: 'hi there' }, source: { runtime: 'gemini' }, createdAt: '2026-01-01T00:00:01Z' })]],
    [record, ['projection', 'it_1', JSON.stringify({ id: 'it_1', sessionId: 'sess_acp', type: 'message', role: 'user', status: 'done', orderSeq: 1, content: { text: 'hello' }, source: { runtime: 'gemini', clientMessageId: 'cm_1' }, createdAt: '2026-01-01T00:00:00Z' })]],
    [record, ['projection', 'it_x', JSON.stringify({ id: 'it_x', sessionId: 'sess_other', type: 'message', orderSeq: 1, content: {} })]],
    [record, ['operation', 'op_1', '{}']],
  ])
  const planning = join(legacy, CONNECTOR, 'codex', 'planning.sqlite3')
  const document = { planId: 'plan_1', revision: 1, contentHash: 'h', title: 'Plan', markdown: '# Plan', sourceTurnId: null, contentState: 'ready', createdAt: '2026-01-01T00:00:00Z' }
  sqlite(planning, 'CREATE TABLE planning_document(session_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,plan_id,revision)); CREATE TABLE planning_state(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);', [
    ['INSERT INTO planning_state VALUES (?, ?)', ['sess_plan', JSON.stringify({ session_id: 'sess_plan', runtime: 'codex', effective_mode: 'plan', requested_mode: 'plan', freshness: 'fresh', revision: 4, epoch: 'e1', draft: null, proposals: [document], review: null, native_review: null, operation: null, execution: null, execution_progress: null, plan_ids: {} })]],
    ['INSERT INTO planning_document(session_id, plan_id, revision, payload) VALUES (?, ?, ?, ?)', ['sess_plan', 'plan_1', 1, JSON.stringify(document)]],
  ])
  const goals = join(legacy, CONNECTOR, 'codex', 'goal.sqlite3')
  sqlite(goals, 'CREATE TABLE goal_state(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);', [
    ['INSERT INTO goal_state VALUES (?, ?)', ['sess_goal', JSON.stringify({ sessionId: 'sess_goal', runtime: 'codex', runtimeId: 'codex', externalSessionId: 'thr_9', revision: 2, bindingGeneration: 1, sourceEpoch: 's', freshness: 'fresh', capabilities: { supported: true, actions: ['set'] }, goal: { objective: 'ship it' }, lastOutcome: null, _nativeIdentity: 'thr_9' })]],
    ['INSERT INTO goal_state VALUES (?, ?)', ['sess_gone', JSON.stringify({ sessionId: 'sess_gone', runtime: 'codex', _deleted: true })]],
  ])
}

const run = () => importLegacyV2(store, { legacyRoot: legacy, connectorId: CONNECTOR, runtimeTypeOf: id => id, log: (_level, message) => logs.push(message), now: () => '2026-06-01T00:00:00Z' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-legacy-'))
  legacy = join(dir, 'v2')
  logs = []
  store = inProcessStore(openSqliteStore({ dataDir: join(dir, 'store'), durability: 'normal', now: () => new Date().toISOString() }))
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('importing a v2 Connector', () => {
  it('brings over ACP sessions with their timelines, planning and goals, once, leaving the v2 files as they were', async () => {
    writeV2()
    const acp = join(legacy, CONNECTOR, 'gemini', 'acp', 'abc123', 'coordination.sqlite')
    const before = { bytes: readFileSync(acp), mtime: statSync(acp).mtimeMs }
    expect(await run()).toEqual({ sessions: 3, items: 2, planning: 1, goals: 1, problems: [] })

    expect(await store.sessions.get('sess_acp')).toMatchObject({ runtimeId: 'gemini', runtimeType: 'gemini', externalSessionId: 'native_1', cwd: '/work/app' })
    const page = await store.timeline.read('sess_acp', 'latest', null, 10, 1_000_000)
    expect(page.items.map(item => [item.id, item.orderSeq])).toEqual([
      ['it_1', orderSeqOf(ORDER_ANCHOR_INDEX - 2)],
      ['it_2', orderSeqOf(ORDER_ANCHOR_INDEX - 1)],
    ])
    expect(await store.timeline.findByClientMessageId('sess_acp', 'cm_1')).toMatchObject({ id: 'it_1' })
    // A projection without a binding belongs to no session AA created.
    expect(await store.sessions.get('sess_other')).toBeNull()

    expect(await store.planning.load('sess_plan')).toMatchObject({ runtime: 'codex', effectiveMode: 'plan', revision: 4, freshness: 'unknown' })
    expect(await store.planning.document('sess_plan', 'plan_1', 1)).toMatchObject({ markdown: '# Plan' })
    expect(await store.goals.load('sess_goal')).toMatchObject({ externalSessionId: 'thr_9', nativeIdentity: 'thr_9', freshness: 'unknown', goal: { objective: 'ship it' } })
    expect(await store.sessions.get('sess_gone')).toBeNull()
    expect(await store.kv.get(LEGACY_IMPORT_KV.runtimeId, LEGACY_IMPORT_KV.key)).toMatchObject({ sessions: 3, problems: 0 })
    expect(logs[0]).toContain('imported from v2: 3 sessions')

    // Read-only: v2 still finds its files unchanged after a rollback.
    expect(readFileSync(acp).equals(before.bytes)).toBe(true)
    expect(statSync(acp).mtimeMs).toBe(before.mtime)
    // Once per device.
    expect(await run()).toBeNull()
  })

  it('keeps what the v3 store already has and reports unreadable files without failing', async () => {
    writeV2()
    await store.sessions.create({ sessionId: 'sess_acp', runtimeType: 'gemini', runtimeId: 'gemini', externalSessionId: 'native_1', cwd: '/elsewhere', nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: false, at: '2026-05-01T00:00:00Z' })
    const broken = join(legacy, CONNECTOR, 'pi', 'planning.sqlite3')
    mkdirSync(join(broken, '..'), { recursive: true })
    writeFileSync(broken, 'not a database')
    const result = await run()
    expect(result).toMatchObject({ sessions: 2, items: 0, planning: 1, goals: 1 })
    expect(result!.problems).toHaveLength(1)
    expect(result!.problems[0]).toContain('pi/planning.sqlite3')
    expect(await store.sessions.get('sess_acp')).toMatchObject({ cwd: '/elsewhere' })
    expect(logs.some(line => line.startsWith('v2 import skipped'))).toBe(true)
  })

  it('does nothing without v2 files and still marks the import done', async () => {
    expect(await run()).toEqual({ sessions: 0, items: 0, planning: 0, goals: 0, problems: [] })
    expect(await run()).toBeNull()
  })

  it('maps v2 planning state and refuses rows without a session', () => {
    expect(planningFromV2({ runtime: 'codex' })).toBeNull()
    expect(planningFromV2({ session_id: 's', runtime: 'codex', effective_mode: 'weird', requested_mode: 'x' })).toMatchObject({ effectiveMode: 'unknown', requestedMode: null, revision: 0, planIds: {} })
  })
})
