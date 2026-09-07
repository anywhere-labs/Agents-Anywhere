"use client"

import * as React from "react"

import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace } from "@/components/workspace-context"
import { watchPairingConnector } from "@/features/dashboard/pairing-watcher"

type PairingRequest = { connectorId: string; waitingOnline: boolean }
type DevicePairingContextValue = {
  waitForConnector: (connectorId: string) => void
  clearPairing: (connectorId: string) => void
  readyConnectorIds: string[]
}

const DevicePairingContext = React.createContext<DevicePairingContextValue | null>(null)

export function useDevicePairing() {
  const context = React.useContext(DevicePairingContext)
  if (!context) throw new Error("useDevicePairing must be used within DevicePairingProvider")
  return context
}

/** Keep CLI pairing alive after its form closes; completion only refreshes devices. */
export function DevicePairingProvider({ children }: { children: React.ReactNode }) {
  const { refreshData } = useWorkspace()
  const [queue, setQueue] = React.useState<PairingRequest[]>([])
  const waitForConnector = React.useCallback((connectorId: string) => {
    setQueue((current) => current.some((item) => item.connectorId === connectorId)
      ? current.map((item) => item.connectorId === connectorId ? { connectorId, waitingOnline: true } : item)
      : [...current, { connectorId, waitingOnline: true }])
  }, [])
  const clearPairing = React.useCallback((connectorId: string) => {
    setQueue((current) => current.filter((item) => item.connectorId !== connectorId))
  }, [])
  const handleOnline = React.useCallback((connector: { id: string }) => {
    setQueue((current) => current.map((item) => item.connectorId === connector.id ? { ...item, waitingOnline: false } : item))
    refreshData()
  }, [refreshData])
  const context = React.useMemo(() => ({
    waitForConnector,
    clearPairing,
    readyConnectorIds: queue.filter((item) => !item.waitingOnline).map((item) => item.connectorId),
  }), [queue, waitForConnector, clearPairing])

  return (
    <DevicePairingContext.Provider value={context}>
      {children}
      {queue.filter((item) => item.waitingOnline).map((item) => (
        <PendingPairing
          key={item.connectorId}
          connectorId={item.connectorId}
          onOnline={handleOnline}
          onUnavailable={clearPairing}
        />
      ))}
    </DevicePairingContext.Provider>
  )
}

function PendingPairing({ connectorId, onOnline, onUnavailable }: {
  connectorId: string
  onOnline: (connector: { id: string }) => void
  onUnavailable: (connectorId: string) => void
}) {
  const { session } = useAuth()
  React.useEffect(() => {
    if (!session?.accessToken) return
    return watchPairingConnector({ token: session.accessToken, connectorId, onOnline, onUnavailable })
  }, [connectorId, onOnline, onUnavailable, session?.accessToken])
  return null
}
