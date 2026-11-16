// One-time import of a v2 Connector's own files (08-migration-and-rollout.md §3.4): ACP coordination state (the
// sessions Agents Anywhere created and their projected timelines), planning and goal state. The old files are
// opened read-only and never changed or deleted, so rolling back to v2 still finds them.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ConversationStore } from '../application/ports/index.js'
import { ORDER_ANCHOR_INDEX, orderSeqOf, type TimelineDraft } from '../domain/conversation/index.js'
import type { GoalState } from '../domain/goals/index.js'
import type { PlanDocument, PlanningState } from '../domain/planning/index.js'
import type { Log } from './compose.js'

/** Where the marker lives (`runtime_kv` of a pseudo runtime): the import runs once per device. */
export const LEGACY_IMPORT_KV = { runtimeId: '_legacy', key: 'v2-import' } as const

export interface LegacyImportOptions {
  /** v2's data directory: `AGENT_CONNECTOR_DATA_DIR` or `~/.agents-anywhere`. */
  readonly legacyRoot: string
  readonly connectorId: string
  /** The type of a v2 runtime instance (from the Server's desired state; legacy instances are named after it). */
  readonly runtimeTypeOf: (runtimeId: string) => string | null
  readonly log: Log
  readonly now: () => string
}

export interface LegacyImportResult {
  readonly sessions: number
  readonly items: number
  readonly planning: number
  readonly goals: number
  readonly problems: readonly string[]
}

type Row = Record<string, unknown>

function record(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parse(json: unknown): Row {
  try {
    return record(JSON.parse(String(json)))
  } catch {
    return {}
  }
}

/** Reads every row of `sql` from a v2 SQLite file opened read-only; a missing table is no rows. */
function rows(path: string, sql: string): Row[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(sql).all() as Row[]
  } catch (error) {
    if (/no such table/u.test((error as Error).message)) return []
    throw error
  } finally {
    db.close()
  }
}

function directories(path: string): string[] {
  try {
    return readdirSync(path).filter(name => !name.startsWith('.') && statSync(join(path, name)).isDirectory())
  } catch {
    return []
  }
}

/** v2 `SessionPlanning.saved()` (snake_case dataclass) → v3 `PlanningState`. */
export function planningFromV2(saved: Row): PlanningState | null {
  const sessionId = text(saved.session_id)
  const runtime = text(saved.runtime)
  if (sessionId === null || runtime === null) return null
  const mode = (value: unknown, allowed: readonly string[], fallback: string) => (typeof value === 'string' && allowed.includes(value) ? value : fallback)
  return {
    sessionId,
    runtime,
    effectiveMode: mode(saved.effective_mode, ['plan', 'normal', 'unknown'], 'unknown') as PlanningState['effectiveMode'],
    requestedMode: (saved.requested_mode === 'plan' || saved.requested_mode === 'normal' ? saved.requested_mode : null),
    // Nothing observed the Runtime since v2 stopped: checked again before anything acts on it.
    freshness: 'unknown',
    revision: typeof saved.revision === 'number' ? saved.revision : 0,
    epoch: text(saved.epoch) ?? '',
    draft: (saved.draft ?? null) as PlanningState['draft'],
    proposals: (Array.isArray(saved.proposals) ? saved.proposals : []) as PlanningState['proposals'],
    review: (saved.review ?? null) as PlanningState['review'],
    nativeReview: (saved.native_review ?? null) as PlanningState['nativeReview'],
    operation: (saved.operation ?? null) as PlanningState['operation'],
    execution: (saved.execution ?? null) as PlanningState['execution'],
    executionProgress: (saved.execution_progress ?? null) as PlanningState['executionProgress'],
    planIds: record(saved.plan_ids) as PlanningState['planIds'],
  }
}

/** v2 goal state (already camelCase, with private `_` keys) → v3 `GoalState`. */
export function goalFromV2(saved: Row, runtimeId: string): GoalState | null {
  const sessionId = text(saved.sessionId)
  const runtime = text(saved.runtime)
  if (sessionId === null || runtime === null || saved._deleted === true) return null
  const capabilities = record(saved.capabilities)
  return {
    sessionId,
    runtime,
    runtimeId: text(saved.runtimeId) ?? runtimeId,
    externalSessionId: text(saved.externalSessionId),
    revision: typeof saved.revision === 'number' ? saved.revision : 0,
    bindingGeneration: typeof saved.bindingGeneration === 'number' ? saved.bindingGeneration : 0,
    sourceEpoch: text(saved.sourceEpoch) ?? '',
    freshness: 'unknown',
    capabilities: { supported: capabilities.supported === true, actions: Array.isArray(capabilities.actions) ? capabilities.actions : [] } as unknown as GoalState['capabilities'],
    goal: (saved.goal ?? null) as GoalState['goal'],
    lastOutcome: (saved.lastOutcome ?? null) as GoalState['lastOutcome'],
    pendingOperationId: null,
    nativeIdentity: text(saved.nativeIdentity) ?? text(saved._nativeIdentity),
  }
}

/**
 * A v2 ACP projection row → a v3 draft. v2 numbered items 1..n per session; they keep that order just below the
 * anchor live items count up from, so the next turn continues after them.
 */
