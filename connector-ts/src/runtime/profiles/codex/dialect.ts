// Codex 方言：驱动 anywhere-labs/codex-acp（04 §5.2，S1 实测结论）。
//
// - codexIpc 协商：审批、设置跟随 Codex App；历史整体替换（App 里回滚、压缩后）按 `_codex/session/history_reset`
//   begin → 全量重放 → commit / abort 进行，期间的更新按历史重放翻译、条目位置从头数。
// - 打开已有会话用 `codexIpc.mode: auto`：Codex App 正持有这个会话时跟随它，否则直接打开。
// - 每条用户消息带 `codexIpc.clientMessageId`，Codex 记进 ThreadItem.clientId，实时和历史都能认回 AA 的消息。
// - 条目 ID 沿用 v2 规则（identity.ts），依赖客户端声明 `_meta.codexItemContext`（codex-acp#6）。
// - 不声明 AIR：codex-acp 对 AIR 客户端改用另一套工具调用上报形状。`_session/goal` 不依赖 AIR 声明。
// - 计划审阅：计划完成后 codex-acp 发 request_permission（`plan-review:<itemId>`，implement_plan / revise_plan）。
//   拒绝会结束当前回合并留在计划模式，所以修改意见在回合结束后作为新消息发出。

import type { ConfigOption, HistoryItem, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { codexModelSelectionId } from '../../../domain/identity/index.js'
import { negotiatedCapabilities } from '../../acp/capabilities.js'
import { asRecord, type JsonRecord } from '../../acp/client.js'
import type { AcpDialect, PlanReviewDecision } from '../../acp/dialect.js'
import { translateUpdate } from '../../acp/mapping.js'
import { historyPage } from '../../companions/native-history/page.js'
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
  // 暂不执行：留在计划模式，回合随拒绝结束。
  return revise !== undefined ? { optionId: revise } : {}
}

const HISTORY_EVENTS = new Set<RuntimeEvent['type']>(['message.delta', 'message.completed', 'tool.started', 'tool.updated', 'notice'])

export function codexDialect(): AcpDialect {
  return {
    runtime: 'codex',
    clientCapabilities: () => ({ ...structuredClone(GENERIC_CLIENT_CAPABILITIES), _meta: { codexItemContext: true } }),
    initializeMeta: () => ({ codexIpc: { approvals: true, settings: true, historyReplacement: true } }),
    capabilities: info => [
      ...negotiatedCapabilities(info, { steer: asRecord(info.meta.steering).supported === true, permissionCatalog: true }),
      { id: 'session.planning', supported: true },
      { id: 'session.plan_document', supported: true },
      { id: 'session.plan_review', supported: true },
      { id: 'session.goal', supported: true, parameters: { actions: ['set', 'pause', 'resume', 'clear'] } },
      { id: 'catalog.model', supported: true },
    ],
    identity: codexIdentity,
    openParams: () => ({ _meta: { codexIpc: { mode: 'auto' } } }),
    promptParams: delivery => ({ _meta: { codexIpc: { clientMessageId: delivery.clientMessageId } } }),
    steer: 'extension',
    selections: {
      modelSelectionId: codexModelSelectionId,
      permissionSelectionId: codexPermissionSelectionForMode,
    },
    // codex-acp 的 `mode` 是审批与沙箱预设，即 AA 的权限；计划模式在 `collaboration_mode` 上。
    adaptConfig: options => options.map((option): ConfigOption => (option.id === 'mode' && option.category === 'mode' ? { ...option, category: 'permission' } : option)),
    planMode: options => (options.some(o => o.id === 'collaboration_mode') ? { optionId: 'collaboration_mode', planValue: 'plan', normalValue: 'default' } : undefined),
    interactionKind: (method, params) => (method === 'session/request_permission' && isPlanReview(params) ? 'plan_review' : undefined),
    planReview: (answer, options) => codexPlanReview(answer, options),
    goalMethod: () => CODEX_GOAL_METHOD,
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
    // 只读历史：`_codex/session/read` 直接读 Codex 的线程记录，不打开会话、不抢写锁。
    readNativeHistory: async (ref, window, connection) => {
      const { client, info } = await connection()
      const response = asRecord(await client.request(CODEX_SESSION_READ, { sessionId: ref.nativeSessionId }, { timeoutMs: 120_000 }))
      const updates = Array.isArray(response.updates) ? response.updates.map(asRecord) : []
      const identity = codexIdentity({ sessionId: `history:${ref.nativeSessionId}`, nativeSessionId: ref.nativeSessionId, epoch: 'history', info })
      const items: HistoryItem[] = []
      for (const update of updates) {
        for (const event of translateUpdate(update, { identity, replay: true, suppressUserEcho: false, config: [] })) {
          if (HISTORY_EVENTS.has(event.type)) items.push(event as HistoryItem)
        }
      }
      return historyPage(items, window)
    },
  }
}
