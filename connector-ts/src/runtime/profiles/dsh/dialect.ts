/**
 * The DSH ACP dialect, shared by both routes (04-connector.md §5.6): standard ACP
 * `session/update`s, plus `_meta.dsh` when the plugin route sends them
 * (contracts/dsh-bridge/3.0 §6–§7). The direct route (`dsh --profile acp`) sends
 * whole committed messages with no `_meta`, so its updates map to committed events.
 */
import type * as acp from '@agentclientprotocol/sdk'
import type { DshUpdateMeta } from '../../../generated/dsh-bridge/v3_0/update-meta.js'
import type { Catalogs, RuntimeEvent, StopReason } from './port.js'

function dshMeta(update: acp.SessionUpdate): DshUpdateMeta | undefined {
  const meta = (update as { _meta?: { dsh?: unknown } })._meta?.dsh
  return meta && typeof meta === 'object' ? meta as DshUpdateMeta : undefined
}

function seqOf(meta: DshUpdateMeta | undefined): { seq?: number } {
  return typeof meta?.seq === 'number' ? { seq: meta.seq } : {}
}

function contentText(content: acp.ContentBlock): string | undefined {
  if (content.type === 'text') return content.text
  if (content.type === 'resource_link') return `[${content.name}](${content.uri})`
  return undefined
}

function toolOutput(content: readonly acp.ToolCallContent[] | null | undefined): string[] {
  return (content ?? []).flatMap(item => item.type === 'content' ? [contentText(item.content) ?? ''] : [])
}

export const STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])

/** Translate one `session/update`. `fallbackTurn` names the turn when the runtime sends no turn events. */
export function translateUpdate(update: acp.SessionUpdate): RuntimeEvent[] {
  const meta = dshMeta(update)
  const seq = seqOf(meta)
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      if (update.content.type === 'image') return [{ type: 'image', role: 'user', mimeType: update.content.mimeType, data: update.content.data,
        ...(update.messageId ? { messageId: update.messageId } : {}), ...seq }]
      const text = contentText(update.content)
      if (text === undefined) return []
      return [{ type: 'message.delta', role: 'user', text, transient: false, ...(update.messageId ? { messageId: update.messageId } : {}),
        ...(meta?.requestId ? { nativeRequestId: meta.requestId } : {}), ...seq }]
    }
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const role = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' as const : 'thought' as const
      if (meta?.abandoned) return [{ type: 'message.abandoned', attemptId: meta.abandoned.attemptId }]
      if (update.content.type === 'image') return [{ type: 'image', role: 'assistant', mimeType: update.content.mimeType, data: update.content.data,
        ...(update.messageId ? { messageId: update.messageId } : {}), ...seq }]
      const text = contentText(update.content) ?? ''
      if (meta?.transient) {
        return text ? [{ type: 'message.delta', role, text, transient: true, ...(meta.attemptId ? { attemptId: meta.attemptId } : {}), ...seq }] : []
      }
      // Plugin route marks committed blocks; the direct route only ever sends committed blocks.
      const messageId = meta?.committed?.messageId ?? update.messageId ?? undefined
      if (!messageId) return text ? [{ type: 'message.delta', role, text, transient: false, ...seq }] : []
      return [{ type: 'message.committed', role, messageId, text,
        ...(meta?.committed?.replacesAttempt ? { replacesAttempt: meta.committed.replacesAttempt } : {}), ...seq }]
    }
    case 'tool_call':
      return [{ type: 'tool.started', toolCallId: update.toolCallId, title: update.title, kind: update.kind ?? 'other',
        input: update.rawInput ?? null, ...seq }]
    case 'tool_call_update':
      return [{ type: 'tool.updated', toolCallId: update.toolCallId, status: update.status ?? 'in_progress',
        output: toolOutput(update.content), ...seq }]
    case 'usage_update':
      return [{ type: 'usage', used: update.used, size: update.size }]
    case 'session_info_update': {
      const events: RuntimeEvent[] = []
      if (typeof update.title === 'string') events.push({ type: 'title.changed', title: update.title })
      const turn = meta?.turnEvent
      if (turn?.phase === 'started') events.push({ type: 'turn.started', turnId: String(turn.turn), seq: turn.seq })
      else if (turn?.phase === 'ended') {
        events.push({ type: 'turn.ended', turnId: String(turn.turn), seq: turn.seq,
          stopReason: STOP_REASONS.has(turn.stopReason) ? turn.stopReason as StopReason : 'end_turn',
          reason: { kind: turn.reason.kind, ...(turn.reason.message ? { message: turn.reason.message } : {}) },
          deliveries: [...turn.requestIds], continuable: turn.continuable })
      }
      return events
    }
    case 'config_option_update':
      return [{ type: 'catalogs.changed', catalogs: catalogsOf(update.configOptions) }]
    default:
      return []
  }
}

export function catalogsOf(options: readonly acp.SessionConfigOption[] | null | undefined): Catalogs {
  const entries: Catalogs['entries'] = []
  for (const option of options ?? []) {
    if (option.type !== 'select') continue
    const flat: Catalogs['entries'][number]['options'] = []
    for (const item of option.options) {
      if ('options' in item) for (const nested of item.options) flat.push({ value: nested.value, name: nested.name,
        ...(nested.description ? { description: nested.description } : {}), group: item.name })
      else flat.push({ value: item.value, name: item.name, ...(item.description ? { description: item.description } : {}) })
    }
    entries.push({ id: option.id, category: option.category ?? 'other', current: String(option.currentValue), options: flat })
  }
  return { entries }
}
