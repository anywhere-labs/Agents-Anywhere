import type { WorkspaceSessionView } from "@/components/workspace-context"

/**
 * How many recent sessions the sidebar renders before collapsing the rest
 * behind a "show more" row.
 *
 * The rest are hidden behind a button rather than dropped, because a list that
 * silently stops at N is indistinguishable from data loss — the complaint
 * Codex users filed against exactly this behaviour (openai/codex#23246).
 */
export const SIDEBAR_RECENT_SESSION_LIMIT = 50

export type CappedSessions<T> = {
  visible: T[]
  hiddenCount: number
}

/**
 * Truncate a sorted session list for sidebar rendering.
 *
 * The caller passes the list already ordered by `compareSessionListOrder`,
 * which floats running sessions to the top, so the cap never hides a session
 * that is actively doing work. Pinned sessions render in their own section and
 * never reach here at all.
 *
 * The session the user currently has open is always kept, even when it sorts
 * past the cut. Dropping it would leave the sidebar with no highlighted row
 * while its conversation fills the screen.
 */
export function capRecentSessions<T extends Pick<WorkspaceSessionView, "id">>(
  sessions: T[],
  {
    expanded,
    activeSessionId = null,
    limit = SIDEBAR_RECENT_SESSION_LIMIT,
  }: {
    expanded: boolean
    activeSessionId?: string | null
    limit?: number
  },
): CappedSessions<T> {
  if (expanded || sessions.length <= limit) {
    return { visible: sessions, hiddenCount: 0 }
  }
  const visible = sessions.slice(0, limit)
  const hidden = sessions.slice(limit)
  const active = activeSessionId
    ? hidden.find((session) => session.id === activeSessionId)
    : undefined
  if (active) {
    visible.push(active)
  }
  return { visible, hiddenCount: hidden.length - (active ? 1 : 0) }
}
