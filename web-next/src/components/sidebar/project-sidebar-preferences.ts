export type ProjectSidebarPreferences = {
  projectsExpanded: boolean
  expandedProjectIds: string[]
}

const DEFAULT_PREFERENCES: ProjectSidebarPreferences = {
  projectsExpanded: true,
  expandedProjectIds: [],
}
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

export function projectSidebarPreferenceKey(server: string, userId: string) {
  return `aa-project-sidebar-v1:${JSON.stringify([server, userId])}`
}

function readPreferences(storage: PreferenceStorage | null, key: string): ProjectSidebarPreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "null")
    if (!value || typeof value !== "object") return DEFAULT_PREFERENCES
    const saved = value as Partial<ProjectSidebarPreferences>
    return {
      projectsExpanded: typeof saved.projectsExpanded === "boolean" ? saved.projectsExpanded : true,
      expandedProjectIds: Array.isArray(saved.expandedProjectIds)
        ? Array.from(new Set(saved.expandedProjectIds.filter((id) => typeof id === "string" && id.length > 0)))
        : [],
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function createProjectSidebarPreferenceStore(storage: PreferenceStorage | null, key: string) {
  let preferences = readPreferences(storage, key)
  const listeners = new Set<() => void>()
  const publish = (next: ProjectSidebarPreferences) => {
    preferences = next
    listeners.forEach((listener) => listener())
  }
  const save = (next: ProjectSidebarPreferences) => {
    try {
      storage?.setItem(key, JSON.stringify(next))
    } catch { /* Keep the user's choices in memory when browser storage is unavailable. */ }
    publish(next)
  }

  return {
    getSnapshot: () => preferences,
    getServerSnapshot: () => DEFAULT_PREFERENCES,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh() { publish(readPreferences(storage, key)) },
    setProjectsExpanded(open: boolean) {
      if (preferences.projectsExpanded === open) return
      save({ ...preferences, projectsExpanded: open })
    },
    setProjectExpanded(projectId: string, open: boolean) {
      if (preferences.expandedProjectIds.includes(projectId) === open) return
      save({
        ...preferences,
        expandedProjectIds: open
          ? [...preferences.expandedProjectIds, projectId]
          : preferences.expandedProjectIds.filter((id) => id !== projectId),
      })
    },
  }
}
