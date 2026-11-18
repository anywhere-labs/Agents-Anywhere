// Codex dialect: drives anywhere-labs/codex-acp (04 §5.2, findings from spike S1).
//
// - codexIpc negotiation: approvals and settings follow the Codex App. A whole-history replacement (after a
//   rollback or compaction in the App) runs as `_codex/session/history_reset` begin -> full replay -> commit /
//   abort; updates in between are translated as history replay, with item positions counted from the start.
// - Existing sessions are opened with `codexIpc.mode: auto`: follow the Codex App when it holds the session,
//   otherwise open it directly.
// - Every user message carries `codexIpc.clientMessageId`, which Codex stores in ThreadItem.clientId, so AA's
//   messages are recognised both live and in history.
// - Item IDs follow the rules in identity.ts and depend on the client declaring `_meta.codexItemContext`
//   (codex-acp#6).
// - Goal snapshots use the standalone capability: declaring AIR changes the tool-call format.
// - Attachments: local files (images included) are always passed by path (resource_link + MIME), never read into
//   a data URL: data URLs are written into the rollout, bloat the file and affect history rendering in the App.
//   codex-acp currently turns resource_link into a text link; for the model to see images directly, codex-acp has
//   to turn `image/*` `file://` resource_links into native `localImage` (see the Codex companion PR).
// - The open route and sidebar announcement are controlled by the Codex companion layer
//   (runtime/companions/codex) through CodexDialectOptions.
// - Plan review: when a plan is complete codex-acp sends request_permission (`plan-review:<itemId>`,
//   implement_plan / revise_plan). Rejecting ends the current turn and stays in plan mode, so revision feedback
//   is sent as a new message after the turn ends.
// - Automatic approval reviews (`guardian_assessment:` tool calls) become timeline notices (auto-review.ts).

