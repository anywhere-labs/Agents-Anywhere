"use client"

import * as React from "react"
import { dashboardApi } from "@/features/dashboard/api"
import type { RuntimeCommand, RuntimeStatusValue } from "@/features/dashboard/types"

export function createRecoveredSubscriptionTracker(onReconnectRecovered: () => void) {
  let initialConnection: number | null = null
  let lastRecoveredConnection: number | null = null
  return {
    observed(connection: number) {
      if (initialConnection === null) initialConnection = connection
    },
    recovered(connection: number) {
      if (lastRecoveredConnection === connection) return
      lastRecoveredConnection = connection
      if (initialConnection !== null && connection !== initialConnection) onReconnectRecovered()
    },
  }
}

export function useRuntimeCommands({ token, sessionId, open, available, catalogRevision, runtimeStatus, recoveryGeneration = 0 }: {
  token: string
  sessionId: string | null
  open: boolean
  available: boolean
  catalogRevision: string
  runtimeStatus?: RuntimeStatusValue
  recoveryGeneration?: number
}): {commands: RuntimeCommand[]; loading: boolean; error: boolean} {
  // The catalog is cached per session and read again only when its revision,
  // the runtime status or a recovered subscription can change it. A refresh
  // keeps the previous list visible, so the menu does not flash a loading row.
  const sessionKey = `${token}\n${sessionId ?? ""}`
  const requestKey = `${sessionKey}\n${catalogRevision}\n${runtimeStatus ?? ""}\n${recoveryGeneration}`
  const active = open && Boolean(sessionId) && available
  const fetchedKey = React.useRef<string | null>(null)
  const [catalog, setCatalog] = React.useState<{
    sessionKey: string | null; commands: RuntimeCommand[]; loading: boolean; error: boolean
  }>({ sessionKey: null, commands: [], loading: false, error: false })
  React.useEffect(() => {
    if (!active || !sessionId || fetchedKey.current === requestKey) return
    fetchedKey.current = requestKey
    let cancelled = false
    let done = false
    setCatalog(current => current.sessionKey === sessionKey
      ? { ...current, loading: true, error: false }
      : { sessionKey, commands: [], loading: true, error: false })
    void dashboardApi.getSessionCommands(token, sessionId, { limit: 1000 }).then(response => {
      done = true
      if (!cancelled) setCatalog({ sessionKey, commands: response.commands, loading: false, error: false })
    }).catch(() => {
      done = true
      // Reopening the menu retries a failed read.
      if (fetchedKey.current === requestKey) fetchedKey.current = null
      if (!cancelled) setCatalog({ sessionKey, commands: [], loading: false, error: true })
    })
    return () => {
      cancelled = true
      if (!done && fetchedKey.current === requestKey) fetchedKey.current = null
    }
  }, [token, sessionId, sessionKey, requestKey, active])
  if (!active) return { commands: [], loading: false, error: false }
  // A different session never shows the previous session's commands, even
  // during the render before the effect starts its read.
  if (catalog.sessionKey !== sessionKey) return { commands: [], loading: true, error: false }
  return catalog
}
