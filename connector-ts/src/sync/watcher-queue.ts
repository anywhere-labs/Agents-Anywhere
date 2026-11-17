// ported from effi-crew cloud/agentd/src/conv/sync.ts @30f8334 (WatcherQueue)
//
// One watcher's outbound queue: it keeps only the latest pending event per key, so a slow consumer never
// holds up the Runtime or other consumers. `push` replaces a queued event for the same key in place (keeping
// its position); `next` waits for the next event. v3 uses it for every server stream the device serves
// (`Sessions/watch`, `Link/attach`): what is sent is the state at send time, the latest by construction.

export class WatcherQueue<E> {
  private readonly pending = new Map<string, E>()
  private wake: (() => void) | undefined
  private closedWith: { error?: unknown } | undefined

  public constructor(private readonly keyOf: (event: E) => string) {}

  public push(event: E): void {
    if (this.closedWith !== undefined) return
    this.pending.set(this.keyOf(event), event)
    this.signal()
  }

  /** Replace everything still queued with `event` (a reset after the history changed). */
  public reset(event: E): void {
    if (this.closedWith !== undefined) return
    this.pending.clear()
    this.push(event)
  }

  public get size(): number {
    return this.pending.size
  }

  public get closed(): boolean {
    return this.closedWith !== undefined
  }

  /** End the stream: after the queued events (or with `error` at once). */
  public close(error?: unknown): void {
    if (this.closedWith !== undefined) return
    this.closedWith = error === undefined ? {} : { error }
    if (error !== undefined) this.pending.clear()
    this.signal()
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /** Next event, or `undefined` once closed and drained (or aborted). Throws the close error. */
  public async next(signal?: AbortSignal): Promise<E | undefined> {
    for (;;) {
      const first = this.pending.entries().next()
      if (first.done !== true) {
        const [key, event] = first.value
        this.pending.delete(key)
        return event
      }
      if (this.closedWith !== undefined) {
        if (this.closedWith.error !== undefined) throw this.closedWith.error
        return undefined
      }
      if (signal?.aborted === true) return undefined
      await new Promise<void>(resolve => {
        const onAbort = (): void => resolve()
        this.wake = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}
