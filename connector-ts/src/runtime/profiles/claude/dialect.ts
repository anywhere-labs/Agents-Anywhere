// Claude 方言：驱动 @agentclientprotocol/claude-agent-acp（04 §5.3，S2 实测结论）。
//
// - AIR 扩展：只声明 AA 能处理的 `sessionFailure`（模型重试 / 会话错误提示）。声明 AIR 之后适配器才提供
//   `_session/goal`（目标，对等矩阵要求）。不声明 asyncTasks、nativeSubagentSessions、diffPatch、
//   rawInputRendering 等会改变工具输出形状的能力。
// - 计划审阅：ExitPlanMode 以 request_permission 到达，计划正文在 `toolCall.rawInput.plan`。
// - 自主回合（/loop、定时唤醒）：没有开始和结束标记，开始靠回合外的内容，结束看带 cost 的 usage_update。

import type { ConfigOption, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { claudeModelSelectionId, claudePermissionSelectionId, claudeStableId } from '../../../domain/identity/index.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../acp/client.js'
import type { AcpDialect, PlanReviewDecision } from '../../acp/dialect.js'
import { findClaudeTranscript, historyPage, readClaudeTranscript } from '../../companions/native-history/claude-jsonl.js'
import { GENERIC_CLIENT_CAPABILITIES } from '../generic/dialect.js'
import { claudeIdentity } from './identity.js'

export const CLAUDE_AIR_CAPABILITIES = ['sessionFailure'] as const

/** 批准计划后回到哪个权限模式 → ExitPlanMode 的选项（claude-agent-acp permissions/effects.js）。 */
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
    // v2 claude/planning.py：批准后回到进入计划前的权限模式，没有记录时回到 default。从不选「清空上下文」的选项。
    const wanted = EXIT_PLAN_OPTION[modeBeforePlan ?? 'default'] ?? EXIT_PLAN_OPTION.default!
    const optionId = ids.includes(wanted) ? wanted : ids.includes(EXIT_PLAN_OPTION.default!) ? EXIT_PLAN_OPTION.default : options.find(o => o.kind === 'allow_once')?.optionId as string | undefined
    return optionId !== undefined ? { optionId } : {}
  }
  if (answer.action === 'revise') {
    // 拒绝计划会结束当前回合；意见在回合结束后作为新消息发出（S2：steer 进当前回合会被一起取消）。
    return { ...(reject !== undefined ? { optionId: reject } : {}), ...(answer.feedback ? { then: { action: 'prompt', text: answer.feedback } } : {}) }
  }
  return { ...(reject !== undefined ? { optionId: reject } : {}), then: { action: 'cancel' } }
}

/** AIR sessionFailure → AA 提示。回合内的警告就是 v2 的「模型请求重试」（同一回合一个条目，ID 规则同 v2）。 */
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
        { id: 'session.planning', supported: true },
        { id: 'session.plan_document', supported: true },
        { id: 'session.plan_review', supported: true },
        { id: 'session.goal', supported: goal, ...(goal ? { parameters: { actions: (asRecord(air(info).goal).actions ?? ['set', 'clear']) as string[] } } : {}) },
        { id: 'catalog.model', supported: true },
      ]
    },
    identity: claudeIdentity,
    steer: 'extension',
    selections: {
      modelSelectionId: claudeModelSelectionId,
      permissionSelectionId: claudePermissionSelectionId,
      hiddenEfforts: ['default'],
    },
    // claude-agent-acp 的 `mode` 就是 Claude Code 的权限模式（含 plan）。
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
    // 只读历史：直接读 JSONL，不经 session/load（它会往 JSONL 追加记录）。
    readNativeHistory: async (ref, window) => {
      const file = await findClaudeTranscript(ref.nativeSessionId)
      if (file === undefined) return { items: [] }
      return historyPage(await readClaudeTranscript(file, { sessionId: ref.nativeSessionId, externalSessionId: ref.nativeSessionId }), window)
    },
    endsAutonomousTurn: update => update.sessionUpdate === 'usage_update' && update.cost !== undefined && update.cost !== null,
  }
}
