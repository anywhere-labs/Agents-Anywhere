"use client"

import * as React from "react"
import { API_NAMESPACE } from "@/lib/api"
import { getDesktopServerConnection } from "@/features/desktop/server-connection"
import { createProjectSidebarPreferenceStore, projectSidebarPreferenceKey } from "./project-sidebar-preferences"

export function useProjectSidebarPreferences(userId: string) {
  const connection = getDesktopServerConnection()
  const server = JSON.stringify([
    connection?.serverUrl ?? process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API ?? "",
    connection?.apiNamespace ?? API_NAMESPACE,
  ])
  const key = projectSidebarPreferenceKey(server, userId)
  const store = React.useMemo(() => {
    let storage: Storage | null = null
    try {
      if (typeof window !== "undefined") storage = window.localStorage
    } catch { /* Storage is optional for the sidebar to work. */ }
    return createProjectSidebarPreferenceStore(storage, key)
  }, [key])
  const preferences = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)

  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) store.refresh()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [key, store])

  return { preferences, setProjectExpanded: store.setProjectExpanded, setProjectsExpanded: store.setProjectsExpanded }
}
