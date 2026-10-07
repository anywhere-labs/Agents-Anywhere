import type { WorkspaceSessionView } from "@/components/workspace-context"
import type { ProjectView } from "@/features/dashboard/types"
import { filterSessions, type FilterValue } from "@/lib/demo-api"
import { sessionStatusIsActive } from "../session/session-list-order.ts"
import { sortProjectsBySessionActivity } from "./project-list-order"
import { filterProjectSessions, type DeviceAgentFilter } from "./project-identity"
import {
  projectHasVisibleSessions,
  projectSessionMatchesStatus,
  type ProjectSessionStatusFilter,
} from "./project-visibility"

export type { ProjectSessionStatusFilter } from "./project-visibility"

/** Device/Agent filter plus the sidebar status scope. */
export type SidebarSessionFilter = DeviceAgentFilter & { status?: FilterValue["status"] }

export function sortSidebarSessions(items: WorkspaceSessionView[]): WorkspaceSessionView[] {
  // WorkspaceContext owns the presentation order, including optimistic sends.
  return [...items]
}

/**
 * The "in progress" status filter scopes every session list in the sidebar
 * (pins and project groups included) so the view reads as one coherent board
 * of what each device Agent is doing right now.
 */
export function scopeSessionsByStatusFilter<S extends { archived: boolean; status: string }>(
  sessions: readonly S[],
  scope: SidebarSessionFilter | FilterValue | null | undefined,
): S[] {
  if (!scope || scope.status !== "working") return [...sessions]
  return sessions.filter((session) => !session.archived && sessionStatusIsActive(session.status))
}

export function selectPinnedProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
  filter?: SidebarSessionFilter | null,
): ProjectView[] {
  const scoped = scopeSessionsByStatusFilter(sessions, filter)
  return sortProjectsBySessionActivity(
    projects.filter((project) => (
      project.pinned && projectHasVisibleSessions(project, scoped, status, filter)
    )),
    scoped,
  )
}

export function selectRegularProjects(
  projects: ProjectView[],
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter,
  filter?: SidebarSessionFilter | null,
): ProjectView[] {
  const scoped = scopeSessionsByStatusFilter(sessions, filter)
  return sortProjectsBySessionActivity(
    projects.filter((project) => (
      !project.pinned && projectHasVisibleSessions(project, scoped, status, filter)
    )),
    scoped,
  )
}

export function selectPinnedSessions(
  sessions: WorkspaceSessionView[],
  filter?: SidebarSessionFilter | null,
): WorkspaceSessionView[] {
  return sortSidebarSessions(
    filterProjectSessions(scopeSessionsByStatusFilter(sessions, filter), filter)
      .filter((session) => session.pinned && !session.archived),
  )
}

export function selectRecentSessions(
  sessions: WorkspaceSessionView[],
  filter: FilterValue,
  search: string,
): WorkspaceSessionView[] {
  return sortSidebarSessions(
    filterSessions(
      scopeSessionsByStatusFilter(sessions.filter((session) => !session.projectId), filter),
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
    filterSessions(scopeSessionsByStatusFilter(sessions, filter), filter, search)
      .filter((session) => session.archived || !session.pinned),
  )
}

export function selectProjectSessions(
  sessions: WorkspaceSessionView[],
  status: ProjectSessionStatusFilter = "active",
  filter?: SidebarSessionFilter | null,
): WorkspaceSessionView[] {
  return filterProjectSessions(scopeSessionsByStatusFilter(sessions, filter), filter)
    .filter((session) => projectSessionMatchesStatus(session, status))
}

export function groupSessionsByProject(sessions: WorkspaceSessionView[]): Record<string, WorkspaceSessionView[]> {
  const groups: Record<string, WorkspaceSessionView[]> = Object.create(null)
  for (const session of sessions) {
    if (session.projectId) (groups[session.projectId] ??= []).push(session)
  }
  return groups
}
