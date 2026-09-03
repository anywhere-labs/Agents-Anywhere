export type ConnectorPresenceTransition = {
  online: boolean
  reconnected: boolean
}

type PollScheduler = {
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
}

type WatchConnectorPresenceOptions = {
  check: () => Promise<boolean>
  onTransition: (transition: ConnectorPresenceTransition) => void
  initialOnline: boolean
  intervalMs: number
  scheduler?: PollScheduler
}

const browserScheduler: PollScheduler = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(
    handle as ReturnType<typeof globalThis.setTimeout>,
  ),
}

/**
 * Poll connector presence without overlapping checks. The returned cleanup
 * function also fences an in-flight response so an old dialog cannot update a
 * newly opened pairing flow.
 */
export function watchConnectorPresence({
  check,
  onTransition,
  initialOnline,
  intervalMs,
  scheduler = browserScheduler,
}: WatchConnectorPresenceOptions): () => void {
  let stopped = false
  let lastOnline = initialOnline
  let timer: unknown = null

  const scheduleNext = () => {
    if (stopped) return
    timer = scheduler.schedule(() => {
      timer = null
      void poll()
    }, intervalMs)
  }

  const poll = async () => {
    let online = false
    try {
      online = await check()
    } catch {
      online = false
    }
    if (stopped) return

    if (online !== lastOnline) {
      const reconnected = online && !lastOnline
      lastOnline = online
      onTransition({ online, reconnected })
    }
    scheduleNext()
  }

  scheduleNext()
  return () => {
    if (stopped) return
    stopped = true
    if (timer !== null) scheduler.cancel(timer)
    timer = null
  }
}
