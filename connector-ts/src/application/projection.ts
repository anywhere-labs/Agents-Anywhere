import type { JsonValue } from '../domain/identity/index.js'
import type { JsonObject, TimelineDraft, TimelineItem, TimelineItemStatus } from '../domain/conversation/index.js'
import { ORDER_ANCHOR_INDEX, ORDER_SUB_SLOTS } from '../domain/conversation/index.js'
import type { ToolContent, ToolStatus, TimelineItemEvent } from './ports/index.js'

/**
 * Projects Runtime events onto timeline drafts (04-connector.md §4: projection is the Conversation's job, not
 * the adapter's). Item ids come from the adapter (v2 identity rules); the projector keeps the in-flight state of
 * streaming items, assigns `orderSeq`, and produces the v2 content shapes clients already render.
 */
type MessageCompleted = Extract<TimelineItemEvent, { type: 'message.completed' }>

/**
 * `content.attachments` of a finished message, in the v2 Timeline shape (`{fileId, name, mediaType, size?, sha256?}`):
 * what the Runtime gives already in that shape (native history, Pi's echo), else each prompt attachment's platform
 * identity. A prompt attachment without one is described by name and type only: its local path or inline data
 * never goes into the Timeline.
 */
export function timelineAttachments(event: MessageCompleted): JsonValue[] {
  if (event.timelineAttachments !== undefined) return event.timelineAttachments.map(info => ({ ...info }))
  return (event.attachments ?? []).map(attachment => {
    if (attachment.info !== undefined) return { ...attachment.info }
    const described: Record<string, JsonValue> = { kind: attachment.kind }
    if (attachment.name !== undefined) described.name = attachment.name
    if (attachment.mimeType !== undefined) described.mimeType = attachment.mimeType
    if (attachment.kind === 'link') described.uri = attachment.uri
    return described
  })
}

export class TimelineProjector {
  private readonly live = new Map<string, TimelineDraft>()
  private nextNativeIndex: number

  public constructor(
    private readonly runtime: string,
    private readonly nativeSessionId: string | null,
    latest: TimelineItem | null,
    private readonly now: () => string,
  ) {
    this.nextNativeIndex = latest === null ? ORDER_ANCHOR_INDEX : Math.floor(latest.orderSeq / ORDER_SUB_SLOTS) + 1
  }

  /** Seeds the projector with a stored item (a delta for an item that is no longer in memory). */
  public remember(item: TimelineItem): void {
    if (!this.live.has(item.id)) this.live.set(item.id, item)
  }

  public get(itemId: string): TimelineDraft | undefined {
    return this.live.get(itemId)
  }

  public knows(itemId: string): boolean {
    return this.live.has(itemId)
  }

  /** Items still `running`/`pending` (closed when the turn ends). */
  public openItems(): TimelineDraft[] {
    return [...this.live.values()].filter(draft => draft.status === 'running' || draft.status === 'pending' || draft.status === 'waiting_approval')
  }

  public forget(itemId: string): void {
    this.live.delete(itemId)
  }

  /** Drops finished items from memory; the store has them. */
  public compact(): void {
    for (const [id, draft] of this.live) if (draft.status !== 'running' && draft.status !== 'pending' && draft.status !== 'waiting_approval') this.live.delete(id)
  }

  private orderFor(itemId: string): number {
    const known = this.live.get(itemId)
    if (known !== undefined) return known.orderSeq
    return (this.nextNativeIndex++) * ORDER_SUB_SLOTS
  }

  private source(extra: { itemId?: string; event: string; clientMessageId?: string }): TimelineDraft['source'] {
    return {
      runtime: this.runtime,
      ...(this.nativeSessionId !== null ? { sessionId: this.nativeSessionId } : {}),
      ...(extra.itemId !== undefined ? { itemId: extra.itemId } : {}),
      event: extra.event,
      ...(extra.clientMessageId !== undefined ? { clientMessageId: extra.clientMessageId } : {}),
    }
  }

