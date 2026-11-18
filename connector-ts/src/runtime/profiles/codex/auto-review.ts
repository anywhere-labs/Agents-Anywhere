// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/timeline/auto_review.py @98dd0e6e5 (auto_review_content, action_summary)
//
// Codex automatic approval reviews as timeline notices. codex-acp reports each review as a tool call
// `guardian_assessment:<reviewId>` whose rawInput (first report) or rawOutput (later reports) is the whole Codex
// event: `{reviewId, targetItemId?, review: {status, riskLevel, userAuthorization, rationale}, action}`. The notice
// names the outcome and the reviewed action, is a warning when the review denied the action or timed out, and calls
// out a denied high or critical risk action; the review fields travel in its data.

import type { JsonObject, RuntimeEvent } from '../../../application/ports/runtime-session.js'
import { sha256Hex } from '../../../domain/identity/hash.js'
import type { JsonValue } from '../../../domain/identity/index.js'
import { asRecord, type JsonRecord } from '../../acp/client.js'

export const GUARDIAN_REVIEW_PREFIX = 'guardian_assessment:'

const LABEL_LIMIT = 160
const REVIEW_FIELDS = ['status', 'riskLevel', 'userAuthorization', 'rationale'] as const
const TITLE_BY_STATUS: Readonly<Record<string, string>> = {
  inProgress: '自动审查中',
  approved: '自动审查已批准',
  denied: '自动审查已拒绝',
  timedOut: '自动审查超时',
  aborted: '自动审查已中止',
}
const HIGH_RISK_LEVELS = new Set(['high', 'critical'])
const WARNING_STATUSES = new Set(['denied', 'timedOut'])

function str(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function basename(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/+$/u, '').split('/').pop() || path
}

function truncate(value: string): string {
  const line = value.split(/\s+/u).filter(part => part !== '').join(' ')
  return line.length <= LABEL_LIMIT ? line : `${line.slice(0, LABEL_LIMIT - 1)}…`
}

/** A short Chinese description of the reviewed action; undefined for an action type it does not know. */
export function reviewActionSummary(action: JsonRecord): string | undefined {
  const type = str(action, 'type')
  if (type === 'command') {
    const command = str(action, 'command')
    return command ? `运行 ${command}` : '运行命令'
  }
  if (type === 'execve') {
    const argv = Array.isArray(action.argv) ? action.argv.filter((part): part is string => typeof part === 'string' && part !== '') : []
    const command = argv.join(' ') || str(action, 'program')
    return command ? `运行 ${command}` : '运行命令'
  }
  if (type === 'writeStdin' || type === 'write_stdin') {
    const processId = str(action, 'processId', 'process_id')
    return processId ? `向进程 ${processId} 发送输入` : '向进程发送输入'
  }
  if (type === 'applyPatch' || type === 'apply_patch') {
    const files = Array.isArray(action.files) ? action.files.filter((path): path is string => typeof path === 'string' && path !== '') : []
    if (files.length === 1) return `编辑 ${basename(files[0]!)}`
    return files.length > 0 ? `编辑 ${files.length} 个文件` : '编辑文件'
  }
  if (type === 'networkAccess' || type === 'network_access') {
    const target = str(action, 'target', 'host')
    return target ? `访问网络 ${target}` : '访问网络'
  }
  if (type === 'mcpToolCall' || type === 'mcp_tool_call') {
    const tool = str(action, 'toolTitle', 'tool_title', 'toolName', 'tool_name')
    const connector = str(action, 'connectorName', 'connector_name', 'server')
    const name = tool ? `MCP 工具 ${tool}` : 'MCP 工具'
    return connector ? `调用 ${name}（${connector}）` : `调用 ${name}`
  }
  if (type === 'requestPermissions' || type === 'request_permissions') {
    const reason = str(action, 'reason')
    return reason ? `申请权限：${reason}` : '申请权限'
  }
  return undefined
}

/** The Codex review event a guardian tool call update carries, or undefined when it carries none. */
function reviewEvent(update: JsonRecord): JsonRecord | undefined {
  for (const candidate of [update.rawOutput, update.rawInput]) {
    const event = asRecord(candidate)
    if (typeof asRecord(event.review).status === 'string') return event
  }
  return undefined
}

/** Timeline item id of a review: stable per thread and review, live and in history. */
export function reviewItemId(nativeSessionId: string, reviewId: string): string {
  return `codex_review_${sha256Hex(`codex-guardian-review-v1\0${nativeSessionId}\0${reviewId}`).slice(0, 32)}`
}

/**
 * The notice for a guardian review tool call update; undefined for any other update (the generic translation
 * applies) or a review report without the Codex event.
 */
export function guardianReviewEvents(update: JsonRecord, nativeSessionId: string, base: { readonly turnId?: string; readonly replay?: boolean }): RuntimeEvent[] | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return undefined
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
  if (!toolCallId.startsWith(GUARDIAN_REVIEW_PREFIX)) return undefined
  const event = reviewEvent(update)
  if (event === undefined) return undefined
  const fields = asRecord(event.review)
  const status = str(fields, 'status') ?? 'inProgress'
  const risk = str(fields, 'riskLevel')
  const action = asRecord(event.action)
  const summary = reviewActionSummary(action)
  const title = status === 'denied' && risk !== undefined && HIGH_RISK_LEVELS.has(risk) ? '自动审查已拒绝高风险操作' : TITLE_BY_STATUS[status] ?? '自动审查'
  const review: Record<string, JsonValue> = {}
  for (const key of REVIEW_FIELDS) if (fields[key] !== undefined && fields[key] !== null) review[key] = fields[key] as JsonValue
  const targetItemId = str(event, 'targetItemId', 'target_item_id')
  const data: JsonObject = {
    review,
    ...(Object.keys(action).length > 0 ? { action: action as JsonValue } : {}),
    ...(targetItemId !== undefined ? { targetItemId } : {}),
    ...(risk !== undefined && HIGH_RISK_LEVELS.has(risk) ? { highRisk: true } : {}),
  }
  const warning = WARNING_STATUSES.has(status)
  return [{
    ...(base.turnId !== undefined ? { turnId: base.turnId } : {}),
    ...(base.replay ? { replay: true } : {}),
    type: 'notice',
    itemId: reviewItemId(nativeSessionId, toolCallId.slice(GUARDIAN_REVIEW_PREFIX.length)),
    level: warning ? 'warning' : 'info',
    kind: warning ? 'warning' : 'other',
    text: truncate(summary ? `${title}：${summary}` : title),
    data,
  }]
}
