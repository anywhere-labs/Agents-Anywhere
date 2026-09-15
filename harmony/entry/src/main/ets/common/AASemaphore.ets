/**
 * Counting semaphore.
 *
 * Android uses `kotlinx.coroutines.sync.Semaphore` to cap how many project
 * session reads run at once. HarmonyOS has no equivalent, so this is the small
 * piece needed to keep the same concurrency budget: at most N callers proceed,
 * the rest queue in arrival order.
 */
export class AASemaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.available = permits > 0 ? permits : 1;
  }

  /** Resolves once a permit is held; the caller must release it. */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next: (() => void) | undefined = this.waiters.shift();
    if (next !== undefined) {
      // Hand the permit straight to the next waiter instead of releasing it.
      next();
      return;
    }
    this.available += 1;
  }

  /** Runs `action` with a permit held, releasing it even when the action throws. */
  async withPermit<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await action();
    } finally {
      this.release();
    }
  }
}
