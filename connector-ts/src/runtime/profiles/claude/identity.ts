// Claude 的 Timeline ID：沿用 v2 claude/timeline/messages.py 的规则，同一条原生消息在 v2 与 v3 得到同一个 ID。
// claude-agent-acp 在消息与思考块上带 `messageId`（Anthropic API 消息 ID，缺失时为 JSONL uuid），
// 工具调用的 toolCallId 就是 tool_use id。

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
  // 同一条 API 消息里第几个思考块。ACP 不带内容块序号；Claude Code 每个内容块单独成一条消息，
  // 所以几乎总是 0（v2 用的是块在消息 content 里的下标）。
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
    // v2 的实时用户消息把随机的回合 ID 也算进去，本来就不可复现；这里用同一组成分去掉回合 ID。
    userItemId: clientMessageId => claudeStableId('message', context.sessionId, context.nativeSessionId, 'user', clientMessageId),
  }
}
