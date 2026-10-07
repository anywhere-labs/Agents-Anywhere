export type SessionListOrderValue = {
  id: string
  status: string
  sortAt?: string | null
  /** Time of the last user-visible timeline item; preferred recency key. */
  lastItemAt?: string | null
}

export type SessionListOrderOptions = {
  now?: number
  optimisticTopUntil?: ReadonlyMap<string, number>
}

/**
 * Statuses that mean "the Agent is still working on (or blocked in) this
 * session". Shared by the list order, the row indicator and the
 * "in progress" sidebar view so a session never jumps between the pinned
 * active group and the recency group while its status flaps.
 */
export const ACTIVE_SESSION_STATUSES: readonly string[] = [
  "running",
  "waiting",
  "pending",
  "stopping",
  "waiting_approval",
  "blocked",
]

export function sessionStatusIsActive(status: string): boolean {
  return ACTIVE_SESSION_STATUSES.includes(status)
}

/** Kept for callers that only care about the spinner subset. */
export function sessionStatusIsRunning(status: string): boolean {
  return status === "running"
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function millis(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Recency key for sessions that are not actively working. The last
 * user-visible timeline item wins so background-only syncs (status flips,
 * inventory refreshes that advance `sortAt`) no longer reshuffle the list;
 * `sortAt` remains the fallback for sessions without any item yet.
 */
function sessionRecencyMillis(session: SessionListOrderValue): number {
  return millis(session.lastItemAt) || millis(session.sortAt)
}

export function compareSessionListOrder(
  left: SessionListOrderValue,
  right: SessionListOrderValue,
  options: SessionListOrderOptions = {},
): number {
  const now = options.now ?? Date.now()
  const leftActive =
    sessionStatusIsActive(left.status) ||
    (options.optimisticTopUntil?.get(left.id) ?? 0) > now
  const rightActive =
    sessionStatusIsActive(right.status) ||
    (options.optimisticTopUntil?.get(right.id) ?? 0) > now

  if (leftActive !== rightActive) return leftActive ? -1 : 1
  // Within the active group order is fixed by id: status flips and syncs
  // never reshuffle working sessions.
  if (leftActive) return compareAscii(left.id, right.id)

  return (
    sessionRecencyMillis(right) - sessionRecencyMillis(left) ||
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
