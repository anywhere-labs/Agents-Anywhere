// ported from effi-crew cloud/agentd/src/conv/sync.ts @30f8334 (Coalescer)
//
// Throttles commits of streaming output: the first change goes at once, later changes at most every
// `intervalMs`, the last one always. The default is 100 ms, the window in which assistant text is merged, and it
// applies before the store: a delta stream becomes one SQLite commit (and one clock tick) per item per window,
// not one per token.

export class Coalescer {
  private readonly dirty = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFlush = Number.NEGATIVE_INFINITY

  public constructor(
    private readonly flushMany: (ids: string[]) => void,
    private readonly intervalMs = 100,
    private readonly now: () => number = () => performance.now(),
  ) {}

  public mark(id: string): void {
    this.dirty.add(id)
    if (this.timer !== undefined) return
    const wait = this.lastFlush + this.intervalMs - this.now()
    if (wait <= 0) {
      this.flush()
    } else {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, wait)
    }
  }

  /** Commit everything marked now (turn end, interaction opened, …). */
  public flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.dirty.size === 0) return
    this.lastFlush = this.now()
    const ids = [...this.dirty]
    this.dirty.clear()
    this.flushMany(ids)
  }

  /** Forget an item without committing it. */
  public drop(id: string): void {
    this.dirty.delete(id)
  }

  public get pending(): number {
    return this.dirty.size
  }

  public dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.dirty.clear()
  }
}
