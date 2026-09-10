"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace } from "@/components/workspace-context"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { watchPairingConnector } from "@/features/dashboard/pairing-watcher"
import { AgentSetupContent } from "@/components/agent-setup-content"

export type AgentSetupConnector = { id: string; name: string }

type AgentSetupRequest = { connector: AgentSetupConnector; waitingOnline: boolean }
type AgentSetupContextValue = {
  requestAgentSetup: (connector: AgentSetupConnector) => void
  waitForConnector: (connector: AgentSetupConnector) => void
  readyConnectorIds: string[]
}

const AgentSetupContext = React.createContext<AgentSetupContextValue | null>(null)

export function useAgentSetup() {
  return useAgentSetupPairing().requestAgentSetup
}

export function useAgentSetupPairing() {
  const context = React.useContext(AgentSetupContext)
  if (!context) throw new Error("useAgentSetupPairing must be used within AgentSetupProvider")
  return context
}

export function AgentSetupProvider({ children }: { children: React.ReactNode }) {
  const { refreshData } = useWorkspace()
  const [queue, setQueue] = React.useState<AgentSetupRequest[]>([])
  const requestAgentSetup = React.useCallback((connector: AgentSetupConnector) => {
    setQueue((current) => current.some((item) => item.connector.id === connector.id)
      ? current.map((item) => item.connector.id === connector.id ? { connector, waitingOnline: false } : item)
      : [...current, { connector, waitingOnline: false }])
  }, [])
  const waitForConnector = React.useCallback((connector: AgentSetupConnector) => {
    setQueue((current) => current.some((item) => item.connector.id === connector.id)
      ? current
      : [...current, { connector, waitingOnline: true }])
  }, [])
  const removeRequest = React.useCallback((connectorId: string) => {
    setQueue((current) => current.filter((item) => item.connector.id !== connectorId))
  }, [])
  const handleOnline = React.useCallback((connector: AgentSetupConnector) => {
    requestAgentSetup(connector)
    refreshData()
  }, [refreshData, requestAgentSetup])
  const context = React.useMemo(() => ({
    requestAgentSetup,
    waitForConnector,
    readyConnectorIds: queue.filter((item) => !item.waitingOnline).map((item) => item.connector.id),
  }), [queue, requestAgentSetup, waitForConnector])
  const connector = queue.find((item) => !item.waitingOnline)?.connector

  return (
    <AgentSetupContext.Provider value={context}>
      {children}
      {queue.filter((item) => item.waitingOnline).map((item) => (
        <PendingPairing
          key={item.connector.id}
          connectorId={item.connector.id}
          onOnline={handleOnline}
          onUnavailable={removeRequest}
        />
      ))}
      {connector ? (
        <AgentSetupDialog
          key={connector.id}
          connector={connector}
          onClose={() => removeRequest(connector.id)}
        />
      ) : null}
    </AgentSetupContext.Provider>
  )
}

function PendingPairing({ connectorId, onOnline, onUnavailable }: {
  connectorId: string
  onOnline: (connector: AgentSetupConnector) => void
  onUnavailable: (connectorId: string) => void
}) {
  const { session } = useAuth()
  React.useEffect(() => {
    if (!session?.accessToken) return
    return watchPairingConnector({ token: session.accessToken, connectorId, onOnline, onUnavailable })
  }, [connectorId, onOnline, onUnavailable, session?.accessToken])
  return null
}

function AgentSetupDialog({ connector, onClose }: { connector: AgentSetupConnector; onClose: () => void }) {
  const { refreshData } = useWorkspace()
  const t = useTranslations("dashboard.pairDevice")
  const tCommon = useTranslations("common")
  return (
    <Dialog open>
      <DialogContent className="sm:max-w-xl" showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t("successTitle")}</DialogTitle>
          <DialogDescription>{t("successDescription", { name: connector.name })}</DialogDescription>
        </DialogHeader>
        <AgentSetupContent connector={connector} onContinue={onClose} onSkip={onClose}
          onChanged={refreshData} continueLabel={tCommon("done")} />
      </DialogContent>
    </Dialog>
  )
}
