import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import { contentHash, timelineItemId } from './identity.js'
import type { TimelineItem } from '../runtime/types.js'

interface MutableItem extends Omit<TimelineItem, 'contentHash'> {}

export function projectTimeline(
  header: SessionHeader,
  events: readonly SessionEvent[],
  includeChunks = false,
): TimelineItem[] {
  const items = new Map<string, MutableItem>()
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        if (event.data.source.kind === 'user') {
          put(items, header, event, 'message', 'message', String(event.data.id), 'done', 'user', {
            kind: 'text',
            text: textContent(event.data.content),
            messageId: String(event.data.id),
          })
        }
        break
      case 'assistant/chunk': {
        if (!includeChunks) break
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        const businessId = `${event.data.turn}:${event.data.step}`
        const id = timelineItemId(String(header.id), 'assistant', businessId)
        const previous = items.get(id)
        const content: Record<string, unknown> = {
          kind: 'text',
          text: previous?.content.text ?? '',
          reasoning: previous?.content.reasoning ?? '',
          turn: event.data.turn,
          step: event.data.step,
        }
        content[chunk.type === 'text-delta' ? 'text' : 'reasoning'] =
          `${String(content[chunk.type === 'text-delta' ? 'text' : 'reasoning'])}${chunk.text}`
        upsert(items, item(header, event, id, 'message', 'running', 'assistant', content, previous?.orderSeq))
        break
      }
      case 'assistant/message': {
        const message = event.data.message
        const businessId = `${event.data.turn}:${event.data.step}`
        const id = timelineItemId(String(header.id), 'assistant', businessId)
        const previous = items.get(id)
        upsert(items, item(
          header,
          event,
          id,
          'message',
          event.data.interrupted === true ? 'interrupted' : 'done',
          'assistant',
          {
            kind: 'text',
            text: textContent(message.content),
            reasoning: reasoningContent(message.content),
            messageId: String(message.id),
            turn: event.data.turn,
            step: event.data.step,
            provider: message.source.provider,
            model: message.source.model,
            ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
          },
          previous?.orderSeq,
        ))
        break
      }
      case 'tool/call':
        put(items, header, event, 'tool', 'tool_call', String(event.data.callId), 'running', 'assistant', {
          kind: 'tool_call',
          callId: String(event.data.callId),
          title: event.data.name,
          input: parseToolArguments(event.data.arguments),
          turn: event.data.turn,
          step: event.data.step,
        })
        break
      case 'tool/result': {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        const id = timelineItemId(String(header.id), 'tool_call', callId)
        const previous = items.get(id)
        upsert(items, item(
          header,
          event,
          id,
          'tool',
          block.isError === true || event.data.error !== undefined ? 'failed' : 'done',
          'tool',
          {
            kind: 'tool_result',
            callId,
            text: textContent(block.content),
            ...(event.data.error === undefined ? {} : { error: event.data.error }),
            ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
            turn: event.data.turn,
            step: event.data.step,
          },
          previous?.orderSeq,
        ))
        break
      }
      case 'command/run':
        put(items, header, event, 'tool', 'command', String(event.data.commandId), 'running', 'tool', {
          kind: 'command',
          commandId: String(event.data.commandId),
          title: event.data.name,
          ...(event.data.args === undefined ? {} : { input: event.data.args }),
        })
        break
      case 'command/done': {
        const id = timelineItemId(String(header.id), 'command', String(event.data.commandId))
        const previous = items.get(id)
        upsert(items, item(
          header,
          event,
          id,
          'tool',
          event.data.kind === 'success' ? 'done' : 'failed',
          'tool',
          {
            ...(previous?.content ?? { kind: 'command', commandId: String(event.data.commandId) }),
            ...(event.data.text === undefined ? {} : { text: event.data.text }),
            ...(event.data.sourceEventSeq === undefined ? {} : { sourceEventSeq: event.data.sourceEventSeq }),
          },
          previous?.orderSeq,
        ))
        break
      }
      case 'turn/start':
        put(items, header, event, 'turn.start', 'turn_start', String(event.data.turn), 'running', null, {
          kind: 'turn_start', turn: event.data.turn,
        })
        break
      case 'turn/end':
        put(items, header, event, 'turn.end', 'turn_end', String(event.data.turn), turnStatus(event.data.reason), null, {
          kind: 'turn_end', turn: event.data.turn, reason: event.data.reason,
        })
        break
      default:
        break
    }
  }
  return [...items.values()]
    .sort((left, right) => left.orderSeq - right.orderSeq || left.id.localeCompare(right.id))
    .map(withHash)
}

function put(
  items: Map<string, MutableItem>,
  header: SessionHeader,
  event: SessionEvent,
  type: TimelineItem['type'],
  projectionKind: string,
  businessId: string,
  status: TimelineItem['status'],
  role: TimelineItem['role'],
  content: Record<string, unknown>,
): void {
  upsert(items, item(
    header,
    event,
    timelineItemId(String(header.id), projectionKind, businessId),
    type,
    status,
    role,
    content,
  ))
}

function item(
  header: SessionHeader,
  event: SessionEvent,
  id: string,
  type: TimelineItem['type'],
  status: TimelineItem['status'],
  role: TimelineItem['role'],
  content: Record<string, unknown>,
  orderSeq = event.seq,
): MutableItem {
  return {
    id,
    sessionId: String(header.id),
    type,
    status,
    role,
    orderSeq,
    revision: 1,
    content,
    source: {
      runtime: 'dsh',
      externalSessionId: String(header.id),
      eventType: event.type,
      eventSeq: event.seq,
      eventTime: event.time,
    },
  }
}

function upsert(items: Map<string, MutableItem>, next: MutableItem): void {
  const previous = items.get(next.id)
  if (previous === undefined) {
    items.set(next.id, next)
    return
  }
  const previousHash = contentHash(hashEnvelope(previous))
  const nextHash = contentHash(hashEnvelope(next))
  if (previousHash === nextHash) return
  items.set(next.id, { ...next, orderSeq: previous.orderSeq, revision: previous.revision + 1 })
}

function withHash(itemValue: MutableItem): TimelineItem {
  return { ...itemValue, contentHash: contentHash(hashEnvelope(itemValue)) }
}

function hashEnvelope(itemValue: Pick<TimelineItem, 'type' | 'status' | 'role' | 'content'>): Record<string, unknown> {
  return {
    type: itemValue.type,
    status: itemValue.status,
    role: itemValue.role,
    content: itemValue.content,
  }
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

function turnStatus(reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason']): TimelineItem['status'] {
  if (reason.kind === 'error') return 'failed'
  if (reason.kind === 'aborted') return 'cancelled'
  if (reason.kind === 'interrupted') return 'interrupted'
  return 'done'
}
