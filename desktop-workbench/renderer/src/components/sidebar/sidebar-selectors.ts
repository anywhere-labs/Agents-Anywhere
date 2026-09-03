import type { WorkspaceSessionView } from "@/components/workspace-context"
import type { ProjectView } from "@/features/dashboard/types"
import { filterSessions, type FilterValue } from "@/lib/demo-api"

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
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return timestamp(right.sortAt ?? right.updatedAt) - timestamp(left.sortAt ?? left.updatedAt)
  })
}

export function selectPinnedProjects(projects: ProjectView[]): ProjectView[] {
  return sortProjects(projects.filter((project) => project.pinned))
}

export function selectRegularProjects(projects: ProjectView[]): ProjectView[] {
  return sortProjectsByCreatedAt(projects.filter((project) => !project.pinned))
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

export function selectProjectSessions(
  sessions: WorkspaceSessionView[],
  currentSessionsById: Map<string, WorkspaceSessionView>,
): WorkspaceSessionView[] {
  const currentSessions = sessions.map(
    (session) => currentSessionsById.get(session.id) ?? session,
  )

  return sortSidebarSessions(
    currentSessions.filter((session) => !session.archived && !session.pinned),
  )
}
