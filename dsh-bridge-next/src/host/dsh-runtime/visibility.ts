import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionSyncScope } from '../../contracts/connector.js'

/** User-role context injections do not establish a user-created conversation. */
export function isUserMessage(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'user'
}

/** Whether an event is conversation content under the configured import scope.
 * `all` accepts every user/message event, including plugin and runtime context;
 * `human` keeps the original rule and ignores those injections. */
export function isSessionMessage(event: SessionEvent, scope: SessionSyncScope): boolean {
  return scope === 'all' ? event.type === 'user/message' : isUserMessage(event)
}

/** AA imports conversations that carry a message in the configured scope, independent of UI selection. */
export function sessionVisible(session: { id: string, origin?: string, hasMessage: boolean },
  archived: ReadonlySet<string>): boolean {
  return session.origin !== 'subagent' && !archived.has(session.id)
    && session.hasMessage
}

export class ClientPresence {
  private clients = new Map<string, { revision: number, current: string | null, expires: number }>()
  private timer: ReturnType<typeof setInterval>
  constructor(private changed: () => void) {
    this.timer = setInterval(() => {
      let changed = false
      for (const [id, client] of this.clients) if (client.expires <= Date.now()) {
        this.clients.delete(id); changed = true
      }
      if (changed) this.changed()
    }, 15_000)
    this.timer.unref()
  }
  report(id: string, revision: number, current: string | null): void {
    if (!id || id.length > 128 || !Number.isSafeInteger(revision) || revision < 0
      || (current !== null && (typeof current !== 'string' || current.length > 512))) throw new Error('Invalid client presence')
    const previous = this.clients.get(id)
    if (previous && revision < previous.revision) return
    this.clients.set(id, { revision, current, expires: Date.now() + 45_000 })
    if (!previous || previous.current !== current) this.changed()
  }
  selected(): Set<string> { return new Set([...this.clients.values()].flatMap(c => c.current ? [c.current] : [])) }
  close(): void { clearInterval(this.timer); this.clients.clear() }
}
