import type { WorkspaceSessionView } from "@/components/workspace-context"
import { compareSessionListOrder } from "@/components/session/session-list-order"
import type { ProjectView } from "@/features/dashboard/types"
import { filterSessions, type FilterValue } from "@/lib/demo-api"

export type ProjectSessionStatusFilter = "active" | "archived" | "all"

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
  // WorkspaceContext owns the presentation order, including optimistic sends.
  return [...items]
}

export function selectPinnedProjects(
  projects: ProjectView[],
  _sessions: WorkspaceSessionView[],
  _status: ProjectSessionStatusFilter,
): ProjectView[] {
  return sortProjects(
    projects.filter((project) => project.pinned),
  )
}

export function selectRegularProjects(
  projects: ProjectView[],
  _sessions: WorkspaceSessionView[],
  _status: ProjectSessionStatusFilter,
): ProjectView[] {
  return sortProjectsByCreatedAt(
    projects.filter((project) => !project.pinned),
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
  const filtered = currentSessions.filter((session) => {
    if (status === "archived") return session.archived
    if (status === "all") return session.archived || !session.pinned
    return !session.archived && !session.pinned
  })
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
