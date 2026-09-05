import type { WorkspaceSessionView } from "@/components/workspace-context"
import { compareSessionListOrder } from "@/components/session/session-list-order"
import type { ProjectView } from "@/features/dashboard/types"
import { filterSessions, type FilterValue } from "@/lib/demo-api"

import {
  projectHasVisibleSessions,
  projectSessionMatchesStatus,
  type ProjectSessionStatusFilter,
} from "./project-visibility"

export type { ProjectSessionStatusFilter } from "./project-visibility"

function timestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function sortProjects(items: ProjectView[]): ProjectView[] {
  return [...items].sort((left, right) => {
    const pinnedDelta = timestamp(right.pinnedAt) - timestamp(left.pinnedAt)
    if (pinnedDelta !== 0) return pinnedDelta
    const activityDelta = timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt)
    if (activityDelta !== 0) return activityDelta
    return left.name.localeCompare(right.name)
  })
}

export function sortProjectsByCreatedAt(items: ProjectView[]): ProjectView[] {
  return [...items].sort((left, right) => {
    const createdDelta = timestamp(right.createdAt) - timestamp(left.createdAt)
    if (createdDelta !== 0) return createdDelta
    const nameDelta = left.name.localeCompare(right.name)
    if (nameDelta !== 0) return nameDelta
    return left.id.localeCompare(right.id)
  })
}

export function sortSidebarSessions(items: WorkspaceSessionView[]): WorkspaceSessionView[] {
  // WorkspaceContext already owns the presentation order, including the
  // one-second optimistic placement after a local send. Filtering must keep
  // that order instead of sorting a second time without its optimistic state.
  return [...items]
}

export function selectPinnedProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): ProjectView[] {
  return sortProjects(
    projects.filter((project) => project.pinned && projectHasVisibleSessions(project, sessions, status)),
  )
}

export function selectRegularProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): ProjectView[] {
  return sortProjectsByCreatedAt(
    projects.filter((project) => !project.pinned && projectHasVisibleSessions(project, sessions, status)),
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
