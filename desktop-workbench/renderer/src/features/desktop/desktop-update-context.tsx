"use client"

import * as React from "react"

import { DesktopUpdateDialog } from "@/components/desktop/desktop-update-dialog"
import { LoadingState } from "@/components/loading-state"
import {
  getDesktopWorkbenchBridge,
  type DesktopWorkbenchBridge,
  type DesktopUpdateSnapshot,
} from "@/features/desktop/bridge"

type DesktopUpdateContextValue = {
  state: DesktopUpdateSnapshot | null
  showDeferredUpdate: () => void
}

const DesktopUpdateContext = React.createContext<DesktopUpdateContextValue | null>(null)
type DesktopUpdateBridge = NonNullable<DesktopWorkbenchBridge["updates"]>

export function DesktopUpdateProvider({ children }: { children: React.ReactNode }) {
  const [bridge, setBridge] = React.useState<DesktopUpdateBridge | null>()
  const [state, setState] = React.useState<DesktopUpdateSnapshot | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [deferredOpen, setDeferredOpen] = React.useState(false)

  React.useEffect(() => {
    let active = true
    const nextBridge = getDesktopWorkbenchBridge()?.updates ?? null
    setBridge(nextBridge)
    if (!nextBridge) {
      setLoading(false)
      return () => {
        active = false
      }
    }
    let receivedEvent = false
    const unsubscribe = nextBridge.onState((nextState) => {
      if (!active) return
      receivedEvent = true
      setState(nextState)
      setLoading(false)
    })
    void nextBridge.getState()
      .then((nextState) => {
        if (!active) return
        if (!receivedEvent) setState(nextState)
        setLoading(false)
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [])

  React.useEffect(() => {
    if (state?.phase !== "deferred") setDeferredOpen(false)
  }, [state?.phase])

  const install = React.useCallback(async () => {
    if (!bridge) return
    setState(await bridge.install())
  }, [bridge])

  const checkNow = React.useCallback(async () => {
    if (!bridge) return
    setState(await bridge.checkNow())
  }, [bridge])

  const defer = React.useCallback(async () => {
    if (!bridge) return
    setState(await bridge.defer())
    setDeferredOpen(false)
  }, [bridge])

  const value = React.useMemo<DesktopUpdateContextValue>(() => ({
    state,
    showDeferredUpdate: () => setDeferredOpen(true),
  }), [state])

  const checkingHealth = loading || state?.phase === "checking-health"
  const gated = Boolean(state?.forced)

  return (
    <DesktopUpdateContext.Provider value={value}>
      {checkingHealth ? (
        <LoadingState className="min-h-screen bg-background" />
      ) : gated ? (
        <div className="min-h-screen bg-background" />
      ) : (
        children
      )}
      {state ? (
        <DesktopUpdateDialog
          state={state}
          deferredOpen={deferredOpen}
          onDeferredOpenChange={setDeferredOpen}
          onCheck={checkNow}
          onInstall={install}
          onDefer={defer}
        />
      ) : null}
    </DesktopUpdateContext.Provider>
  )
}

export function useDesktopUpdate(): DesktopUpdateContextValue {
  const context = React.useContext(DesktopUpdateContext)
  if (!context) throw new Error("useDesktopUpdate must be used within DesktopUpdateProvider")
  return context
}
