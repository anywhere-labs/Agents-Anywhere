// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/sessions.py @98dd0e6e5 (_new_context, _interaction, _watch, _close_context)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/interactions.py @98dd0e6e5 (InteractionService.open, close_scope)
//
// The native session a preparation holds. Until the creation, this consumes its events (the Agent's requests,
// option and command catalog changes, the session going away); the creation then gets the same event stream,
// starting with the latest options and commands and the requests still open. The requests live in memory only:
// a restart closes the Agent session they belong to.

import type { FrozenCreation, InteractionAnswer, PreparedSession, RuntimeEvent, RuntimeSession } from '../ports/index.js'

type Opened = Extract<RuntimeEvent, { type: 'interaction.opened' }>

/** A request the Agent made during the preparation, scoped to the preparation. */
export interface PreparationInteraction {
  readonly event: Opened
  status: 'open' | 'answered' | 'cancelled' | 'expired'
  revision: number
  responseOperationId: string | null
}

/** Append-only event relay: one producer, one consumer. */
class Relay<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.buffer.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

export interface LivePreparationHooks {
  /** The Agent reported options other than the ones it opened with. */
  readonly configurationChanged: () => void
  /** The native session is gone (process exit, Runtime stop): the preparation can no longer be reserved. */
  readonly lost: () => void
}

export class LivePreparation {
  readonly interactions = new Map<string, PreparationInteraction>()
  private readonly iterator: AsyncIterator<RuntimeEvent>
  private relay: Relay<RuntimeEvent> | null = null
  private ended = false
  private closing: Promise<void> | null = null
  private adopted = false
  private configDigest: string
  /** The latest options, commands and capabilities, replayed to the session engine on hand-over. */
  private readonly latest = new Map<'config.updated' | 'commands.updated' | 'capabilities.changed', RuntimeEvent>()

  constructor(readonly prepared: PreparedSession, private readonly hooks: LivePreparationHooks) {
    this.configDigest = JSON.stringify(prepared.configOptions)
    this.iterator = prepared.events[Symbol.asyncIterator]()
    void this.pump()
  }

  /** The native session is alive, neither handed over nor closed. */
  get alive(): boolean {
    return !this.ended && this.closing === null && !this.adopted
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const next = await this.iterator.next()
        if (next.done === true) break
        if (this.relay !== null) this.relay.push(next.value)
        else this.observe(next.value)
      }
    } catch {
      // The session's stream failed: it is gone either way.
    } finally {
      this.ended = true
      this.relay?.close()
      if (this.relay === null) this.dropInteractions('cancelled')
      if (!this.adopted && this.closing === null) this.hooks.lost()
    }
  }

  private observe(event: RuntimeEvent): void {
    switch (event.type) {
      case 'interaction.opened':
        this.interactions.set(event.interactionId, { event, status: 'open', revision: 1, responseOperationId: null })
        return
      case 'interaction.resolved': {
        const interaction = this.interactions.get(event.interactionId)
        if (interaction !== undefined && interaction.status === 'open') {
          interaction.status = event.resolution === 'answered' ? 'answered' : event.resolution === 'expired' ? 'expired' : 'cancelled'
          interaction.revision += 1
        }
        return
      }
      case 'config.updated': {
        this.latest.set(event.type, event)
        const digest = JSON.stringify(event.options)
        if (digest !== this.configDigest) {
          this.configDigest = digest
          this.hooks.configurationChanged()
        }
        return
      }
      case 'commands.updated':
      case 'capabilities.changed':
        this.latest.set(event.type, event)
        return
      case 'session.lost':
        this.ended = true
        return
      default:
        // Nothing else happens before the first message; a stray item has no session to land in yet.
        return
    }
  }

  private dropInteractions(status: 'cancelled' | 'expired'): void {
    for (const interaction of this.interactions.values()) {
      if (interaction.status !== 'open') continue
      interaction.status = status
      interaction.revision += 1
    }
  }

  async respond(interactionId: string, answer: InteractionAnswer): Promise<void> {
    await this.prepared.respond(interactionId, answer)
  }

  /**
   * Hands the session over to the session engine under `sessionId`: from now on its events go to the returned stream
   * (first what a new session needs: the latest options, commands and still open requests). Null when it is gone.
   */
  async adopt(sessionId: string, frozen: FrozenCreation): Promise<{ session: RuntimeSession; events: AsyncIterable<RuntimeEvent> } | null> {
    if (!this.alive) return null
    this.adopted = true
    const relay = new Relay<RuntimeEvent>()
    for (const event of this.latest.values()) relay.push(event)
    for (const interaction of this.interactions.values()) if (interaction.status === 'open') relay.push(interaction.event)
    this.relay = relay
    if (this.ended) relay.close()
    try {
      return { session: await this.prepared.adopt(sessionId, frozen), events: relay }
    } catch (error) {
      relay.close()
      await this.prepared.close().catch(() => undefined)
      throw error
    }
  }

  /** Closes the Agent session (cancel, expiry, stop); open requests are answered as cancelled. */
  close(): Promise<void> {
    if (this.adopted) return Promise.resolve()
    this.closing ??= (async () => {
      this.dropInteractions('cancelled')
      await this.prepared.close().catch(() => undefined)
    })()
    return this.closing
  }
}
