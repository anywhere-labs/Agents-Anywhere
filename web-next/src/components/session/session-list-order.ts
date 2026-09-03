export type SessionListOrderValue = {
  id: string
  status: string
  sortAt?: string | null
}

export type SessionListOrderOptions = {
  now?: number
  optimisticTopUntil?: ReadonlyMap<string, number>
}

export function sessionStatusIsRunning(status: string): boolean {
  return status === "running"
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sessionSortMillis(session: SessionListOrderValue): number {
  if (!session.sortAt) return 0
  const value = Date.parse(session.sortAt)
  return Number.isFinite(value) ? value : 0
}

export function compareSessionListOrder(
  left: SessionListOrderValue,
  right: SessionListOrderValue,
  options: SessionListOrderOptions = {},
): number {
  const now = options.now ?? Date.now()
  const leftRunning =
    sessionStatusIsRunning(left.status) ||
    (options.optimisticTopUntil?.get(left.id) ?? 0) > now
  const rightRunning =
    sessionStatusIsRunning(right.status) ||
    (options.optimisticTopUntil?.get(right.id) ?? 0) > now

  if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
  if (leftRunning) return compareAscii(left.id, right.id)

  return (
    sessionSortMillis(right) - sessionSortMillis(left) ||
    compareAscii(right.id, left.id)
  )
}

export function sortSessionViews<T extends SessionListOrderValue>(
  sessions: readonly T[],
  options: SessionListOrderOptions = {},
): T[] {
  const resolvedOptions = {
    ...options,
    now: options.now ?? Date.now(),
  }
  return [...sessions].sort((left, right) =>
    compareSessionListOrder(left, right, resolvedOptions),
  )
}
