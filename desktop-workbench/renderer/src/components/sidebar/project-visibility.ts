import type { ProjectView } from "@/features/dashboard/types"
import {
  isDeviceAgentFilterActive,
  projectMatchesDeviceAgentFilter,
  sessionMatchesDeviceAgentFilter,
  type DeviceAgentFilter,
} from "./project-identity.ts"

export type ProjectSessionStatusFilter = "active" | "archived" | "all"

type ProjectSession = {
  projectId?: string | null
  archived: boolean
  pinned: boolean
  connectorId?: string
  runtime?: string
}

export function projectSessionMatchesStatus(
  session: ProjectSession,
  status: ProjectSessionStatusFilter,
): boolean {
  if (status === "archived") return session.archived
  if (status === "all") return session.archived || !session.pinned
  return !session.archived && !session.pinned
}

/**
 * A project is visible when it still has a session that passes both the status
 * filter and the device/Agent filter. Manually created projects keep their
 * empty-project exception only while no device/Agent gate is active, so a
 * filtered list never expands into an empty "no sessions" row.
 */
export function projectHasVisibleSessions(
  project: Pick<ProjectView, "id" | "connectorId" | "manuallyCreated" | "sidebarSessionCounts">,
  sessions: readonly ProjectSession[],
  status: ProjectSessionStatusFilter,
  filter?: DeviceAgentFilter | null,
): boolean {
  if (project.manuallyCreated && !isDeviceAgentFilterActive(filter)) return true
  if (!projectMatchesDeviceAgentFilter(project, sessions, filter)) return false

  return sessions.some(
    (session) =>
      session.projectId === project.id
      && projectSessionMatchesStatus(session, status)
      && sessionMatchesDeviceAgentFilter(session, filter),
  )
}
