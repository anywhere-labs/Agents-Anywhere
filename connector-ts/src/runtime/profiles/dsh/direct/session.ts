/**
 * One DSH session on the direct route (`dsh --profile acp`). DSH admits one prompt per
 * session at a time and rejects empty prompts, so this adapter:
 * - holds later inputs in a local FIFO and sends each after the previous turn ends
 *   (the Connector-side queue of 04-connector.md §5.8 for this route);
 * - synthesizes turn boundaries and the user's own message, which DSH never echoes;
 * - answers permission requests through `respond`, single-shot only.
 */
import * as acp from '@agentclientprotocol/sdk'
import { EventChannel } from '../events.js'
import { translateUpdate } from '../dialect.js'
import type { ConfigChange, ConfigResult, DeliveryRef, InteractionAnswer, PromptAcceptance, PromptInput, RuntimeEvent,
  RuntimeSession, SessionCapabilities, StopReason, CommandResult } from '../port.js'
import { catalogsOf } from '../dialect.js'
import { STOP_REASONS } from '../dialect.js'

interface Queued { input: PromptInput, delivery: DeliveryRef }
interface PendingPermission { resolve: (response: acp.RequestPermissionResponse) => void }

/** The bounded local queue; beyond it `prompt` fails like v2's `queue_full`. */
export const DIRECT_QUEUE_LIMIT = 20

export class QueueFullError extends Error {
  readonly code = 'queue_full'
  constructor() { super('The session queue is full.') }
}

export class DshDirectSession implements RuntimeSession {
  readonly events = new EventChannel<RuntimeEvent>()
  private readonly queue: Queued[] = []
  private readonly seen = new Set<string>()
  private readonly permissions = new Map<string, PendingPermission>()
  private running: { turnId: string, requestId: string } | undefined
  private turnCount = 0
  private closed = false
  configOptions: acp.SessionConfigOption[]

  constructor(private readonly conn: acp.ClientSideConnection, readonly externalSessionId: string,
    readonly capabilities: SessionCapabilities, configOptions: readonly acp.SessionConfigOption[] | null | undefined,
    private readonly onClose: () => void) {
    this.configOptions = [...(configOptions ?? [])]
  }

  get busy(): boolean { return this.running !== undefined }
  get queued(): number { return this.queue.length }

  // ---------------------------------------------------------------- inbound from DSH

