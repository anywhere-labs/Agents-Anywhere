/** One published item; `seq` grows by one per item of the hub. */
export interface Sequenced<T> {
  readonly seq: number
  readonly kind: string
  readonly item: T
}

class Subscription<T> {
  private readonly items: Sequenced<T>[]
  private wake: (() => void) | null = null
  public closed = false

  public constructor(private readonly hub: EventHub<T>, replay: readonly Sequenced<T>[], private readonly capacity: number) {
    this.items = [...replay]
  }

  public push(event: Sequenced<T>): void {
    if (this.hub.coalescing.has(event.kind)) {
      // Only the newest state matters; a stale one must not follow it.
      for (let index = this.items.length - 1; index >= 0; index--) if (this.items[index]!.kind === event.kind) this.items.splice(index, 1)
    } else if (this.items.length >= this.capacity) this.items.shift()
    this.items.push(event)
    this.wake?.()
  }

  public async *drain(signal: AbortSignal): AsyncGenerator<Sequenced<T>> {
    const onAbort = (): void => this.wake?.()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        const next = this.items.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>(resolve => {
          this.wake = () => {
            this.wake = null
            resolve()
          }
          if (signal.aborted || this.closed) this.wake()
        })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.close()
    }
  }

  public close(): void {
    this.closed = true
    this.wake?.()
    this.hub.unsubscribe(this)
  }
}

/**
 * A ring of recent events plus live subscribers (ported from the v2 Connector's `mesh/events.py`): a subscriber
 * replays what it missed after `since`, then follows; each has a bounded queue that drops its oldest item, and the
 * coalescing kinds keep only their newest item.
 */
export class EventHub<T> {
  private seq = 0
  private readonly ring: Sequenced<T>[] = []
  private readonly subscribers = new Set<Subscription<T>>()
  public readonly coalescing: ReadonlySet<string>

  public constructor(private readonly options: { history: number; capacity: number; coalescing?: readonly string[] }) {
    this.coalescing = new Set(options.coalescing ?? [])
  }

  public get lastSeq(): number {
    return this.seq
  }

  public publish(kind: string, item: T): void {
    const event: Sequenced<T> = { seq: ++this.seq, kind, item }
    this.ring.push(event)
    if (this.ring.length > this.options.history) this.ring.shift()
    for (const subscriber of [...this.subscribers]) subscriber.push(event)
  }

  /** Replays the events after `since` (the whole ring for a fresh stream), then follows until `signal` aborts. */
  public subscribe(since: number | null, signal: AbortSignal): AsyncGenerator<Sequenced<T>> {
    const replay = since === null ? this.ring : this.ring.filter(event => event.seq > since)
    const subscription = new Subscription(this, replay, this.options.capacity)
    this.subscribers.add(subscription)
    return subscription.drain(signal)
  }

  public unsubscribe(subscription: Subscription<T>): void {
    this.subscribers.delete(subscription)
  }

  public get subscriberCount(): number {
    return this.subscribers.size
  }
}
