import type { ProjectView } from "@/features/dashboard/types"

type ProjectSessionActivity = {
  projectId?: string | null
  sortAt?: string | null
  lastActivityAt?: string | null
  createdAt?: string | null
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortProjectsBySessionActivity(
  projects: readonly ProjectView[],
  sessions: readonly ProjectSessionActivity[] = [],
): ProjectView[] {
  const loadedActivity = new Map<string, number>()
  for (const session of sessions) {
    if (!session.projectId) continue
    loadedActivity.set(session.projectId, Math.max(
      loadedActivity.get(session.projectId) ?? 0,
      timestamp(session.sortAt || session.lastActivityAt || session.createdAt),
    ))
  }
  const activity = (project: ProjectView) => Math.max(
    // The server aggregates every session, including history not loaded here.
    timestamp(project.lastActivityAt),
    loadedActivity.get(project.id) ?? 0,
  )
  // Only manually created projects have the Web sidebar's empty-project exception.
  const empty = (project: ProjectView) => Boolean(project.manuallyCreated)
    && !project.lastActivityAt
    && !loadedActivity.has(project.id)
    && project.activeSessionCount === 0
    && (project.sidebarSessionCounts?.active ?? 0) === 0
    && (project.sidebarSessionCounts?.archived ?? 0) === 0

  return [...projects].sort((left, right) => (
    Number(empty(right)) - Number(empty(left))
    || activity(right) - activity(left)
    || timestamp(right.createdAt) - timestamp(left.createdAt)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  ))
}