function draftFromProjection(row: Row, count: number, at: string): TimelineDraft | null {
  const id = text(row.id)
  const type = row.type
  if (id === null || (type !== 'message' && type !== 'tool')) return null
  const order = typeof row.orderSeq === 'number' && Number.isInteger(row.orderSeq) && row.orderSeq > 0 ? Math.min(row.orderSeq, count) : count
  const source = record(row.source)
  return {
    id,
    type,
    status: (text(row.status) ?? 'done') as TimelineDraft['status'],
    role: (text(row.role) ?? null) as TimelineDraft['role'],
    orderSeq: orderSeqOf(ORDER_ANCHOR_INDEX - count - 1 + order),
    content: record(row.content) as TimelineDraft['content'],
    source: { runtime: text(source.runtime) ?? 'acp', ...(text(source.clientMessageId) !== null ? { clientMessageId: text(source.clientMessageId) } : {}) },
    createdAt: text(row.createdAt) ?? at,
  }
}

/**
 * Imports the v2 files of `connectorId` into `store` once. Sessions already in the v3 store keep their state
 * (nothing is overwritten); a v2 file that cannot be read is reported and skipped, never fatal.
 */
export async function importLegacyV2(store: ConversationStore, options: LegacyImportOptions): Promise<LegacyImportResult | null> {
  if ((await store.kv.get(LEGACY_IMPORT_KV.runtimeId, LEGACY_IMPORT_KV.key)) != null) return null
  const base = join(options.legacyRoot, options.connectorId)
  const problems: string[] = []
  let sessions = 0
  let items = 0
  let planning = 0
  let goals = 0
  const at = options.now()
  const ensureSession = async (input: { sessionId: string; runtimeType: string; runtimeId: string; externalSessionId: string | null; cwd: string | null }): Promise<boolean> => {
    const { created } = await store.sessions.create({ ...input, nativeTitle: null, status: 'idle', sourceAvailability: 'available', takeover: false, at })
    if (created) sessions++
    return created
  }
  for (const runtimeId of existsSync(base) ? directories(base) : []) {
    const dir = join(base, runtimeId)
    const fallbackType = options.runtimeTypeOf(runtimeId)
    // ACP: the sessions AA created (binding) and their projected timelines.
    for (const namespace of directories(join(dir, 'acp'))) {
      const path = join(dir, 'acp', namespace, 'coordination.sqlite')
      if (!existsSync(path)) continue
      try {
        const records = rows(path, "SELECT kind, id, body FROM records WHERE kind IN ('binding', 'projection')")
        const projection = new Map<string, Row[]>()
        for (const entry of records.filter(row => row.kind === 'projection')) {
          const body = parse(entry.body)
          const sessionId = text(body.sessionId)
          if (sessionId !== null) projection.set(sessionId, [...(projection.get(sessionId) ?? []), body])
        }
        for (const entry of records.filter(row => row.kind === 'binding')) {
          const binding = parse(entry.body)
          const sessionId = text(binding.session_id)
          const runtimeType = text(binding.profile_id) ?? fallbackType
          if (sessionId === null || runtimeType === null) continue
          const created = await ensureSession({ sessionId, runtimeType, runtimeId, externalSessionId: text(binding.agent_session_id), cwd: text(record(binding.workspace).canonical_path) ?? text(record(binding.workspace).registered_path) })
          const owned = projection.get(sessionId) ?? []
          if (!created || owned.length === 0) continue
          const drafts = owned.map(row => draftFromProjection(row, owned.length, at)).filter((draft): draft is TimelineDraft => draft !== null)
          if (drafts.length > 0) {
            await store.timeline.apply(sessionId, { upserts: drafts, at })
            items += drafts.length
          }
        }
      } catch (error) {
        problems.push(`${path}: ${(error as Error).message}`)
      }
    }
    // Planning: state and every immutable document revision.
    const planningPath = join(dir, 'planning.sqlite3')
    if (existsSync(planningPath)) {
      try {
        const documents = rows(planningPath, 'SELECT session_id, plan_id, revision, payload FROM planning_document')
        for (const row of rows(planningPath, 'SELECT session_id, payload FROM planning_state')) {
          const state = planningFromV2(parse(row.payload))
          if (state === null || (await store.planning.load(state.sessionId)) !== null) continue
          await ensureSession({ sessionId: state.sessionId, runtimeType: state.runtime, runtimeId, externalSessionId: text(parse(row.payload).external_session_id), cwd: null })
          const own = documents.filter(document => document.session_id === state.sessionId).map(document => parse(document.payload) as unknown as PlanDocument)
          if (own.length === 0) await store.planning.save(state, null)
          for (const document of own) await store.planning.save(state, document)
          planning++
        }
      } catch (error) {
        problems.push(`${planningPath}: ${(error as Error).message}`)
      }
    }
    // Goals.
    const goalPath = join(dir, 'goal.sqlite3')
    if (existsSync(goalPath)) {
      try {
        for (const row of rows(goalPath, 'SELECT session_id, payload FROM goal_state')) {
          const state = goalFromV2(parse(row.payload), runtimeId)
          if (state === null || (await store.goals.load(state.sessionId)) !== null) continue
          await ensureSession({ sessionId: state.sessionId, runtimeType: state.runtime, runtimeId, externalSessionId: state.externalSessionId, cwd: null })
          await store.goals.save(state)
          goals++
        }
      } catch (error) {
        problems.push(`${goalPath}: ${(error as Error).message}`)
      }
    }
  }
  const result = { sessions, items, planning, goals, problems }
  await store.kv.set(LEGACY_IMPORT_KV.runtimeId, LEGACY_IMPORT_KV.key, { at, sessions, items, planning, goals, problems: problems.length })
  if (sessions + planning + goals > 0) options.log('info', `imported from v2: ${sessions} sessions, ${items} timeline items, ${planning} plans, ${goals} goals`)
  for (const problem of problems) options.log('warn', `v2 import skipped ${problem}`)
  return result
}
