export async function retryWithDelays<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[],
  shouldRetry: (error: unknown) => boolean,
  wait: (delayMs: number) => Promise<void> = waitFor,
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      const delayMs = delaysMs[attempt]
      if (delayMs === undefined || !shouldRetry(error)) throw error
      await wait(delayMs)
      attempt += 1
    }
  }
}

export function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 0
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
}
