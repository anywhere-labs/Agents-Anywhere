import { sha256Hex } from './hash.js'
import type { JsonValue } from './python-json.js'
import { isNonEmptyString, pyGet, pyOr, pyStr, type JsonObject } from './python-values.js'
import { pythonIsAlnum } from './unicode.js'

/** codex-client-message-v1: a user message bound to an AA client message id. */
export function codexClientMessageItemId(externalSessionId: string, clientMessageId: string): string {
  const identity = `codex-client-message-v1\0${externalSessionId}\0${clientMessageId}`
  return `codex_item_${sha256Hex(identity).slice(0, 32)}`
}

/** codex-turn-item-v2: thread + turn + lane + position within the lane. */
export function codexTurnPositionItemId(
  externalSessionId: string,
  turnId: string,
  position: number,
  lane = 'assistant-message',
): string {
  const identity = `codex-turn-item-v2\0${externalSessionId}\0${turnId}\0${lane}\0${pyStr(position)}`
  return `codex_item_${sha256Hex(identity).slice(0, 32)}`
}

/** Position lane shared by live events and thread history. */
export function codexTurnItemLane(rawType: string, role: string | null): string {
  if (role === 'user') return 'user-message'
  if (role === 'assistant' && (rawType === 'agentMessage' || rawType === 'message')) return 'assistant-message'
  if (rawType === 'reasoning') return 'reasoning'
  if (role === 'tool') return `tool:${rawType}`
  if (role === 'system') return `system:${rawType}`
  return `${role || 'item'}:${rawType}`
}

/** Turn-local position; 'reasoning' shares the current assistant-message slot without advancing it. */
export function codexNextTurnLanePosition(nextPositionByLane: Map<string, number>, lane: string): number {
  if (lane === 'reasoning') return nextPositionByLane.get('assistant-message') ?? 0
  const position = nextPositionByLane.get(lane) ?? 0
  nextPositionByLane.set(lane, position + 1)
  return position
}

const NON_POSITIONAL_TYPES = new Set(['contextCompaction', 'runtimeMessage', 'turnEnd', 'turnStart'])

export function codexUsesTurnPositionIdentity(rawType: string, _role: string | null): boolean {
  return !NON_POSITIONAL_TYPES.has(rawType)
}

const USER_MESSAGE_TYPES = new Set(['userMessage', 'steeringUserMessage'])

export function codexIsUserMessage(rawType: string, role: string | null): boolean {
  return role === 'user' || USER_MESSAGE_TYPES.has(rawType)
}

/** `_safe_component`: Unicode letters/numbers, '_' and '-' survive; first 96 code points. */
export function codexSafeComponent(value: string): string {
  const chars = Array.from(value, char => (char === '_' || char === '-' || pythonIsAlnum(char) ? char : '_'))
  const safe = chars.slice(0, 96).join('')
  return safe || sha256Hex(value).slice(0, 24)
}

function joinDerivedParts(parts: readonly string[], index: number): string {
  const stable = parts.filter(part => part).map(codexSafeComponent).join('-')
  return stable || `item-${pyStr(index)}`
}

export function codexDerivedKeyFromValues(rawType: string, role: string | null, turnId: string | null, index: number): string {
  if (rawType === 'reasoning') return `reasoning-${pyStr(index)}`
  return joinDerivedParts([rawType, role || '', turnId || '', pyStr(index)], index)
}

export function codexTimelineItemIdFromValues(
  nativeId: string | null,
  clientMessageId: string | null,
  rawType: string,
  role: string | null,
  turnId: string | null,
  externalSessionId: string,
  index: number,
): string {
  if (clientMessageId && codexIsUserMessage(rawType, role)) return codexClientMessageItemId(externalSessionId, clientMessageId)
  if (nativeId !== null) return nativeId
  return `codex_${externalSessionId}_${codexDerivedKeyFromValues(rawType, role, turnId, index)}`
}

