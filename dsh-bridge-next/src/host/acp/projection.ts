/**
 * DSH session events -> ACP v1 session updates for contracts/dsh-bridge/3.0 §6.
 *
 * The block and tool conversions follow DSH's own automation ACP
 * (`@deepseek-ai/dsh-acp` 0.2.2-rc.3, packages/acp/acp/src/updates.ts and codec.ts,
 * MIT, Copyright DeepSeek). They are copied rather than imported because that package
 * only publishes TypeScript sources and ties them to Agents it owns.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock as AcpContentBlock, SessionUpdate, StopReason, ToolCallContent } from '@agentclientprotocol/sdk'
import type { DshTurnNotification, DshUpdateMeta } from '../../contracts/bridge-v3.js'
import { record } from '../dsh-runtime/types.js'

export type ProjectedUpdate = SessionUpdate & { _meta?: { dsh: DshUpdateMeta } }

function withMeta<T extends SessionUpdate>(update: T, dsh: DshUpdateMeta): ProjectedUpdate {
  return { ...update, _meta: { ...(update as { _meta?: Record<string, unknown> })._meta, dsh } } as ProjectedUpdate
}

/** Native `TurnEndReason.kind` -> ACP stop reason (dsh-acp codec.ts). */
export function stopReasonOf(kind: string): StopReason {
  switch (kind) {
    case 'max-tokens': return 'max_tokens'
    case 'interrupted': return 'cancelled'
    case 'aborted': {
      // A user cancellation aborts the turn; DSH records the cause beside the kind.
      return 'cancelled'
    }
    default: return 'end_turn'
  }
}

function parseToolArguments(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return value }
}

type Block = { type: string, text?: string, attachment?: unknown }

async function blockToAcp(ctx: Context, block: Block): Promise<AcpContentBlock | undefined> {
  if (block.type === 'text') return block.text ? { type: 'text', text: block.text } : undefined
  if (block.type !== 'image') return undefined
  const attachments = ctx.get('attachments')
  if (!attachments) return undefined
  try {
    const stored = await attachments.readImage(block.attachment as never)
    return { type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType }
  } catch {
    // A missing or corrupt attachment must not break the rest of the replay.
    return { type: 'text', text: '[image unavailable]' }
  }
}

export function userSource(event: SessionEvent): { kind: DshUpdateMeta['source'], requestId?: string } {
  if (event.type !== 'user/message') return { kind: 'other' }
  const source = record(event.data.source)
  const kind = source.kind === 'user' ? 'user' : source.kind === 'retry' ? 'retry' : 'other'
  const requestId = typeof source.rpcId === 'string' ? source.rpcId : event.data.id
  return { kind, ...(requestId ? { requestId } : {}) }
}

/**
 * Updates for one committed event. `attempt` is the live stream attempt of the
 * session's Agent, which a committed assistant message replaces.
 */
export async function eventUpdates(ctx: Context, event: SessionEvent, turn: number | undefined, attempt?: string): Promise<ProjectedUpdate[]> {
  const seq = Number(event.seq)
  const base: DshUpdateMeta = { seq, ...(turn !== undefined ? { turn } : {}) }
  switch (event.type) {
    case 'user/message': {
      const source = userSource(event)
      // DSH's empty continuation (`retry`) and system-sourced inputs stay off the transcript.
      if (source.kind !== 'user') return []
      const updates: ProjectedUpdate[] = []
      for (const block of event.data.content as readonly Block[]) {
        const content = await blockToAcp(ctx, block)
        if (content) updates.push(withMeta({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content },
          { ...base, source: 'user', ...(source.requestId ? { requestId: source.requestId } : {}) }))
      }
      return updates
    }
    case 'assistant/message': {
      const message = event.data.message
      const committed = { messageId: message.id, ...(attempt ? { replacesAttempt: attempt } : {}) }
      const updates: ProjectedUpdate[] = []
      for (const block of message.content as readonly Block[]) {
        if (block.type === 'reasoning') {
          if (block.text) updates.push(withMeta({ sessionUpdate: 'agent_thought_chunk', messageId: message.id,
            content: { type: 'text', text: block.text } }, { ...base, committed }))
          continue
        }
        const content = await blockToAcp(ctx, block)
        if (content) updates.push(withMeta({ sessionUpdate: 'agent_message_chunk', messageId: message.id, content }, { ...base, committed }))
      }
      // An assistant message with only tool calls still commits (and closes) its stream attempt.
      if (!updates.length && attempt) updates.push(withMeta({ sessionUpdate: 'agent_message_chunk', messageId: message.id,
        content: { type: 'text', text: '' } }, { ...base, committed }))
      return updates
    }
    case 'tool/call':
      return [withMeta({ sessionUpdate: 'tool_call', toolCallId: event.data.callId, title: event.data.name, kind: 'other',
        status: 'in_progress', rawInput: parseToolArguments(event.data.arguments) }, base)]
    case 'tool/result': {
      const message = event.data.message
      const content: ToolCallContent[] = []
      for (const block of message.content as readonly Block[]) {
        const converted = await blockToAcp(ctx, block)
        if (converted) content.push({ type: 'content', content: converted })
      }
      return [withMeta({ sessionUpdate: 'tool_call_update', toolCallId: message.toolCallId,
        status: message.isError === true ? 'failed' : 'completed', content }, base)]
    }
    case 'session/title': {
      const title = record(event.data).title
      return typeof title === 'string' ? [withMeta({ sessionUpdate: 'session_info_update', title }, base)] : []
    }
    default:
      return []
  }
}

/** A transient stream chunk (contracts §6 `transient`). */
export function streamUpdate(chunk: { type: string, text?: string }, attemptId: string, throughSeq: number, turn: number): ProjectedUpdate | undefined {
  const meta: DshUpdateMeta = { seq: Math.max(0, throughSeq), turn, transient: true, attemptId }
  if (chunk.type === 'text-delta' && chunk.text) {
    return withMeta({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } }, meta)
  }
  if (chunk.type === 'reasoning-delta' && chunk.text) {
    return withMeta({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } }, meta)
  }
  return undefined
}

/** A stream attempt that will never commit (retry, interruption). */
export function abandonedUpdate(attemptId: string, throughSeq: number, turn: number): ProjectedUpdate {
  return withMeta({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
    { seq: Math.max(0, throughSeq), turn, transient: true, attemptId, abandoned: { attemptId } })
}

/** A turn boundary (contracts §7), carried as a `session_info_update` so it stays in order. */
export function turnUpdate(event: DshTurnNotification): ProjectedUpdate {
  return withMeta({ sessionUpdate: 'session_info_update' }, { seq: event.seq, turn: event.turn, turnEvent: event })
}
