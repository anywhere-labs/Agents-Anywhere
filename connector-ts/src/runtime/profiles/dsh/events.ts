/** A push-to-pull event channel: adapters push RuntimeEvents, the session engine iterates them. */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly queue: T[] = []
  private waiters: ((result: IteratorResult<T>) => void)[] = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.queue.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters) waiter({ value: undefined, done: true })
    this.waiters = []
  }

  get closed(): boolean { return this.ended }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.queue.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
      return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }) },
    }
  }
}
