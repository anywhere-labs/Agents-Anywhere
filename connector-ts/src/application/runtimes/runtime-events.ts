import type { NativeHistory } from '../history.js'
import type { ConversationStore, IdSource, LiveEvents, Log, RuntimeHandle, RuntimeHandleEvent } from '../ports/index.js'
import { capabilitySet, runtimeCapabilities } from './capabilities.js'
import type { RuntimeCatalogMemory } from './catalog-memory.js'
import { nativeSessionId, type RuntimeInstanceSpec } from './instances.js'

/** Native session changes arrive in bursts (a CLI writes many records); one scan per quiet second. */
const SCAN_DEBOUNCE_MS = 1000

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error)
}

/** Native session scans, one at a time per Runtime and debounced, so a burst of changes is one scan. */
export class RuntimeScans {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private closed = false

  public constructor(private readonly history: NativeHistory, private readonly ids: IdSource, private readonly log: Log) {}

  public soon(runtimeId: string, delayMs = SCAN_DEBOUNCE_MS): void {
    if (this.closed) return
    clearTimeout(this.timers.get(runtimeId))
    const timer = setTimeout(() => {
      this.timers.delete(runtimeId)
      void this.now(runtimeId)
    }, delayMs)
    timer.unref()
    this.timers.set(runtimeId, timer)
  }

  public now(runtimeId: string): Promise<unknown> {
    const previous = this.chains.get(runtimeId) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (this.closed) return
      const result = await this.history.scan(runtimeId, this.ids.newId('scan_'))
      this.log('debug', `native sessions of ${runtimeId}: ${result.sessions}${result.complete ? '' : ' (incomplete)'}`)
    }).catch(error => this.log('warn', `scanning native sessions of ${runtimeId} failed: ${message(error)}`))
    this.chains.set(runtimeId, next)
    return next
  }

  public close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

export interface RuntimeEventContext {
  readonly spec: RuntimeInstanceSpec
  readonly handle: RuntimeHandle
  readonly event: RuntimeHandleEvent
  readonly live: LiveEvents
  readonly scans: RuntimeScans
  /** Opens a Conversation's Runtime session (the session engine's binding). */
  readonly conversations: { binding(sessionId: string): Promise<unknown> }
  readonly store: Pick<ConversationStore, 'sessions'>
  /** Keeps the last catalogs of each instance across restarts. */
  readonly catalogMemory?: RuntimeCatalogMemory
  readonly connectorId: string
  readonly log: Log
}

/** Runtime-level events: status and capabilities go to the Server live; native changes rescan; follow opens. */
export function runtimeEvent(context: RuntimeEventContext): void {
  const { spec, handle, event, live } = context
  switch (event.type) {
    case 'status':
      live.emit('runtime.status', { runtimeId: spec.runtimeId, status: { state: event.status, ...(event.error !== undefined ? { error: { ...event.error } } : {}) } })
      return
    case 'capabilities.changed':
      live.emit('runtime.status', { runtimeId: spec.runtimeId, status: { event: 'capabilities.changed' }, capabilities: capabilitySet(runtimeCapabilities(spec.runtimeType, event.capabilities), { runtime: spec.runtimeType, sessionId: null }) })
      return
    case 'catalogs.changed':
      void context.catalogMemory?.remember(spec, event.catalogs as Record<string, unknown>)
      live.emit('runtime.status', { runtimeId: spec.runtimeId, status: { event: 'catalogs.changed', catalogs: event.catalogs as Record<string, unknown> } })
      return
    case 'native_sessions.changed':
      context.scans.soon(spec.runtimeId)
      return
    case 'native_session.follow_suggested': {
      // The companion saw a native session that should be followed (a thread the Codex App opened): make sure it
      // is a Conversation, then open it so its live events are projected.
      const sessionId = nativeSessionId(context.connectorId, spec, { nativeSessionId: event.ref.nativeSessionId, ...(event.ref.locator !== undefined ? { locator: event.ref.locator } : {}) })
      void (async () => {
        if ((await context.store.sessions.get(sessionId)) === null) await context.scans.now(spec.runtimeId)
        if ((await context.store.sessions.get(sessionId)) === null) {
          context.log('info', `not following ${handle.type} session ${event.ref.nativeSessionId}: not in the native session list`)
          return
        }
        await context.conversations.binding(sessionId)
        context.log('info', `following ${handle.type} session ${event.ref.nativeSessionId} (${event.reason})`)
      })().catch(error => context.log('warn', `following ${event.ref.nativeSessionId} failed: ${message(error)}`))
      return
    }
  }
}