  update(params: acp.SessionNotification): void {
    if (params.update.sessionUpdate === 'config_option_update') this.configOptions = [...params.update.configOptions]
    for (const event of translateUpdate(params.update)) this.events.push(event)
  }

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (this.closed) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const interactionId = params.toolCall.toolCallId
    return new Promise(resolve => {
      this.permissions.get(interactionId)?.resolve({ outcome: { outcome: 'cancelled' } })
      this.permissions.set(interactionId, { resolve })
      this.events.push({ type: 'interaction.opened', interactionId, interactionType: 'approval',
        title: params.toolCall.title ?? 'Permission', toolCallId: params.toolCall.toolCallId,
        options: params.options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })) })
    })
  }

  // ---------------------------------------------------------------- outbound

  async prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance> {
    if (this.closed) throw new Error('The DSH session is closed.')
    if (this.seen.has(delivery.nativeRequestId)) return { status: 'duplicate' }
    toPromptBlocks(input, this.capabilities)
    if (this.running) {
      if (this.queue.length >= DIRECT_QUEUE_LIMIT) throw new QueueFullError()
      this.seen.add(delivery.nativeRequestId)
      this.queue.push({ input, delivery })
      return { status: 'queued', position: this.queue.length }
    }
    this.seen.add(delivery.nativeRequestId)
    this.start({ input, delivery })
    return { status: 'accepted' }
  }

  /** Drop a queued input that has not been sent yet (AA's queue removal). */
  removeQueued(nativeRequestId: string): boolean {
    const index = this.queue.findIndex(item => item.delivery.nativeRequestId === nativeRequestId)
    if (index < 0) return false
    this.queue.splice(index, 1)
    this.seen.delete(nativeRequestId)
    return true
  }

  private start(item: Queued): void {
    const turnId = `direct-${++this.turnCount}`
    this.running = { turnId, requestId: item.delivery.nativeRequestId }
    this.events.push({ type: 'turn.started', turnId })
    // DSH's automation ACP does not echo the user's input; the Conversation needs it.
    this.events.push({ type: 'message.delta', role: 'user', text: item.input.text, transient: false, nativeRequestId: item.delivery.nativeRequestId })
    for (const image of item.input.images ?? []) this.events.push({ type: 'image', role: 'user', mimeType: image.mimeType, data: image.data })
    void this.conn.prompt({ sessionId: this.externalSessionId, prompt: toPromptBlocks(item.input, this.capabilities) })
      .then(result => this.finish(turnId, item, STOP_REASONS.has(result.stopReason) ? result.stopReason as StopReason : 'end_turn'))
      .catch((error: unknown) => this.finish(turnId, item, 'end_turn', { kind: 'error', message: errorMessage(error) }))
  }

  private finish(turnId: string, item: Queued, stopReason: StopReason, reason?: { kind: string, message?: string }): void {
    if (this.running?.turnId !== turnId) return
    this.running = undefined
    for (const [id, pending] of this.permissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      this.events.push({ type: 'interaction.resolved', interactionId: id, by: 'timeout' })
    }
    this.permissions.clear()
    this.events.push({ type: 'turn.ended', turnId, stopReason, deliveries: [item.delivery.nativeRequestId],
      ...(reason ? { reason } : stopReason === 'cancelled' ? { reason: { kind: 'interrupted' } } : { reason: { kind: 'completed' } }) })
    const next = this.queue.shift()
    if (next && !this.closed) this.start(next)
  }

  async cancel(expectedTurnId?: string): Promise<void> {
    if (!this.running || (expectedTurnId && expectedTurnId !== this.running.turnId)) return
    await this.conn.cancel({ sessionId: this.externalSessionId })
  }

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void> {
    const pending = this.permissions.get(interactionId)
    if (!pending) throw new Error('This approval is no longer pending.')
    this.permissions.delete(interactionId)
    pending.resolve(answer.kind === 'option' ? { outcome: { outcome: 'selected', optionId: answer.optionId } } : { outcome: { outcome: 'cancelled' } })
    this.events.push({ type: 'interaction.resolved', interactionId, by: 'aa' })
  }

  async configure(change: ConfigChange): Promise<ConfigResult> {
    const response = await this.conn.setSessionConfigOption({ sessionId: this.externalSessionId, configId: change.configId, value: change.value })
    this.configOptions = [...response.configOptions]
    return { catalogs: catalogsOf(this.configOptions) }
  }

  async command(name: string): Promise<CommandResult> {
    return { ok: false, message: `DSH direct mode has no command /${name}.` }
  }

  /** Waits until no turn is running and the local queue is empty (route handoff, DSH-5). */
  async drained(): Promise<void> {
    while (this.running || this.queue.length) {
      await new Promise<void>(resolve => {
        const iterator = setInterval(() => { if (!this.running) { clearInterval(iterator); resolve() } }, 20)
        iterator.unref?.()
      })
    }
  }

  /** Releases DSH's write lock (`session/close`) and ends the event stream. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } })
    this.permissions.clear()
    this.queue.length = 0
    try { await this.conn.closeSession({ sessionId: this.externalSessionId }) } catch { /* the process may be gone */ }
    this.events.end()
    this.onClose()
  }
}

export function toPromptBlocks(input: PromptInput, capabilities: SessionCapabilities): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = []
  if (input.text) blocks.push({ type: 'text', text: input.text })
  if (input.images?.length) {
    if (!capabilities['runtime.attachment']?.supported) throw new Error('DSH direct mode does not accept images with the current model.')
    for (const image of input.images) blocks.push({ type: 'image', mimeType: image.mimeType, data: image.data })
  }
  if (input.files?.length) throw new Error('DSH direct mode does not accept file attachments.')
  if (!blocks.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim()))) {
    // DSH rejects empty prompts (-32602); fail before queueing.
    throw new Error('A DSH prompt needs text or an image.')
  }
  return blocks
}

function errorMessage(error: unknown): string {
  if (error instanceof acp.RequestError) return error.message
  return error instanceof Error ? error.message : String(error)
}
