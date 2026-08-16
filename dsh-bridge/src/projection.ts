import { contentHash, timelineId } from './identity.js'
import type { JsonObject } from './types.js'

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => {
    const item = asObject(part)
    return typeof item.text === 'string' ? item.text : ''
  }).join('')
  const object = asObject(value)
  return typeof object.text === 'string' ? object.text : ''
}

export function projectTimeline(externalSessionId: string, sessionId: string, events: readonly unknown[]): JsonObject[] {
  const projected = new Map<string, JsonObject>()
  const toolCalls = new Map<string, { title: string; input: unknown }>()
  const commands = new Map<string, { name: string; args?: string }>()
  let order = 0
  for (const raw of events) {
    order += 1
    const envelope = asObject(raw)
    const event = { ...envelope, ...asObject(envelope.data) }
    const type = typeof event.type === 'string' ? event.type : ''
    const message = asObject(event.message)
    const rawId = String(event.id ?? message.id ?? event.messageId ?? event.callId ?? event.commandId ?? order)
    let itemType = 'system'
    let status = 'done'
    let role: string | null = null
    let kind = type || 'event'
    let content: JsonObject = { kind: type || 'event' }

    if (type === 'user/message' || type === 'assistant/message') {
      itemType = 'message'
      role = type.startsWith('user/') ? 'user' : 'assistant'
      kind = 'message'
      content = { kind: 'text', text: textOf(message.content ?? event.content) }
    } else if (type === 'tool/call') {
      itemType = 'tool'
      role = 'assistant'
      kind = 'tool'
      status = 'running'
      let input: unknown = event.input ?? event.arguments ?? {}
      if (typeof input === 'string') {
        try { input = JSON.parse(input) } catch { /* preserve malformed model output as text */ }
      }
      const title = String(event.toolName ?? event.name ?? 'tool')
      toolCalls.set(rawId, { title, input })
      content = { kind: 'tool_call', title, input }
    } else if (type === 'tool/result') {
      itemType = 'tool'
      role = 'tool'
      kind = 'tool'
      status = event.error == null ? 'done' : 'failed'
      const call = toolCalls.get(rawId)
      content = {
        kind: 'tool_result',
        ...(call === undefined ? {} : { title: call.title, input: call.input }),
        output: event.result ?? event.output ?? textOf(asObject(event.message).content),
        ...(event.error === undefined ? {} : { error: event.error }),
      }
    } else if (type === 'turn/start') {
      itemType = 'turn.start'
      role = 'system'
      status = 'running'
      content = { kind: 'turn_start' }
    } else if (type === 'turn/end') {
      itemType = 'turn.end'
      role = 'system'
      const reason = asObject(event.reason)
      status = reason.kind === 'cancelled' ? 'interrupted' : reason.kind === 'error' ? 'failed' : 'done'
      content = { kind: 'turn_end', reason: typeof reason.kind === 'string' ? reason.kind : 'completed' }
    } else if (type === 'command/run') {
      role = 'system'
      kind = 'command'
      status = 'running'
      const name = String(event.name ?? 'command')
      const args = typeof event.args === 'string' ? event.args : undefined
      commands.set(rawId, { name, ...(args === undefined ? {} : { args }) })
      content = { kind: 'command', name, ...(args === undefined ? {} : { args }) }
    } else if (type === 'command/done') {
      role = 'system'
      kind = 'command'
      const command = commands.get(rawId)
      status = event.kind === 'error' ? 'failed' : 'done'
      content = { kind: 'command', name: command?.name ?? 'command', ...(command?.args === undefined ? {} : { args: command.args }), ...(typeof event.text === 'string' ? { output: event.text } : {}) }
    } else if (type === 'assistant/chunk') {
      continue
    } else {
      // DSH's SessionEventMap is merge-extensible. Unknown extension payloads
      // are intentionally skipped so prompts, credentials, and tool-private
      // metadata cannot cross the bridge by accident.
      continue
    }

    const id = timelineId(externalSessionId, kind, rawId)
    projected.set(id, {
      id,
      sessionId,
      type: itemType,
      status,
      role,
      orderSeq: order,
      revision: Number(event.seq ?? order) + 1,
      content,
      contentHash: contentHash(itemType, status, role, content),
      source: { runtime: 'dsh', externalSessionId, eventType: type, businessId: rawId },
      metadata: {},
    })
  }
  return [...projected.values()].sort((left, right) => Number(left.orderSeq) - Number(right.orderSeq))
}
