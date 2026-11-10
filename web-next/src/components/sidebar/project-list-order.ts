import type { ProjectView } from "@/features/dashboard/types"
import { sessionStatusIsRunning } from "../session/session-list-order.ts"

type ProjectSessionActivity = {
  projectId?: string | null
  sortAt?: string | null
  lastActivityAt?: string | null
  createdAt?: string | null
  status?: string | null
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function sortProjectsBySessionActivity(
  projects: readonly ProjectView[],
  sessions: readonly ProjectSessionActivity[] = [],
): ProjectView[] {
  const loadedActivity = new Map<string, number>()
  const runningProjectIds = new Set<string>()
  for (const session of sessions) {
    if (!session.projectId) continue
    loadedActivity.set(session.projectId, Math.max(
      loadedActivity.get(session.projectId) ?? 0,
      timestamp(session.sortAt || session.lastActivityAt || session.createdAt),
    ))
    if (sessionStatusIsRunning(session.status ?? "")) runningProjectIds.add(session.projectId)
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
  const running = (project: ProjectView) => runningProjectIds.has(project.id)

  return [...projects].sort((left, right) => {
    const leftRunning = running(left)
    const rightRunning = running(right)
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
    // A running task advances its project's activity with every streamed
    // timeline item, so ordering running projects by activity would make
    // concurrent tasks swap places continuously; id order keeps them stable.
    if (leftRunning) return compareAscii(left.id, right.id)
    return (
      Number(empty(right)) - Number(empty(left))
      || activity(right) - activity(left)
      || timestamp(right.createdAt) - timestamp(left.createdAt)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    )
  })
}
