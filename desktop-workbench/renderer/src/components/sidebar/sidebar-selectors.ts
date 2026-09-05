import type { WorkspaceSessionView } from "@/components/workspace-context"
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
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return timestamp(right.sortAt ?? right.updatedAt) - timestamp(left.sortAt ?? left.updatedAt)
  })
}

function projectIdsForStatus(
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): Set<string> {
  return new Set(
    sessions
      .filter((session) => session.projectId && (
        status === "all" || session.archived === (status === "archived")
      ))
      .map((session) => session.projectId as string),
  )
}

function projectMatchesStatus(
  project: ProjectView,
  matchingProjectIds: Set<string>,
  status: ProjectSessionStatusFilter,
): boolean {
  if (status === "active") return project.activeSessionCount > 0
  if (status === "archived") return matchingProjectIds.has(project.id)
  return project.activeSessionCount > 0 || matchingProjectIds.has(project.id)
}

export function selectPinnedProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): ProjectView[] {
  const matchingProjectIds = projectIdsForStatus(sessions, status)
  return sortProjects(
    projects.filter((project) =>
      project.pinned && projectMatchesStatus(project, matchingProjectIds, status),
    ),
  )
}

export function selectRegularProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
): ProjectView[] {
  const matchingProjectIds = projectIdsForStatus(sessions, status)
  return sortProjectsByCreatedAt(
    projects.filter((project) =>
      !project.pinned && projectMatchesStatus(project, matchingProjectIds, status),
    ),
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
    filterSessions(sessions, filter, search).filter((session) => !session.pinned),
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

  return sortSidebarSessions(
    currentSessions.filter((session) => {
      if (status === "archived") return session.archived
      if (status === "all") return session.archived || !session.pinned
      return !session.archived && !session.pinned
    }),
  )
}
