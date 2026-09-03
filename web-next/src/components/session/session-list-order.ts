export type SessionListOrderValue = {
  id: string
  status: string
  sortAt?: string | null
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
): number {
  const leftRunning = sessionStatusIsRunning(left.status)
  const rightRunning = sessionStatusIsRunning(right.status)

  if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
  if (leftRunning) return compareAscii(left.id, right.id)

  return (
    sessionSortMillis(right) - sessionSortMillis(left) ||
    compareAscii(right.id, left.id)
  )
}

export function sortSessionViews<T extends SessionListOrderValue>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compareSessionListOrder)
}
