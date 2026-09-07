/** The official sidebar predicate, including its selected blank-session exception. */
export function sessionVisible(session: { id: string, origin?: string, blank: boolean },
  archived: ReadonlySet<string>, current: ReadonlySet<string>): boolean {
  return session.origin !== 'subagent' && !archived.has(session.id)
    && (!session.blank || current.has(session.id))
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