const SYSTEM_TYPES = new Set([
  'systemMessage', 'runtimeMessage', 'turnStart', 'turnEnd', 'error', 'contextCompaction', 'automaticApprovalReview',
])
const TOOL_TYPES = new Set([
  'commandExecution', 'webSearch', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'SubAgentActivityThreadItem',
  'subAgentActivity', 'function_call', 'function_call_output', 'functionCallOutput', 'custom_tool_call',
  'custom_tool_call_output', 'toolCall', 'toolResult',
])

/** raw_item.py `timeline_item_role_from_values`. */
export function codexRoleFromValues(rawType: string, role: string | null): string | null {
  if (role) return role
  if (rawType === 'reasoning' || SYSTEM_TYPES.has(rawType)) return 'system'
  if (USER_MESSAGE_TYPES.has(rawType)) return 'user'
  if (rawType === 'agentMessage') return 'assistant'
  if (TOOL_TYPES.has(rawType)) return 'tool'
  return null
}

/** raw_item.py `timeline_raw_type`: plan items project as systemMessage. */
export function codexRawType(raw: JsonObject): string {
  const value = pyOr(pyGet(raw, 'type'), pyGet(raw, 'kind'))
  if (value === 'plan') return 'systemMessage'
  return isNonEmptyString(value) ? value : 'unknown'
}

export function codexRawRole(raw: JsonObject): string | null {
  const value = pyGet(raw, 'role')
  if (isNonEmptyString(value)) return value
  return codexRoleFromValues(codexRawType(raw), null)
}

export function codexNativeItemId(raw: JsonObject): string | null {
  for (const key of ['id', 'itemId', 'item_id']) {
    const value = pyGet(raw, key)
    if (isNonEmptyString(value)) return value
  }
  return null
}

export function codexClientMessageIdFromRaw(raw: JsonObject): string | null {
  const value = pyOr(pyGet(raw, '_clientMessageId'), pyGet(raw, 'clientMessageId'), pyGet(raw, 'clientId'), pyGet(raw, 'client_id'))
  return isNonEmptyString(value) ? value : null
}

function rawTurnId(raw: JsonObject): string | null {
  for (const key of ['turnId', 'turn_id']) {
    const value = pyGet(raw, key)
    if (isNonEmptyString(value)) return value
  }
  return null
}

export function codexDerivedKey(raw: JsonObject, index: number): string {
  const explicit = pyOr(pyGet(raw, '_derivedKey'), pyGet(raw, 'derivedKey'), pyGet(raw, 'derived_key'))
  if (isNonEmptyString(explicit)) return explicit
  const itemType: JsonValue = pyOr(pyGet(raw, 'type'), pyGet(raw, 'kind'), 'item')
  const turnId = rawTurnId(raw)
  const role = codexRawRole(raw)
  if (itemType === 'reasoning') return `reasoning-${pyStr(index)}`
  return joinDerivedParts([pyStr(itemType), role || '', turnId || '', pyStr(index)], index)
}

function rawIsUserMessage(raw: JsonObject): boolean {
  if (pyGet(raw, 'role') === 'user') return true
  const rawType = pyGet(raw, 'type')
  return typeof rawType === 'string' && USER_MESSAGE_TYPES.has(rawType)
}

/** identity.py `timeline_item_id` for a raw thread-history item. */
export function codexTimelineItemId(raw: JsonObject, externalSessionId: string, index: number): string {
  const clientMessageId = codexClientMessageIdFromRaw(raw)
  if (clientMessageId && rawIsUserMessage(raw)) return codexClientMessageItemId(externalSessionId, clientMessageId)
  const nativeId = codexNativeItemId(raw)
  if (nativeId !== null) return nativeId
  return `codex_${externalSessionId}_${codexDerivedKey(raw, index)}`
}

/** input_requests.py: request_user_input_async notice, client message and timeline ids. */
export function codexAsyncInputIds(callId: string): { noticeId: string, clientMessageId: string, timelineItemId: string } {
  const digest = sha256Hex(callId).slice(0, 32)
  return {
    noticeId: `notice_codex_async_input_${digest}`,
    clientMessageId: `codex_async_input_${digest}`,
    timelineItemId: `codex_async_input_item_${digest}`,
  }
}