  /** Applies one timeline event and returns the new draft of the affected item. */
  public apply(event: TimelineItemEvent): TimelineDraft {
    switch (event.type) {
      case 'message.delta':
      case 'message.completed': {
        const previous = this.live.get(event.itemId)
        const previousText = typeof previous?.content.text === 'string' ? previous.content.text : ''
        const text = event.type === 'message.delta' ? previousText + event.text : event.text
        const clientMessageId = event.clientMessageId ?? (typeof previous?.content.clientMessageId === 'string' ? previous.content.clientMessageId : undefined)
        const attachments = event.type === 'message.completed' ? timelineAttachments(event) : []
        const content: JsonObject = {
          kind: 'markdown',
          format: 'markdown',
          text,
          isThinking: event.role === 'reasoning',
          ...(clientMessageId !== undefined ? { clientMessageId } : {}),
          ...(attachments.length > 0
            ? { attachments }
            : previous?.content.attachments !== undefined ? { attachments: previous.content.attachments } : {}),
        }
        // A finished message keeps the Runtime's verdict (Pi: a model error is failed, an interruption cancelled).
        const status: TimelineItemStatus = event.type === 'message.completed' ? (event.status ?? 'done') : event.role === 'user' ? 'done' : 'running'
        return this.put({
          id: event.itemId,
          type: 'message',
          status,
          role: event.role === 'user' ? 'user' : 'assistant',
          orderSeq: this.orderFor(event.itemId),
          content,
          source: this.source({ event: event.type, ...(clientMessageId !== undefined ? { clientMessageId } : {}) }),
          createdAt: previous?.createdAt ?? this.now(),
          ...(status !== 'running' ? { completedAt: this.now() } : {}),
        })
      }
      case 'tool.started':
      case 'tool.updated': {
        const previous = this.live.get(event.itemId)
        const base: Record<string, JsonValue> = previous === undefined ? {} : { ...previous.content }
        const toolKind = event.kind ?? (typeof base.toolKind === 'string' ? base.toolKind : 'other')
        const content: Record<string, JsonValue> = {
          ...base,
          toolCallId: event.toolCallId,
          toolKind,
          title: event.title ?? (typeof base.title === 'string' ? base.title : 'Agent tool'),
          kind: 'tool_call',
        }
        if (event.input !== undefined) content.input = event.input
        if (event.type === 'tool.updated' && event.output !== undefined) content.output = event.output
        if (event.type === 'tool.updated' && event.outputDelta !== undefined) {
          const key = content.output !== undefined && typeof content.output !== 'string' ? 'terminalOutput' : 'output'
          const output = content[key]
          content[key] = ((typeof output === 'string' ? output : '') + event.outputDelta).slice(-65_536)
        }
        if (event.locations !== undefined) content.locations = event.locations.map(location => ({ ...location }))
        if (event.content !== undefined) content.content = event.content.map(block => ({ ...block }) as JsonValue)
        shapeTool(content, toolKind)
        const collab = collabToolOf(content.title, content.input)
        if (collab !== null) content.collabTool = collab
        const status = event.status === undefined ? (previous?.status ?? 'pending') : toolStatus(event.status)
        return this.put({
          id: event.itemId,
          type: 'tool',
          status,
          role: 'tool',
          orderSeq: this.orderFor(event.itemId),
          content,
          source: this.source({ itemId: event.toolCallId, event: event.type }),
          createdAt: previous?.createdAt ?? this.now(),
          ...(status === 'done' || status === 'failed' || status === 'cancelled' ? { completedAt: this.now() } : {}),
        })
      }
      case 'notice': {
        const previous = this.live.get(event.itemId)
        const kind = event.kind === 'compact' ? 'compact' : event.kind === 'error' ? 'error' : 'notice'
        return this.put({
          id: event.itemId,
          type: event.kind === 'compact' ? 'marker' : 'system',
          status: 'done',
          role: 'system',
          orderSeq: this.orderFor(event.itemId),
          content: { kind, level: event.level, noticeKind: event.kind, text: event.text, ...(event.data !== undefined ? { data: event.data } : {}) },
          source: this.source({ event: 'notice' }),
          createdAt: previous?.createdAt ?? this.now(),
          completedAt: this.now(),
        })
      }
    }
  }

  /** Turn end: streaming messages settle as `done` (or the turn's terminal status for cancellations). */
  public settleOpen(status: 'done' | 'cancelled' | 'failed' | 'interrupted'): TimelineDraft[] {
    const settled: TimelineDraft[] = []
    for (const draft of this.openItems()) {
      const next: TimelineDraft = { ...draft, status: draft.type === 'message' && status === 'cancelled' ? 'interrupted' : status, completedAt: this.now() }
      settled.push(this.put(next))
    }
    return settled
  }

  /** A platform item (user message the device wrote itself, synthesized failure cards). */
  public platform(draft: Omit<TimelineDraft, 'orderSeq'> & { orderSeq?: number }): TimelineDraft {
    return this.put({ ...draft, orderSeq: draft.orderSeq ?? this.orderFor(draft.id) } as TimelineDraft)
  }

  private put(draft: TimelineDraft): TimelineDraft {
    this.live.set(draft.id, draft)
    return draft
  }
}

function toolStatus(status: ToolStatus): TimelineItemStatus {
  return status
}

/** ACP tool details: commands show their command line, diffs become file changes. */
function shapeTool(content: Record<string, JsonValue>, toolKind: string): void {
  const input = content.input
  if (toolKind === 'command') {
    content.kind = 'command'
    if (input !== null && typeof input === 'object' && !Array.isArray(input) && typeof input.command === 'string') content.command = input.command
  }
  const blocks = Array.isArray(content.content) ? (content.content as unknown as ToolContent[]) : []
  const diffs = blocks.filter((block): block is Extract<ToolContent, { type: 'diff' }> => block.type === 'diff')
  if (diffs.length > 0) {
    content.kind = 'file_change'
    content.changes = diffs.map(block => ({
      path: block.path,
      kind: block.oldText === undefined ? 'add' : 'update',
      diff: [
        ...(block.oldText ?? '').split('\n').filter(line => line.length > 0).map(line => `-${line}`),
        ...block.newText.split('\n').filter(line => line.length > 0).map(line => `+${line}`),
      ].join('\n'),
      contextual: false,
    }))
  }
  const terminal = blocks.find((block): block is Extract<ToolContent, { type: 'terminal' }> => block.type === 'terminal')
  if (terminal?.output !== undefined && content.output === undefined) content.output = terminal.output
  if (terminal?.exitCode !== undefined && terminal.exitCode !== null) content.exitCode = terminal.exitCode
}

/**
 * A collaboration tool call, by the tool title each Runtime gives it (Claude and DSH `mcp__aa__aa_spawn`, Codex
 * `mcp.aa.aa_spawn`, Pi `aa: aa_spawn`): `{server, tool, sessionId?}`, so clients need not parse titles.
 */
export function collabToolOf(title: JsonValue | undefined, input: JsonValue | undefined): JsonObject | null {
  if (typeof title !== 'string') return null
  const match = /^(?:mcp__aa__|mcp\.aa\.|aa: )(aa_[a-z_]+)\b/u.exec(title.trim())
  if (match === null) return null
  const args = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : null
  const deviceId = typeof args.deviceId === 'string' ? args.deviceId : null
  return { server: 'aa', tool: match[1] as string, ...(sessionId !== null ? { sessionId } : {}), ...(deviceId !== null ? { deviceId } : {}) }
}
