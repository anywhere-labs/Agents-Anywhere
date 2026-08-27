import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import { contentHash, timelineItemId } from './identity.js'
import type { TimelineItem } from '../wire/protocol.js'

interface MutableItem {
  id: string
  type: TimelineItem['type']
  orderSeq: number
  revision: number
  payload: Record<string, unknown>
}

/**
 * Project a deterministic allowlist of DSH events into AA timeline items.
 * @param header - Session identity and storage metadata.
 * @param events - Contiguous events in sequence order.
 * @param includeChunks - Whether live assistant deltas should be represented.
 * @returns Stable items ordered by their first source event.
 */
export function projectTimeline(
  header: SessionHeader,
  events: readonly SessionEvent[],
  includeChunks = false,
): TimelineItem[] {
  const items = new Map<string, MutableItem>()
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') break
        const payload = {
          role: 'user',
          text: textContent(event.data.content),
          messageId: String(event.data.id),
        }
        set(items, header, 'message', String(event.data.id), event.seq, payload)
        break
      }
      case 'assistant/message': {
        const message = event.data.message
        const payload: Record<string, unknown> = {
          role: 'assistant',
          text: textContent(message.content),
          reasoning: reasoningContent(message.content),
          messageId: String(message.id),
          turn: event.data.turn,
          step: event.data.step,
          provider: message.source.provider,
          model: message.source.model,
          ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
        }
        if (includeChunks) {
          const activityId = timelineItemId(String(header.id), 'assistant_activity', `${event.data.turn}:${event.data.step}`)
          const activity = items.get(activityId)
          if (activity !== undefined) {
            upsert(items, {
              ...activity,
              payload: {
                turn: event.data.turn,
                step: event.data.step,
                text: payload.text,
                reasoning: payload.reasoning,
                status: 'complete',
                replacedBy: timelineItemId(String(header.id), 'message', String(message.id)),
              },
            })
          }
        }
        set(items, header, 'message', String(message.id), event.seq, payload)
        break
      }
      case 'assistant/chunk': {
        if (!includeChunks) break
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        const businessId = `${event.data.turn}:${event.data.step}`
        const id = timelineItemId(String(header.id), 'assistant_activity', businessId)
        const previous = items.get(id)
        const field = chunk.type === 'text-delta' ? 'text' : 'reasoning'
        const payload: Record<string, unknown> = {
          turn: event.data.turn,
          step: event.data.step,
          text: previous?.payload.text ?? '',
          reasoning: previous?.payload.reasoning ?? '',
          status: 'streaming',
        }
        payload[field] = `${String(payload[field])}${chunk.text}`
        upsert(items, { id, type: 'assistant_activity', orderSeq: previous?.orderSeq ?? event.seq, revision: 1, payload })
        break
      }
      case 'tool/call': {
        const payload = {
          callId: String(event.data.callId),
          name: event.data.name,
          arguments: parseToolArguments(event.data.arguments),
          turn: event.data.turn,
          step: event.data.step,
        }
        set(items, header, 'tool_call', String(event.data.callId), event.seq, payload)
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        const payload: Record<string, unknown> = {
          callId,
          text: textContent(block.content),
          isError: block.isError === true || event.data.error !== undefined,
          turn: event.data.turn,
          step: event.data.step,
          ...(event.data.error === undefined ? {} : { error: event.data.error }),
        }
        set(items, header, 'tool_result', callId, event.seq, payload)
        break
      }
      case 'command/run': {
        const businessId = String(event.data.commandId)
        const payload: Record<string, unknown> = {
          commandId: businessId,
          name: event.data.name,
          status: 'running',
          ...(event.data.args === undefined ? {} : { args: event.data.args }),
        }
        set(items, header, 'command', businessId, event.seq, payload)
        break
      }
      case 'command/done': {
        const businessId = String(event.data.commandId)
        const id = timelineItemId(String(header.id), 'command', businessId)
        const previous = items.get(id)
        const payload: Record<string, unknown> = {
          ...(previous?.payload ?? { commandId: businessId }),
          status: event.data.kind,
          ...(event.data.text === undefined ? {} : { text: event.data.text }),
          ...(event.data.sourceEventSeq === undefined ? {} : { sourceEventSeq: event.data.sourceEventSeq }),
        }
        upsert(items, { id, type: 'command', orderSeq: previous?.orderSeq ?? event.seq, revision: 1, payload })
        break
      }
      case 'turn/start':
        set(items, header, 'turn_status', String(event.data.turn), event.seq, {
          turn: event.data.turn,
          status: 'running',
        })
        break
      case 'turn/end': {
        const businessId = String(event.data.turn)
        const id = timelineItemId(String(header.id), 'turn_status', businessId)
        const previous = items.get(id)
        upsert(items, {
          id,
          type: 'turn_status',
          orderSeq: previous?.orderSeq ?? event.seq,
          revision: 1,
          payload: { turn: event.data.turn, status: 'done', reason: event.data.reason },
        })
        break
      }
      case 'session/title':
      case 'approval/asked':
      case 'approval/decided':
      case 'step/start':
      case 'step/end':
      case 'request/header':
      case 'request/context':
      case 'session/end-seed':
      case 'todo/write':
        break
      default:
        // SessionEventMap is merge-extensible. Unknown plugin events are not safe to expose.
        break
    }
  }
  return [...items.values()]
    .sort((left, right) => left.orderSeq - right.orderSeq || left.id.localeCompare(right.id))
    .map(item => ({ ...item, contentHash: contentHash(item.payload) }))
}

function set(
  items: Map<string, MutableItem>,
  header: SessionHeader,
  kind: TimelineItem['type'],
  businessId: string,
  orderSeq: number,
  payload: Record<string, unknown>,
): void {
  upsert(items, {
    id: timelineItemId(String(header.id), kind, businessId),
    type: kind,
    orderSeq,
    revision: 1,
    payload,
  })
}

function upsert(items: Map<string, MutableItem>, next: MutableItem): void {
  const previous = items.get(next.id)
  if (previous === undefined) {
    items.set(next.id, next)
    return
  }
  if (contentHash(previous.payload) === contentHash(next.payload)) return
  items.set(next.id, { ...next, orderSeq: previous.orderSeq, revision: previous.revision + 1 })
}

function textContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function reasoningContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join('\n')
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}
