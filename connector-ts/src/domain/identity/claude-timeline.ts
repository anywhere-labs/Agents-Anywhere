import { sha256Hex } from './hash.js'
import { pythonJsonDumps, type JsonValue } from './python-json.js'

/** claude/timeline/messages.py `_short`: sha256 of the parts as sorted, compact, non-ASCII JSON, first 24 hex. */
export function claudeShort(...parts: JsonValue[]): string {
  return sha256Hex(pythonJsonDumps(parts, { sortKeys: true, ensureAscii: false })).slice(0, 24)
}

export interface ClaudeSessionScope {
  readonly sessionId: string
  readonly externalSessionId: string | null
}

function scopeOf(session: ClaudeSessionScope): string {
  return session.externalSessionId || session.sessionId
}

export function claudeMessageItemId(session: ClaudeSessionScope, nativeMessageId: string): string {
  return `claude_msg_${claudeShort('message', scopeOf(session), nativeMessageId)}`
}

export function claudeToolItemId(session: ClaudeSessionScope, toolUseId: string): string {
  return `claude_tool_${claudeShort('tool', scopeOf(session), toolUseId)}`
}

export function claudeSystemItemId(
  session: ClaudeSessionScope,
  turnId: string,
  nativeMessageId: string | null,
  blockIndex: number,
  blockType: string,
): string {
  return `claude_system_${claudeShort('system', scopeOf(session), nativeMessageId || turnId, blockIndex, blockType)}`
}

/**
 * `_stable_id`: message fallback ('message', sessionId, externalSessionId, turnId, role, stableKey)
 * and API retry items ('api-retry', sessionId, turnId).
 */
export function claudeStableId(...parts: JsonValue[]): string {
  return `claude_${claudeShort(...parts)}`
}

/** sessions/reader.py `_history_turn_id` (live turns use a random token). */
export function claudeHistoryTurnId(externalSessionId: string | null, turnSeed: string): string {
  return `turn_claude_${sha256Hex(`${externalSessionId || 'unknown'}:${turnSeed}`).slice(0, 24)}`
}
