// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/timeline/identity.py @98dd0e6e5 (Timeline ID rules)
// ported from Agents-Anywhere v2 connector/connector/runtimes/codex/timeline/accumulator.py @98dd0e6e5 (turn positions)
//
// Codex Timeline IDs, matching IDs already stored for existing sessions.
// - User messages sent by AA or carrying a client message ID: `codexClientMessageItemId(thread, clientMessageId)`.
// - Everything else by thread + Codex turn + lane + position in lane: `codexTurnPositionItemId`
//   (codex-turn-item-v2). Reasoning shares the current assistant message's position and does not advance it.
// - Types not identified by position (contextCompaction, etc.) use the native item ID.
// The Codex turn and item type come from codex-acp's `_meta.codex` (present only when the client declares
// `_meta.codexItemContext`, anywhere-labs/codex-acp#6). Live updates and `_codex/session/read` history use the
// same algorithm, so the IDs agree.

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
