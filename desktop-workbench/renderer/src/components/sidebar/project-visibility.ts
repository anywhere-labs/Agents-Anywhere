import type { ProjectView } from "@/features/dashboard/types"

export type ProjectSessionStatusFilter = "active" | "archived" | "all"

type ProjectSession = {
  projectId?: string | null
  archived: boolean
  pinned: boolean
}

export function projectSessionMatchesStatus(
  session: ProjectSession,
  status: ProjectSessionStatusFilter,
): boolean {
  if (status === "archived") return session.archived
  if (status === "all") return session.archived || !session.pinned
  return !session.archived && !session.pinned
}

export function projectHasVisibleSessions(
  project: Pick<ProjectView, "id" | "manuallyCreated" | "sidebarSessionCounts">,
  sessions: readonly ProjectSession[],
  status: ProjectSessionStatusFilter,
): boolean {
  if (project.manuallyCreated) return true

  // These counts cover all pages, including projects the user has not expanded.
  const counts = project.sidebarSessionCounts
  if (counts) {
    if (status === "archived") return counts.archived > 0
    if (status === "all") return counts.active + counts.archived > 0
    return counts.active > 0
  }

  return sessions.some(
    (session) => session.projectId === project.id && projectSessionMatchesStatus(session, status),
  )
}
