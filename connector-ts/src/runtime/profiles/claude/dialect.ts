// Claude dialect: drives @agentclientprotocol/claude-agent-acp (04 §5.3, findings from spike S2).
//
// - AIR extension: declares only `sessionFailure` (model retry / session error notices), which AA can handle.
//   The adapter offers `_session/goal` (goals, required by the parity matrix) only once AIR is declared. Capabilities
//   that change the shape of tool output (asyncTasks, nativeSubagentSessions, diffPatch, rawInputRendering, ...)
//   are not declared.
// - Plan review: ExitPlanMode arrives as request_permission; the plan text is in `toolCall.rawInput.plan`.
// - Autonomous turns (/loop, scheduled wakeups) have no start or end markers: a turn starts with content outside
//   a turn and ends with a usage_update that carries a cost.

import type { ConfigOption, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { claudeModelSelectionId, claudePermissionSelectionId, claudeStableId } from '../../../domain/identity/index.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../acp/client.js'
import type { AcpDialect, PlanReviewDecision } from '../../acp/dialect.js'
import { findClaudeTranscript, historyPage, readClaudeTranscript } from '../../companions/native-history/claude-jsonl.js'
import { GENERIC_CLIENT_CAPABILITIES } from '../generic/dialect.js'
import { claudeIdentity } from './identity.js'

export const CLAUDE_AIR_CAPABILITIES = ['sessionFailure'] as const

/** Permission mode to return to after a plan is approved -> ExitPlanMode option (claude-agent-acp permissions/effects.js). */
const EXIT_PLAN_OPTION: Readonly<Record<string, string>> = {
  default: 'exit-plan-default',
  acceptEdits: 'exit-plan-accept-edits',
  auto: 'exit-plan-auto',
  bypassPermissions: 'exit-plan-bypass',
}

function air(info: AgentInfo): JsonRecord {
  return asRecord(asRecord(info.meta.jetbrains).air)
}

export function goalControlMethod(info: AgentInfo): string | undefined {
  const goal = asRecord(air(info).goal)
  return typeof goal.controlMethod === 'string' ? goal.controlMethod : undefined
}

function isExitPlan(params: JsonRecord): boolean {
  const toolCall = asRecord(params.toolCall)
  if (typeof asRecord(toolCall.rawInput).plan === 'string') return true
  return Array.isArray(params.options) && params.options.some(o => String(asRecord(o).optionId ?? '').startsWith('exit-plan-'))
}

export function claudePlanReview(answer: { action: 'approve' | 'revise' | 'dismiss'; feedback?: string }, options: readonly JsonRecord[], modeBeforePlan?: string): PlanReviewDecision {
  const ids = options.map(o => String(o.optionId))
  const reject = ids.includes('reject') ? 'reject' : options.find(o => o.kind === 'reject_once')?.optionId as string | undefined
  if (answer.action === 'approve') {
    // Approval returns to the permission mode in effect before planning, or `default` when none was recorded.
    // The "clear context" option is never chosen.
    const wanted = EXIT_PLAN_OPTION[modeBeforePlan ?? 'default'] ?? EXIT_PLAN_OPTION.default!
    const optionId = ids.includes(wanted) ? wanted : ids.includes(EXIT_PLAN_OPTION.default!) ? EXIT_PLAN_OPTION.default : options.find(o => o.kind === 'allow_once')?.optionId as string | undefined
    return optionId !== undefined ? { optionId } : {}
  }
  if (answer.action === 'revise') {
    // Rejecting the plan ends the current turn; the feedback is sent as a new message after the turn ends
    // (S2: steering it into the current turn gets cancelled along with the turn).
    return { ...(reject !== undefined ? { optionId: reject } : {}), ...(answer.feedback ? { then: { action: 'prompt', text: answer.feedback } } : {}) }
  }
  return { ...(reject !== undefined ? { optionId: reject } : {}), then: { action: 'cancel' } }
}

/** AIR sessionFailure -> AA notice. A warning inside a turn is a model request retry (one item per turn). */
function failureNotice(update: JsonRecord, sessionId: string, turnId: string | undefined): RuntimeEvent | undefined {
  const failure = asRecord(asRecord(asRecord(asRecord(update._meta).jetbrains).air).sessionFailure)
  if (typeof failure.title !== 'string') return undefined
  const severity = String(failure.severity ?? 'error')
  const retry = severity === 'warning' && turnId !== undefined
  const itemId = retry ? claudeStableId('api-retry', sessionId, turnId) : claudeStableId('session-failure', sessionId, String(failure.id ?? failure.title))
  return {
    type: 'notice',
    ...(turnId !== undefined ? { turnId } : {}),
    itemId,
    level: severity === 'warning' ? 'warning' : severity === 'info' ? 'info' : 'error',
    kind: retry ? 'model_request_retry' : severity === 'warning' ? 'warning' : 'error',
    text: failure.title,
    data: {
      ...(typeof failure.details === 'string' ? { details: failure.details } : {}),
      ...(typeof failure.category === 'string' ? { category: failure.category } : {}),
      ...(typeof failure.reason === 'string' ? { reason: failure.reason } : {}),
      ...(Array.isArray(failure.actions) ? { actions: failure.actions.filter((a): a is string => typeof a === 'string') } : {}),
      ...(typeof failure.revision === 'number' ? { revision: failure.revision } : {}),
    },
  }
}

export function claudeDialect(): AcpDialect {
  return {
    runtime: 'claude',
    clientCapabilities: () => ({
      ...structuredClone(GENERIC_CLIENT_CAPABILITIES),
      _meta: { jetbrains: { air: { version: 1, capabilities: [...CLAUDE_AIR_CAPABILITIES] } } },
    }),
    capabilities: info => {
      const goal = goalControlMethod(info) !== undefined
      return [
        ...negotiatedCapabilities(info, { steer: asRecord(info.meta.steering).supported === true, permissionCatalog: true }),
        { id: 'session.planning', supported: true, parameters: { preparedCreation: true } },
        { id: 'session.plan_document', supported: true },
        { id: 'session.plan_review', supported: true },
        { id: 'session.goal', supported: goal, ...(goal ? { parameters: { actions: (asRecord(air(info).goal).actions ?? ['set', 'clear']) as string[] } } : {}) },
        { id: 'catalog.model', supported: true },
      ]
    },
    identity: claudeIdentity,
    agentTools: true,
    // claude-agent-acp: tools of the listed MCP servers run without a permission request.
    toolServerParams: servers => {
      const allowed = servers.filter(server => server.autoApprove).map(server => `mcp__${server.name}`)
      return allowed.length === 0 ? {} : { _meta: { claudeCode: { options: { allowedTools: allowed } } } }
    },
    steer: 'extension',
    selections: {
      modelSelectionId: claudeModelSelectionId,
      permissionSelectionId: claudePermissionSelectionId,
      hiddenEfforts: ['default'],
    },
    // claude-agent-acp's `mode` is Claude Code's permission mode (including plan).
    adaptConfig: options => options.map((option): ConfigOption => (option.id === 'mode' && option.category === 'mode' ? { ...option, category: 'permission' } : option)),
    planMode: options => (options.some(o => o.id === 'mode') ? { optionId: 'mode', planValue: 'plan' } : undefined),
    interactionKind: (method, params) => (method === 'session/request_permission' && isExitPlan(params) ? 'plan_review' : undefined),
    planReview: (answer, options, context) => claudePlanReview(answer, options, context.modeBeforePlan),
    goalMethod: goalControlMethod,
    translateUpdate: (update, context, turn) => {
      if (update.sessionUpdate !== 'session_info_update') return undefined
      const notice = failureNotice(update, context.sessionId, turn.turnId)
      if (notice === undefined) return undefined
      const info: RuntimeEvent[] = typeof update.title === 'string' || typeof update.updatedAt === 'string'
        ? [{
            type: 'session.info',
            ...(turn.turnId ? { turnId: turn.turnId } : {}),
            ...(typeof update.title === 'string' ? { title: update.title } : {}),
            ...(typeof update.updatedAt === 'string' ? { updatedAt: update.updatedAt } : {}),
          }]
        : []
      return [notice, ...info]
    },
    // Read-only history: read the JSONL directly instead of session/load, which appends records to the JSONL.
    readNativeHistory: async (ref, window) => {
      const file = await findClaudeTranscript(ref.nativeSessionId)
      if (file === undefined) return { items: [] }
      return historyPage(await readClaudeTranscript(file, { sessionId: ref.nativeSessionId, externalSessionId: ref.nativeSessionId }), window)
    },
    endsAutonomousTurn: update => update.sessionUpdate === 'usage_update' && update.cost !== undefined && update.cost !== null,
  }
}
