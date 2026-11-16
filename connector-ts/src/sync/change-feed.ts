import type { ChangeFeed, ChangeNotice } from '../application/ports/index.js'

/** In-memory ChangeFeed: notices go to the session's listeners and to `*` listeners, synchronously. */
export class MemoryChangeFeed implements ChangeFeed {
  private readonly listeners = new Map<string, Set<(notice: ChangeNotice) => void>>()

  public publish(notice: ChangeNotice): void {
    for (const key of [notice.sessionId, '*']) {
      for (const listener of [...(this.listeners.get(key) ?? [])]) {
        try {
          listener(notice)
        } catch {
          // A broken subscriber must not stop the others or the commit that published.
        }
      }
    }
  }

  public subscribe(sessionId: string, listener: (notice: ChangeNotice) => void): () => void {
    let set = this.listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  public subscriberCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0
  }
}
