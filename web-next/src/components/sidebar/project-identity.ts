// The explicit `.ts` extension keeps this module importable by `node --test`
// without a bundler, like the other pure sidebar modules.
import { runtimeLabel } from "../session/session-utils.ts"
import type { FilterValue } from "@/lib/demo-api"
import type { ProjectView } from "@/features/dashboard/types"

/**
 * The device/Agent half of the sidebar filter. Search and archive status stay
 * with the section that owns them, so projects keep their own status filter.
 */
export type DeviceAgentFilter = Pick<FilterValue, "connectorId" | "runtime">

type FilterableSession = {
  connectorId?: string
  runtime?: string
}

type ProjectSession = FilterableSession & {
  projectId?: string | null
  runtimeTypeDisplayName?: string | null
}

type IdentityConnector = {
  id: string
  name: string
  deviceOs?: string | null
}

export type ProjectIdentityAgent = {
  runtime: string
  label: string
  sessionCount: number
}

export type ProjectIdentity = {
  deviceName: string
  deviceOs: string | null
  agents: ProjectIdentityAgent[]
  workspacePath: string
}

/**
 * Device and Agent identity of the sessions that live in one project.
 * `deviceName` falls back to the connector id so same-named projects on
 * different devices stay distinguishable even before connectors load.
 */
export function resolveProjectIdentity(
  project: Pick<ProjectView, "id" | "connectorId" | "workspacePath">,
  sessions: readonly ProjectSession[],
  connectors: readonly IdentityConnector[],
): ProjectIdentity {
  const connector = connectors.find((item) => item.id === project.connectorId)
  const groups = new Map<string, { displayName: string | null; sessionCount: number }>()
  for (const session of sessions) {
    if (session.projectId !== project.id || !session.runtime) continue
    const group = groups.get(session.runtime) ?? { displayName: null, sessionCount: 0 }
    const displayName = session.runtimeTypeDisplayName?.trim()
    if (displayName && !group.displayName) group.displayName = displayName
    group.sessionCount += 1
    groups.set(session.runtime, group)
  }

  const agents = Array.from(groups, ([runtime, group]) => ({
    runtime,
    label: group.displayName || runtimeLabel(runtime),
    sessionCount: group.sessionCount,
  })).sort((left, right) => (
    right.sessionCount - left.sessionCount
    || left.label.localeCompare(right.label)
    || left.runtime.localeCompare(right.runtime)
  ))

  return {
    deviceName: connector?.name?.trim() || project.connectorId,
    deviceOs: connector?.deviceOs ?? null,
    agents,
    workspacePath: project.workspacePath,
  }
}

/**
 * Which halves of the identity belong on the row. A dimension is only shown
 * while that filter is narrowing the list: with "all devices" the device name
 * stays off, with "all Agents" the Agent name stays off, and with both on "all"
 * the row has no second line at all.
 */
export type IdentityParts = {
  includeDevice?: boolean
  includeAgents?: boolean
}

/**
 * Compact one-line label for a project row, e.g. `MacBook Pro · Codex`.
 * `null` means nothing to show.
 */
export function projectIdentityLabel(
  identity: ProjectIdentity,
  options: IdentityParts = {},
): string | null {
  const parts: string[] = []
  const deviceName = identity.deviceName.trim()
  if ((options.includeDevice ?? true) && deviceName) parts.push(deviceName)
  if (options.includeAgents ?? true) {
    const [primary, ...rest] = identity.agents
    if (primary) parts.push(rest.length > 0 ? `${primary.label} +${rest.length}` : primary.label)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Short `device · agent` label for a session row that is not inside a project. */
export function sessionIdentityLabel(
  session: FilterableSession & { runtimeTypeDisplayName?: string | null },
  connectors: readonly IdentityConnector[],
  options: IdentityParts = {},
): string | null {
  const deviceName = (options.includeDevice ?? true)
    ? (connectors.find((item) => item.id === session.connectorId)?.name
      || session.connectorId
      || "").trim()
    : ""
  const label = (options.includeAgents ?? true) && session.runtime
    ? session.runtimeTypeDisplayName?.trim() || runtimeLabel(session.runtime)
    : ""
  const parts = [deviceName, label].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** True when the device/Agent gate is actually narrowing the projects list. */
export function isDeviceAgentFilterActive(filter?: DeviceAgentFilter | null): boolean {
  if (!filter) return false
  return filter.connectorId !== "all" || filter.runtime !== "all"
}

export function sessionMatchesDeviceAgentFilter(
  session: FilterableSession,
  filter?: DeviceAgentFilter | null,
): boolean {
  if (!filter) return true
  if (filter.connectorId !== "all" && session.connectorId !== filter.connectorId) return false
  if (filter.runtime !== "all" && session.runtime !== filter.runtime) return false
  return true
}

/** Sessions of one project that survive the device/Agent gate. */
export function filterProjectSessions<S extends FilterableSession>(
  sessions: readonly S[],
  filter?: DeviceAgentFilter | null,
): S[] {
  return sessions.filter((session) => sessionMatchesDeviceAgentFilter(session, filter))
}

/**
 * Device gate on the project itself plus an Agent gate that needs at least one
 * session running on the selected runtime.
 */
export function projectMatchesDeviceAgentFilter(
  project: Pick<ProjectView, "id" | "connectorId">,
  sessions: readonly ProjectSession[],
  filter?: DeviceAgentFilter | null,
): boolean {
  if (!filter) return true
  if (filter.connectorId !== "all" && project.connectorId !== filter.connectorId) return false
  if (filter.runtime === "all") return true
  return sessions.some((session) => session.projectId === project.id && session.runtime === filter.runtime)
}
