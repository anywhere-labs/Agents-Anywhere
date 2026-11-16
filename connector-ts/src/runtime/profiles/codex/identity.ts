// Codex 的 Timeline ID：沿用 v2 codex/timeline（identity.py、accumulator.py）。
// - AA 发出、或带客户端消息 ID 的用户消息：`codexClientMessageItemId(线程, clientMessageId)`；
// - 其余按「线程 + Codex turn + lane + lane 内位置」：`codexTurnPositionItemId`（codex-turn-item-v2）；
//   推理共用当前助手消息的位置、不前进；
// - 不按位置的类型（contextCompaction 等）用原生条目 ID。
// Codex turn 与条目类型来自 codex-acp 的 `_meta.codex`（客户端声明 `_meta.codexItemContext` 才有，
// anywhere-labs/codex-acp#6）。实时与 `_codex/session/read` 历史走同一个算法，所以 ID 一致。

import {
  codexClientMessageItemId,
  codexIsUserMessage,
  codexNextTurnLanePosition,
  codexRoleFromValues,
  codexTurnItemLane,
  codexTurnPositionItemId,
  codexUsesTurnPositionIdentity,
} from '../../../domain/identity/index.js'
import { asRecord } from '../../acp/client.js'
import type { ItemIdentity, SessionContext } from '../../acp/dialect.js'
import { defaultIdentity } from '../../acp/session.js'

const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'])

export function codexIdentity(context: SessionContext): ItemIdentity {
  const thread = context.nativeSessionId
  const fallback = defaultIdentity(context)
  const lanesByTurn = new Map<string, Map<string, number>>()
  const assigned = new Map<string, string>()
  return {
    itemFor(update) {
      const codex = asRecord(asRecord(update._meta).codex)
      const turnId = typeof codex.turnId === 'string' ? codex.turnId : undefined
      const itemType = typeof codex.itemType === 'string' ? codex.itemType : undefined
      if (turnId === undefined || itemType === undefined) return fallback.itemFor(update)
      if (CHUNKS.has(String(update.sessionUpdate)) && asRecord(update.content).type !== 'text') return null
      const nativeId = typeof update.messageId === 'string' ? update.messageId : typeof update.toolCallId === 'string' ? update.toolCallId : ''
      const key = `${turnId}\u0000${nativeId}`
      const known = assigned.get(key)
      if (known !== undefined) return known
      const rawType = itemType === 'plan' ? 'systemMessage' : itemType
      const role = codexRoleFromValues(rawType, null)
      let id: string
      if (!codexUsesTurnPositionIdentity(rawType, role)) {
        id = nativeId !== '' ? nativeId : fallback.itemFor(update) ?? `codex_${thread}_${rawType}`
      } else {
        const lanes = lanesByTurn.get(turnId) ?? new Map<string, number>()
        lanesByTurn.set(turnId, lanes)
        const lane = codexTurnItemLane(rawType, role)
        const position = codexNextTurnLanePosition(lanes, lane)
        id = codexTurnPositionItemId(thread, turnId, position, lane)
      }
      const clientMessageId = typeof codex.clientMessageId === 'string' ? codex.clientMessageId : undefined
      if (clientMessageId !== undefined && codexIsUserMessage(rawType, role)) id = codexClientMessageItemId(thread, clientMessageId)
      if (nativeId !== '') assigned.set(key, id)
      return id
    },
    userItemId: clientMessageId => codexClientMessageItemId(thread, clientMessageId),
    reset() {
      lanesByTurn.clear()
      assigned.clear()
    },
  }
}
