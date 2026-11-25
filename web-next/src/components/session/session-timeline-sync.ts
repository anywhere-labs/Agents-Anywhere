import type { SessionRuntimeState } from "@/features/dashboard/types"

/** Minimum gap between two timeline sync requests for one session across opens. */
export const TIMELINE_SYNC_COOLDOWN_MS = 30_000

/** How long a request that has not settled still counts as in flight. */
export const TIMELINE_SYNC_INFLIGHT_TTL_MS = 90_000

/**
 * Whether the runtime asks the client to request this session's earlier history.
 *
 * A runtime whose history only arrives after such a request declares it on the
 * session's runtime state as `metadata.sync.requires_timeline_sync`, the same
 * `sync` object runtimes put in session inventory metadata. Nothing here
 * depends on a runtime type.
 */
export function sessionRequiresTimelineSync(state: SessionRuntimeState | null | undefined): boolean {
  const sync = state?.metadata?.sync
  if (typeof sync !== "object" || sync === null) return false
  return (sync as Record<string, unknown>).requires_timeline_sync === true
}

export type TimelineSyncScheduler = {
  /** Runs `send` unless one is in flight or the last one ran within the cooldown. */
  request(sessionId: string, send: () => Promise<unknown>): boolean
}

/** Per account/server, so it outlives the controller of a single open. */
export function createTimelineSyncScheduler(
  options: { cooldownMs?: number; inflightTtlMs?: number; now?: () => number } = {},
): TimelineSyncScheduler {
  const cooldownMs = options.cooldownMs ?? TIMELINE_SYNC_COOLDOWN_MS
  const inflightTtlMs = options.inflightTtlMs ?? TIMELINE_SYNC_INFLIGHT_TTL_MS
  const now = options.now ?? Date.now
  const inflight = new Map<string, { startedAt: number }>()
  const requestedAt = new Map<string, number>()
  return {
    request(sessionId, send) {
      const at = now()
      // The server gives up on the connector after a minute and the client has
      // no request timeout, so a request this old is abandoned, not pending.
      const pending = inflight.get(sessionId)
      if (pending && at - pending.startedAt < inflightTtlMs) return false
      const last = requestedAt.get(sessionId)
      const elapsed = last === undefined ? null : at - last
      if (elapsed !== null && elapsed >= 0 && elapsed < cooldownMs) return false
      for (const [id, requested] of requestedAt) {
        if (at - requested >= cooldownMs) requestedAt.delete(id)
      }
      const request = { startedAt: at }
      inflight.set(sessionId, request)
      requestedAt.set(sessionId, at)
      // Fire-and-forget: the history arrives over the live stream, and a
      // failure must never surface in the session.
      void Promise.resolve()
        .then(send)
        .catch(() => undefined)
        .finally(() => {
          if (inflight.get(sessionId) === request) inflight.delete(sessionId)
        })
      return true
    },
  }
}