import type { ConfigOption, HistoryItem, NativeSessionRef, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { GOAL_ACTIONS } from '../../../domain/goals/index.js'
import { codexModelSelectionId } from '../../../domain/identity/index.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../acp/client.js'
import type { AcpDialect, PlanReviewDecision } from '../../acp/dialect.js'
import { parseGoalObservation } from '../../acp/goal.js'
import { translateUpdate } from '../../acp/mapping.js'
import { historyPage } from '../../companions/native-history/page.js'
import { guardianReviewEvents } from './auto-review.js'
import { GENERIC_CLIENT_CAPABILITIES } from '../generic/dialect.js'
import { codexIdentity } from './identity.js'
import { codexPermissionSelectionForMode } from './permissions.js'

export const CODEX_HISTORY_RESET = '_codex/session/history_reset'
export const CODEX_SESSION_READ = '_codex/session/read'
export const CODEX_GOAL_METHOD = '_session/goal'

const IMPLEMENT_PLAN = 'implement_plan'
const REVISE_PLAN = 'revise_plan'

function isPlanReview(params: JsonRecord): boolean {
  const toolCall = asRecord(params.toolCall)
  return String(toolCall.toolCallId ?? '').startsWith('plan-review:')
    || (Array.isArray(params.options) && params.options.some(o => asRecord(o).optionId === IMPLEMENT_PLAN))
}

export function codexPlanReview(answer: { action: 'approve' | 'revise' | 'dismiss'; feedback?: string }, options: readonly JsonRecord[]): PlanReviewDecision {
  const ids = options.map(o => String(o.optionId))
  const implement = ids.includes(IMPLEMENT_PLAN) ? IMPLEMENT_PLAN : options.find(o => o.kind === 'allow_once')?.optionId as string | undefined
  const revise = ids.includes(REVISE_PLAN) ? REVISE_PLAN : options.find(o => o.kind === 'reject_once')?.optionId as string | undefined
  if (answer.action === 'approve') return implement !== undefined ? { optionId: implement } : {}
  if (answer.action === 'revise') {
    return { ...(revise !== undefined ? { optionId: revise } : {}), ...(answer.feedback ? { then: { action: 'prompt', text: answer.feedback } } : {}) }
  }
  // Not now: stay in plan mode; the turn ends with the rejection.
  return revise !== undefined ? { optionId: revise } : {}
}

/**
 * Whether codex-acp turns `image/*` `file://` resource_links into Codex-native `localImage` (top-level
 * `_meta.localImageLinks.supported` in initialize, anywhere-labs/codex-acp#9; applies to all three routes).
 * Without it the model only sees the path text, so the image attachment capability is reported as unsupported
 * and clients hide the entry point. AA never falls back to data URLs (they are written into the rollout and
 * bloat the file).
 */
export function codexLocalImageLinks(info: AgentInfo): boolean {
  return asRecord(info.meta.localImageLinks).supported === true
}

function codexGoalSnapshots(info: AgentInfo) {
  const goal = asRecord(info.meta.goal)
  if (goal.version !== 1 || goal.controlMethod !== CODEX_GOAL_METHOD || goal.read !== 'get' || !Array.isArray(goal.actions)) return undefined
  const available = goal.actions
  const actions = GOAL_ACTIONS.filter(action => available.includes(action) || (action === 'edit' && available.includes('set')))
  return actions.length === 0 ? undefined : { method: CODEX_GOAL_METHOD, actions }
}

const HISTORY_EVENTS = new Set<RuntimeEvent['type']>(['message.delta', 'message.completed', 'tool.started', 'tool.updated', 'notice'])

export interface CodexDialectOptions {
  /**
   * Route for opening an existing thread: `auto` by default; `plain` sends no codexIpc (when the write lock is
   * unknown on Windows, the companion layer lets Codex arbitrate the write lock itself).
   */
  readonly openRoute?: (ref: NativeSessionRef) => 'auto' | 'plain'
  /**
   * Ask codex-acp to announce threads created by AA to the Codex App so they appear in its sidebar right away
   * (`codexIpc.announceNewThreads`; requires codex-acp support, older codex-acp ignores it). The Codex profile turns
   * it on unless the instance switches it off; threads that appear this way are not put into a project group.
   */
  readonly announceNewThreads?: boolean
}

export function codexDialect(options: CodexDialectOptions = {}): AcpDialect {
  return {
    runtime: 'codex',
    clientCapabilities: () => ({ ...structuredClone(GENERIC_CLIENT_CAPABILITIES), _meta: { codexItemContext: true, goal: { version: 1 } } }),
    initializeMeta: () => ({ codexIpc: { approvals: true, settings: true, historyReplacement: true, ...(options.announceNewThreads === true ? { announceNewThreads: true } : {}) } }),
    capabilities: info => {
      const goal = codexGoalSnapshots(info)
      return [
        ...negotiatedCapabilities(info, { steer: asRecord(info.meta.steering).supported === true, permissionCatalog: true })
          .map(capability => (capability.id === 'runtime.attachment' && !codexLocalImageLinks(info) ? { id: capability.id, supported: false } : capability)),
        { id: 'session.planning', supported: true, parameters: { preparedCreation: true } },
        { id: 'session.plan_document', supported: true },
        { id: 'session.plan_review', supported: true },
        { id: 'session.goal', supported: goal !== undefined, ...(goal === undefined ? {} : { parameters: { actions: goal.actions } }) },
        { id: 'catalog.model', supported: true },
      ]
    },
    identity: codexIdentity,
    openParams: ref => (options.openRoute?.(ref) === 'plain' ? {} : { _meta: { codexIpc: { mode: 'auto' } } }),
    promptParams: delivery => ({ _meta: { codexIpc: { clientMessageId: delivery.clientMessageId } } }),
    steer: 'extension',
    selections: {
      modelSelectionId: codexModelSelectionId,
      permissionSelectionId: codexPermissionSelectionForMode,
    },
    // codex-acp's `mode` is the approval and sandbox preset, i.e. AA's permission; plan mode is on `collaboration_mode`.
    adaptConfig: options => options.map((option): ConfigOption => (option.id === 'mode' && option.category === 'mode' ? { ...option, category: 'permission' } : option)),
    planMode: options => (options.some(o => o.id === 'collaboration_mode') ? { optionId: 'collaboration_mode', planValue: 'plan', normalValue: 'default' } : undefined),
    interactionKind: (method, params) => (method === 'session/request_permission' && isPlanReview(params) ? 'plan_review' : undefined),
    planReview: (answer, options) => codexPlanReview(answer, options),
    goalSnapshots: codexGoalSnapshots,
    translateUpdate: (update, context, turn) => {
      if (update.sessionUpdate === 'session_info_update') {
        const negotiated = codexGoalSnapshots(context.info)
        const goal = asRecord(update._meta).goal
        const observation = negotiated === undefined ? null : parseGoalObservation(goal, negotiated.actions, true)
        if (observation !== null) {
          const title = typeof update.title === 'string' ? [{ ...turn, type: 'session.info' as const, title: update.title }] : []
          return [...title, { ...turn, type: 'goal.updated', observation }]
        }
      }
      return guardianReviewEvents(update, context.nativeSessionId, turn)
    },
    handleRequest: (method, params, session) => {
      if (method !== CODEX_HISTORY_RESET || params.phase !== 'begin' || typeof params.revision !== 'string') return undefined
      const revision = params.revision
      session.emit({ type: 'history.reset', phase: 'begin', revision })
      session.beginReplay()
      return Promise.resolve({ revision, ready: true })
    },
    notificationMethods: [CODEX_HISTORY_RESET],
    onNotification: (method, params, session) => {
      if (method !== CODEX_HISTORY_RESET || typeof params.revision !== 'string') return
      if (params.phase !== 'commit' && params.phase !== 'abort') return
      session.endReplay()
      session.emit({ type: 'history.reset', phase: params.phase, revision: params.revision })
    },
    // Read-only history: `_codex/session/read` reads Codex's thread records directly, without opening the session
    // or taking the write lock.
    readNativeHistory: async (ref, window, connection) => {
      const { client, info } = await connection()
      const response = asRecord(await client.request(CODEX_SESSION_READ, { sessionId: ref.nativeSessionId }, { timeoutMs: 120_000 }))
      const updates = Array.isArray(response.updates) ? response.updates.map(asRecord) : []
      const identity = codexIdentity({ sessionId: `history:${ref.nativeSessionId}`, nativeSessionId: ref.nativeSessionId, epoch: 'history', info })
      const items: HistoryItem[] = []
      for (const update of updates) {
        const events = guardianReviewEvents(update, ref.nativeSessionId, { replay: true }) ?? translateUpdate(update, { identity, replay: true, suppressUserEcho: false, config: [] })
        for (const event of events) {
          if (HISTORY_EVENTS.has(event.type)) items.push(event as HistoryItem)
        }
      }
      return historyPage(items, window)
    },
  }
}
