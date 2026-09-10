"use client"

import * as React from "react"
import { CheckCircle2, Loader2, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace } from "@/components/workspace-context"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { dashboardApi } from "@/features/dashboard/api"
import { watchPairingConnector } from "@/features/dashboard/pairing-watcher"
import { quickAddRuntime } from "@/features/dashboard/quick-add-runtime"
import {
  discoverConnectorRuntimeOverview,
  type ConnectorRuntimeOverview,
} from "@/features/dashboard/runtime-discovery"
import { addableRuntimeTypes, configuredRuntimeInstances, runtimeInstanceName } from "@/features/dashboard/runtime-instances"
import type { DeviceRuntimeView, RuntimeTypeView } from "@/features/dashboard/types"
import { isApiError } from "@/lib/api/errors"
import { isTransientHttpStatus } from "@/lib/retry"

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
  const { session } = useAuth()
  const { refreshData } = useWorkspace()
  const t = useTranslations("dashboard.pairDevice")
  const tDevice = useTranslations("dashboard.device")
  const tCommon = useTranslations("common")
  const [overview, setOverview] = React.useState<ConnectorRuntimeOverview>({ runtimes: [], runtimeTypes: [] })
  const [loading, setLoading] = React.useState(true)
  const [waitingOnline, setWaitingOnline] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [reload, setReload] = React.useState(0)
  const [addingType, setAddingType] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)

  React.useEffect(() => {
    const token = session?.accessToken
    if (!token) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)
    setLoadError(null)

    const load = async () => {
      try {
        const response = await dashboardApi.getConnector(token, connector.id)
        if (cancelled) return
        if (response.connector.status !== "online") {
          setWaitingOnline(true)
          timer = setTimeout(() => void load(), 2000)
          return
        }
        setWaitingOnline(false)
        const next = await discoverConnectorRuntimeOverview(token, connector.id)
        if (cancelled) return
        setOverview(next)
        setLoading(false)
      } catch (error) {
        if (cancelled) return
        if (isApiError(error) && (isTransientHttpStatus(error.status) || error.status === 409)) {
          setWaitingOnline(true)
          timer = setTimeout(() => void load(), 2000)
          return
        }
        setLoadError(error instanceof Error ? error.message : t("errors.discoverRuntimesFailed"))
        setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [connector.id, reload, session?.accessToken, t])

  const replaceRuntime = (runtime: DeviceRuntimeView) => {
    setOverview((current) => ({
      ...current,
      runtimes: [...current.runtimes.filter((item) => item.runtimeId !== runtime.runtimeId), runtime],
    }))
  }

  const runAction = async (runtimeType: string, action: () => Promise<DeviceRuntimeView>) => {
    if (busyRef.current) return
    busyRef.current = true
    setAddingType(runtimeType)
    try {
      const runtime = await action()
      replaceRuntime(runtime)
      refreshData()
      toast.success(t("agentConfiguredAndStarted", { name: runtimeInstanceName(runtime) }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.configureAndStartFailed"))
      setReload((current) => current + 1)
    } finally {
      busyRef.current = false
      setAddingType(null)
    }
  }

  const add = (runtimeType: RuntimeTypeView) => {
    const token = session?.accessToken
    if (!token) return
    return runAction(runtimeType.runtimeType, () => quickAddRuntime({
      token,
      connectorId: connector.id,
      runtimeType,
      onRuntimeUpdated: replaceRuntime,
    }))
  }

  const start = (runtime: DeviceRuntimeView) => {
    const token = session?.accessToken
    if (!token) return
    return runAction(runtime.runtimeType, () => dashboardApi.setConnectorRuntimeActive(
      token, connector.id, runtime.runtimeId, true,
    ))
  }

  const configured = configuredRuntimeInstances(overview.runtimes)
  const addable = addableRuntimeTypes(overview.runtimeTypes, overview.runtimes)
    .filter((runtimeType) => !configured.some((runtime) => runtime.runtimeType === runtimeType.runtimeType))

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("successTitle")}</DialogTitle>
          <DialogDescription>
            {t(waitingOnline ? "waitingReconnectHeader" : "successDescription", { name: connector.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div>
            <h3 className="font-medium">{t("agentsTitle")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("agentsDescription")}</p>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t(waitingOnline ? "waitingReconnectTitle" : "discoveringAgents")}
            </div>
          ) : loadError ? (
            <p role="alert" className="text-sm text-destructive">{loadError}</p>
          ) : (
            <div className="space-y-2">
              {configured.map((runtime) => (
                <div key={runtime.runtimeId} className="flex items-center gap-3 rounded-lg border p-3">
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{runtimeInstanceName(runtime)}</p>
                    <p className="text-xs text-muted-foreground">{t(runtime.status === "running" ? "agentRunning" : "agentConfigured")}</p>
                  </div>
                  {!runtime.active || runtime.status === "error" || runtime.status === "stopped" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={addingType !== null}
                      onClick={() => void start(runtime)}
                    >
                      {addingType === runtime.runtimeType ? <Loader2 className="animate-spin" /> : null}
                      {tDevice("activateRuntime", { name: runtimeInstanceName(runtime) })}
                    </Button>
                  ) : null}
                </div>
              ))}
              {addable.map((runtimeType) => (
                <div key={runtimeType.runtimeType} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{runtimeType.displayName}</p>
                    {runtimeType.description ? <p className="text-xs text-muted-foreground">{runtimeType.description}</p> : null}
                  </div>
                  <Button size="sm" disabled={addingType !== null} onClick={() => void add(runtimeType)}>
                    {addingType === runtimeType.runtimeType ? <Loader2 className="animate-spin" /> : <Plus />}
                    {t("quickAdd")}
                  </Button>
                </div>
              ))}
              {configured.length === 0 && addable.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">{t("noAgentsFound")}</p>
              ) : null}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={addingType !== null} onClick={onClose}>
            {t("skipAgents")}
          </Button>
          <Button disabled={addingType !== null} onClick={onClose}>{tCommon("done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
