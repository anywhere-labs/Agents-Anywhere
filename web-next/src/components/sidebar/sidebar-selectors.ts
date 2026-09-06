import type { WorkspaceSessionView } from "@/components/workspace-context"
import { compareSessionListOrder } from "@/components/session/session-list-order"
import type { ProjectView } from "@/features/dashboard/types"
import { filterSessions, type FilterValue } from "@/lib/demo-api"
import { sortProjectsBySessionActivity } from "./project-list-order"

import {
  projectHasVisibleSessions,
  projectSessionMatchesStatus,
  type ProjectSessionStatusFilter,
} from "./project-visibility"

export type { ProjectSessionStatusFilter } from "./project-visibility"

export function sortSidebarSessions(items: WorkspaceSessionView[]): WorkspaceSessionView[] {
  // WorkspaceContext owns the presentation order, including optimistic sends.
  return [...items]
}

export function selectPinnedProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): ProjectView[] {
  return sortProjectsBySessionActivity(
    projects.filter((project) => project.pinned && projectHasVisibleSessions(project, sessions, status)),
    sessions,
  )
}

export function selectRegularProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): ProjectView[] {
  return sortProjectsBySessionActivity(
    projects.filter((project) => !project.pinned && projectHasVisibleSessions(project, sessions, status)),
    sessions,
  )
}

export function selectPinnedSessions(
  sessions: WorkspaceSessionView[],
): WorkspaceSessionView[] {
  return sortSidebarSessions(
    sessions.filter((session) => session.pinned && !session.archived),
  )
}

export function selectRecentSessions(
  sessions: WorkspaceSessionView[],
  filter: FilterValue,
  search: string,
): WorkspaceSessionView[] {
  return sortSidebarSessions(
    filterSessions(
      sessions.filter((session) => !session.projectId),
      filter,
      search,
    ).filter((session) => session.archived || !session.pinned) as WorkspaceSessionView[],
  )
}

export function selectAllSessions(
  sessions: WorkspaceSessionView[],
  filter: FilterValue,
  search: string,
): WorkspaceSessionView[] {
  return sortSidebarSessions(
    filterSessions(sessions, filter, search).filter((session) => session.archived || !session.pinned),
  )
}

export function selectProjectSessions(
  sessions: WorkspaceSessionView[],
  currentSessionsById: Map<string, WorkspaceSessionView>,
  status: ProjectSessionStatusFilter = "active",
): WorkspaceSessionView[] {
  const currentSessions = sessions.map(
    (session) => currentSessionsById.get(session.id) ?? session,
  )
  const filtered = currentSessions.filter((session) => projectSessionMatchesStatus(session, status))
  const currentOrder = new Map(
    Array.from(currentSessionsById.keys()).map((id, index) => [id, index]),
  )

  return [...filtered].sort((left, right) => {
    const leftIndex = currentOrder.get(left.id)
    const rightIndex = currentOrder.get(right.id)
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex
    if (leftIndex !== undefined) return -1
    if (rightIndex !== undefined) return 1
    return compareSessionListOrder(left, right)
  })
}
