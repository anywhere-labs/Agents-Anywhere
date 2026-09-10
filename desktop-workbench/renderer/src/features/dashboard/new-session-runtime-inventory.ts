import type { DeviceRuntimeView } from "@/features/dashboard/types"

const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const

export type RuntimeInventoryRetryScheduler = {
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
}

type WatchNewSessionRuntimeInventoryOptions = {
  connectorIds: readonly string[]
  load: (connectorId: string) => Promise<DeviceRuntimeView[]>
  onUpdate: (connectorId: string, runtimes: DeviceRuntimeView[]) => void
  onInitialSettled: () => void
  retryDelaysMs?: readonly number[]
  scheduler?: RuntimeInventoryRetryScheduler
}

const defaultScheduler: RuntimeInventoryRetryScheduler = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The Server publishes connector presence before runtime discovery/reconciliation
 * finishes. During that short window a successful inventory response can be empty
 * or contain an active runtime that is not running yet.
 */
export function runtimeInventoryNeedsReconnectSettling(
  runtimes: readonly DeviceRuntimeView[],
): boolean {
  if (runtimes.length === 0) return true
  const active = runtimes.filter((runtime) => runtime.configured && runtime.active)
  return active.some((runtime) => runtime.status !== "running")
}

/**
 * Load each newly-online connector immediately, then retry only inventories that
 * still look mid-reconnect. Retries are bounded and independently cancellable so
 * dashboard snapshots cannot create an unbounded request loop or publish stale UI.
 */
export function watchNewSessionRuntimeInventory({
  connectorIds,
  load,
  onUpdate,
  onInitialSettled,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  scheduler = defaultScheduler,
}: WatchNewSessionRuntimeInventoryOptions): () => void {
  const pendingInitial = new Set(connectorIds)
  const timers = new Set<unknown>()
  let stopped = false
  let initialSettled = false

  const settleInitial = (connectorId: string) => {
    pendingInitial.delete(connectorId)
    if (initialSettled || pendingInitial.size > 0) return
    initialSettled = true
    onInitialSettled()
  }

  const poll = async (connectorId: string, attempt: number): Promise<void> => {
    let shouldRetry = true
    try {
      const runtimes = await load(connectorId)
      if (stopped) return
      onUpdate(connectorId, runtimes)
      shouldRetry = runtimeInventoryNeedsReconnectSettling(runtimes)
    } catch {
      if (stopped) return
      // The online snapshot can race the HTTP path becoming ready. A bounded
      // retry is safe here; permanent failures stop after the same small window.
    }

    settleInitial(connectorId)
    const delayMs = shouldRetry ? retryDelaysMs[attempt] : undefined
    if (delayMs === undefined || stopped) return

    let handle: unknown
    handle = scheduler.schedule(() => {
      timers.delete(handle)
      if (!stopped) void poll(connectorId, attempt + 1)
    }, delayMs)
    timers.add(handle)
  }

  const uniqueConnectorIds = [...new Set(connectorIds)]
  if (uniqueConnectorIds.length === 0) {
    initialSettled = true
    onInitialSettled()
  } else {
    for (const connectorId of uniqueConnectorIds) void poll(connectorId, 0)
  }

  return () => {
    stopped = true
    for (const handle of timers) scheduler.cancel(handle)
    timers.clear()
  }
}
