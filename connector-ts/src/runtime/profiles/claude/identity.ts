// ported from Agents-Anywhere v2 connector/connector/runtimes/claude/timeline/messages.py @98dd0e6e5 (Timeline ID rules)
//
// Claude Timeline IDs. The same native message always gets the same ID, matching IDs already stored for
// existing sessions. claude-agent-acp puts `messageId` on message and thought chunks (the Anthropic API message ID,
// or the JSONL uuid when missing); a tool call's toolCallId is the tool_use id.

import {
  claudeMessageItemId,
  claudeStableId,
  claudeSystemItemId,
  claudeToolItemId,
  type ClaudeSessionScope,
} from '../../../domain/identity/index.js'
import { asRecord, type JsonRecord } from '../../acp/client.js'
import type { ItemIdentity, SessionContext } from '../../acp/dialect.js'
import { defaultIdentity } from '../../acp/session.js'

export function claudeIdentity(context: SessionContext): ItemIdentity {
  const scope: ClaudeSessionScope = { sessionId: context.sessionId, externalSessionId: context.nativeSessionId }
  const fallback = defaultIdentity(context)
  // Index of the thought block within one API message. ACP carries no content block index; Claude Code emits each
  // content block as its own message, so this is almost always 0.
  const thoughtIndex = new Map<string, number>()
  let lastThought: string | undefined
  const text = (update: JsonRecord) => asRecord(update.content).type === 'text'
  const messageId = (update: JsonRecord) => (typeof update.messageId === 'string' && update.messageId !== '' ? update.messageId : undefined)
  return {
    itemFor(update) {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'user_message_chunk': {
          lastThought = undefined
          const id = messageId(update)
          if (id === undefined) return fallback.itemFor(update)
          return text(update) ? claudeMessageItemId(scope, id) : null
        }
        case 'agent_thought_chunk': {
          const id = messageId(update)
          if (id === undefined) return fallback.itemFor(update)
          if (!text(update)) return null
          if (lastThought !== id) {
            thoughtIndex.set(id, thoughtIndex.has(id) ? thoughtIndex.get(id)! + 1 : 0)
            lastThought = id
          }
          return claudeSystemItemId(scope, '', id, thoughtIndex.get(id)!, 'thinking')
        }
        case 'tool_call':
        case 'tool_call_update':
          lastThought = undefined
          return typeof update.toolCallId === 'string' ? claudeToolItemId(scope, update.toolCallId) : fallback.itemFor(update)
        default:
          return fallback.itemFor(update)
      }
    },
    // Same components as the live user message ID, minus the random turn ID, so the ID is reproducible.
    userItemId: clientMessageId => claudeStableId('message', context.sessionId, context.nativeSessionId, 'user', clientMessageId),
  }
}
