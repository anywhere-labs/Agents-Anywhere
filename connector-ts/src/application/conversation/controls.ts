import { admitSteer, runtimeStateWire } from '../../domain/conversation/index.js'
import { UseCaseError } from '../errors.js'
import type { ConfigOption, PromptAttachment } from '../ports/index.js'
import type { RuntimeBindings } from '../session/bindings.js'
import type { DeliveryRecords } from '../session/deliveries.js'
import type { SessionKernel } from '../session/kernel.js'
import { digestOf, type CommandContext } from '../session/receipts.js'
import type { SendMessageCommand } from './messages.js'

/** What a client does to a running session besides sending: steer the turn, change selections, interrupt. */
export class SessionControls {
  public constructor(private readonly kernel: SessionKernel, private readonly bindings: RuntimeBindings, private readonly deliveries: DeliveryRecords) {}

  public async steer(command: SendMessageCommand, context: CommandContext): Promise<{ outcome: string }> {
    const kernel = this.kernel
    const deps = kernel.deps
    return kernel.serial(command.sessionId, async () => {
      const session = await kernel.requireSession(command.sessionId)
      const binding = await this.bindings.binding(command.sessionId)
      admitSteer({ status: session.status, steerSupported: binding.session.steer !== undefined })
      const at = deps.clock.nowIso()
      const refs = command.attachments ?? []
      const received = await deps.store.deliveries.receive({
        sessionId: command.sessionId, clientMessageId: command.clientMessageId,
        inputDigest: context.inputDigest ?? digestOf(refs.length > 0 ? { steer: command.content, attachments: refs } : { steer: command.content }),
        userItem: null, enqueue: null, commandId: context.commandId, at,
      })
      if (received.duplicate) return { outcome: `duplicate:${received.delivery.state}` }
      kernel.countUsage(session, 'message.sent')
      // Attachments first, as for a message: one that cannot be fetched is a rejection the Runtime never saw.
      let attachments: PromptAttachment[]
      try {
        attachments = deps.attachments === undefined ? [] : await Promise.all(refs.map(ref => this.deliveries.resolveAttachment(command.sessionId, ref)))
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'attachment_unavailable'
        await deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'rejected', { at: deps.clock.nowIso(), errorCode: code })
        throw new UseCaseError(code, (error as Error)?.message ?? code)
      }
      await deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'sending', { at })
      const input = { text: command.content, ...(attachments.length > 0 ? { attachments } : {}) }
      const result = await binding.session.steer!(input, { deliveryId: command.clientMessageId, clientMessageId: command.clientMessageId })
      if (result.outcome === 'injected' || result.outcome === 'started_new_turn') {
        await deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'started', { at: deps.clock.nowIso() })
      } else if (result.outcome === 'rejected' || result.outcome === 'prompt_required') {
        await deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'rejected', { at: deps.clock.nowIso(), errorCode: result.outcome === 'rejected' ? result.error.code : 'prompt_required' })
      } else {
        await deps.store.deliveries.transition(command.sessionId, command.clientMessageId, 'unknown', { at: deps.clock.nowIso(), errorCode: result.error.code })
      }
      return { outcome: result.outcome }
    })
  }

  /** `session.select`: model, permission, mode or effort, through the Runtime's configuration options. */
  public async select(sessionId: string, change: { optionId: string; value: string | boolean }): Promise<Record<string, unknown>> {
    return this.kernel.serial(sessionId, async () => {
      await this.kernel.requireSession(sessionId)
      const binding = await this.bindings.binding(sessionId)
      const result = await binding.session.configure(change)
      this.kernel.emitSessionStatus(sessionId, { event: 'config.updated', options: result.options as unknown as Record<string, unknown>[] })
      return { appliesFrom: result.appliesFrom }
    })
  }

  /**
   * `session.selections.update`: `{model, permission, ...}` by catalog type, applied one after another (a
   * null value keeps the current choice). Answers with `updated`, `applied` (false when a change
   * waits for the next turn), the values applied and the runtime `state` with the selections after them.
   */
  public async updateSelections(sessionId: string, selections: Readonly<Record<string, string | boolean | null>>): Promise<Record<string, unknown>> {
    const entries = Object.entries(selections).filter((entry): entry is [string, string | boolean] => entry[1] !== null && entry[1] !== undefined)
    if (Object.keys(selections).length === 0) throw new UseCaseError('invalid_argument', 'selections is required')
    return this.kernel.serial(sessionId, async () => {
      await this.kernel.requireSession(sessionId)
      const changed: Record<string, string> = {}
      let options: readonly ConfigOption[] | null = null
      let applied = true
      if (entries.length > 0) {
        const binding = await this.bindings.binding(sessionId)
        for (const [optionId, value] of entries) {
          const result = await binding.session.configure({ optionId, value })
          options = result.options
          if (result.appliesFrom !== 'now') applied = false
          changed[optionId] = String(value)
        }
        this.kernel.emitSessionStatus(sessionId, { event: 'config.updated', options: (options ?? []) as unknown as Record<string, unknown>[] })
      }
      const session = await this.kernel.requireSession(sessionId)
      return {
        updated: true,
        applied,
        sessionId,
        externalSessionId: session.externalSessionId,
        selections: changed,
        state: runtimeStateWire(session, { ...selectionsOf(options ?? []), ...changed }),
      }
    })
  }

  public async interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
    const session = await this.kernel.requireSession(sessionId)
    const binding = this.bindings.get(sessionId) ?? await this.bindings.binding(sessionId)
    await binding.session.cancel(session.activeTurn?.turnId)
    if (session.status !== 'idle') await this.kernel.patchSession(sessionId, { status: 'stopping' })
    return { interrupted: true }
  }
}

/** Catalog selections (`{model, permission, ...}`) the Runtime's configuration options currently hold. */
function selectionsOf(options: readonly ConfigOption[]): Record<string, string> {
  const selections: Record<string, string> = {}
  for (const option of options) {
    if (option.type !== 'select' || typeof option.currentValue !== 'string') continue
    if (option.category === 'model' || option.category === 'permission' || option.category === 'effort' || option.category === 'mode') {
      selections[option.category] ??= option.currentValue
    }
  }
  return selections
}
