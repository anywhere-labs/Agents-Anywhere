"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useAuth } from "@/components/auth/auth-context"
import { useWorkspace } from "@/components/workspace-context"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { dashboardApi } from "@/features/dashboard/api"
import {
  type DesktopConnectorConfigPatch,
  getDesktopWorkbenchBridge,
  type DesktopConnectorSettings,
  type DesktopConnectorState,
  type DesktopLocalBinding,
} from "@/features/desktop/bridge"

export type DesktopConnectionStatus =
  | "idle"
  | "connecting"
  | "running"
  | "online"
  | "stopped"
  | "disconnected"
  | "error"

type ConnectorOnlineCheckResult = "online" | "reconnect-required" | "timeout" | "cancelled"

const CONNECTOR_ONLINE_TIMEOUT_MS = 45_000
const CONNECTOR_ONLINE_POLL_MS = 1_000

async function waitForPollInterval(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve(true)
    }, CONNECTOR_ONLINE_POLL_MS)
    const abort = () => {
      window.clearTimeout(timeout)
      resolve(false)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function pollConnectorOnline({
  userToken,
  connectorId,
  signal,
  onLocalState,
}: {
  userToken: string
  connectorId: string
  signal: AbortSignal
  onLocalState: (state: DesktopConnectorState) => void
}): Promise<ConnectorOnlineCheckResult> {
  const connectorBridge = getDesktopWorkbenchBridge()?.connector
  if (!connectorBridge) return "cancelled"
  const deadline = Date.now() + CONNECTOR_ONLINE_TIMEOUT_MS

  while (!signal.aborted && Date.now() < deadline) {
    try {
      const localState = await connectorBridge.getState()
      if (signal.aborted) return "cancelled"
      onLocalState(localState)
      if (localState.authFailed || localState.manualDisconnected) return "reconnect-required"
    } catch {
      // The sidecar may still be starting. The server status below is authoritative for online.
    }

    try {
      const response = await dashboardApi.getConnector(userToken, connectorId)
      if (signal.aborted) return "cancelled"
      if (response.connector.status === "online") return "online"
    } catch {
      // A transient server/read failure should not fail provisioning immediately.
    }

    if (!(await waitForPollInterval(signal))) return "cancelled"
  }

  return signal.aborted ? "cancelled" : "timeout"
}

type DesktopConnectorContextValue = {
  supported: boolean
  loading: boolean
  busy: boolean
  connectionStatus: DesktopConnectionStatus
  provisionError: string | null
  state: DesktopConnectorState | null
  binding: DesktopLocalBinding | null
  isLocalConnector: (connectorId: string) => boolean
  refresh: () => Promise<void>
  retryProvision: () => void
  reconnect: () => Promise<boolean>
  disconnect: () => Promise<boolean>
  start: () => Promise<boolean>
  stop: () => Promise<boolean>
  restart: () => Promise<boolean>
  saveSettings: (settings: DesktopConnectorSettings) => Promise<boolean>
  saveConnectorConfig: (config: DesktopConnectorConfigPatch) => Promise<boolean>
  factoryReset: (forceLocal?: boolean) => Promise<void>
  openDataFolder: () => Promise<boolean>
  updateLocalName: (name: string) => Promise<boolean>
  explainRemoteReconnect: (name: string) => void
}

const DesktopConnectorContext = React.createContext<DesktopConnectorContextValue | null>(null)

export function useDesktopConnector() {
  const context = React.useContext(DesktopConnectorContext)
  if (!context) throw new Error("useDesktopConnector must be used within DesktopConnectorProvider")
  return context
}

export function DesktopConnectorProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("desktopConnector")
  const { session } = useAuth()
  const { refreshData } = useWorkspace()
  const [supported, setSupported] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [connectionStatus, setConnectionStatus] = React.useState<DesktopConnectionStatus>("idle")
  const [provisionError, setProvisionError] = React.useState<string | null>(null)
  const [provisionErrorPromptOpen, setProvisionErrorPromptOpen] = React.useState(false)
  const [provisionRetryNonce, setProvisionRetryNonce] = React.useState(0)
  const [state, setState] = React.useState<DesktopConnectorState | null>(null)
  const [binding, setBinding] = React.useState<DesktopLocalBinding | null>(null)
  const [reconnectPromptOpen, setReconnectPromptOpen] = React.useState(false)
  const [remoteReconnectName, setRemoteReconnectName] = React.useState<string | null>(null)
  const provisionAttemptRef = React.useRef<{
    key: string
    promise: Promise<DesktopLocalBinding>
    completed: boolean
  } | null>(null)
  const connectionCheckRef = React.useRef<AbortController | null>(null)
  const reconnectPromptDismissedRef = React.useRef<string | null>(null)

  const applyState = React.useCallback((nextState: DesktopConnectorState) => {
    setState(nextState)
    const connectorId = nextState.connectorId
    const needsReconnect = Boolean(
      connectorId &&
      (nextState.authFailed || nextState.manualDisconnected),
    )
    if (!needsReconnect) {
      reconnectPromptDismissedRef.current = null
      setReconnectPromptOpen(false)
      if (!connectorId) {
        setConnectionStatus("idle")
      } else if (nextState.status === "starting" || nextState.status === "reconnecting") {
        setConnectionStatus("connecting")
      } else if (!nextState.running) {
        setConnectionStatus("stopped")
      } else {
        setConnectionStatus((current) => (
          current === "online" || current === "connecting" ? current : "running"
        ))
      }
      return
    }
    setConnectionStatus("disconnected")
    if (reconnectPromptDismissedRef.current !== connectorId) {
      setReconnectPromptOpen(true)
    }
  }, [])

  const beginConnectionCheck = React.useCallback(() => {
    connectionCheckRef.current?.abort()
    const controller = new AbortController()
    connectionCheckRef.current = controller
    return controller
  }, [])

  const finishConnectionCheck = React.useCallback((controller: AbortController) => {
    if (connectionCheckRef.current === controller) connectionCheckRef.current = null
  }, [])

  const showConnectionFailure = React.useCallback((message: string) => {
    setProvisionError(message)
    setProvisionErrorPromptOpen(true)
    setConnectionStatus("error")
  }, [])

  const waitUntilOnline = React.useCallback(async ({
    userToken,
    connectorId,
    controller: providedController,
  }: {
    userToken: string
    connectorId: string
    controller?: AbortController
  }): Promise<ConnectorOnlineCheckResult> => {
    const controller = providedController ?? beginConnectionCheck()
    try {
      const result = await pollConnectorOnline({
        userToken,
        connectorId,
        signal: controller.signal,
        onLocalState: applyState,
      })
      if (result === "online") {
        setConnectionStatus("online")
        setProvisionError(null)
        refreshData()
      } else if (result === "reconnect-required") {
        setConnectionStatus("disconnected")
      } else if (result === "timeout") {
        showConnectionFailure(t("onlineTimeout"))
      }
      return result
    } finally {
      if (!providedController) finishConnectionCheck(controller)
    }
  }, [applyState, beginConnectionCheck, finishConnectionCheck, refreshData, showConnectionFailure, t])

  const retryProvision = React.useCallback(() => {
    if (busy) return
    provisionAttemptRef.current = null
    setProvisionError(null)
    setProvisionErrorPromptOpen(false)
    setProvisionRetryNonce((current) => current + 1)
  }, [busy])

  const refresh = React.useCallback(async () => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.device || !bridge.connector) {
      setSupported(false)
      setLoading(false)
      return
    }
    setSupported(true)
    const [nextBinding, nextState] = await Promise.all([
      bridge.device.getLocalBinding(),
      bridge.connector.getState(),
    ])
    setBinding(nextBinding)
    applyState(nextState)
    setLoading(false)
  }, [applyState])

  React.useEffect(() => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector) {
      setSupported(false)
      setLoading(false)
      return
    }
    setSupported(Boolean(bridge.device))
    const unsubscribe = bridge.connector.onState((nextState) => {
      applyState(nextState)
      if (nextState.connectorId) {
        setBinding((current) => current ?? {
          connectorId: nextState.connectorId!,
          serverUrl: nextState.serverUrl ?? "",
        })
      }
    })
    return () => {
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [applyState])

  React.useEffect(() => () => {
    connectionCheckRef.current?.abort()
  }, [])

  React.useEffect(() => {
    const accessToken = session?.accessToken
    const userId = session?.userId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !userId || !bridge?.device || !bridge.connector) return
    const deviceBridge = bridge.device
    const connectorBridge = bridge.connector
    const userToken = accessToken
    const ownerUserId = userId
    const attemptKey = `${ownerUserId}:${accessToken}:${provisionRetryNonce}`
    if (provisionAttemptRef.current?.key === attemptKey && provisionAttemptRef.current.completed) return
    let cancelled = false
    const controller = beginConnectionCheck()

    async function initialize() {
      setLoading(true)
      setBusy(true)
      setProvisionError(null)
      setProvisionErrorPromptOpen(false)
      setConnectionStatus("connecting")
      try {
        const [existingBinding, initialState] = await Promise.all([
          deviceBridge.getLocalBinding(),
          connectorBridge.getState(),
        ])
        if (cancelled) return
        setBinding(existingBinding)
        applyState(initialState)
        setConnectionStatus("connecting")

        let attempt = provisionAttemptRef.current
        if (!attempt || attempt.key !== attemptKey) {
          attempt = {
            key: attemptKey,
            promise: deviceBridge.createAndConnect({ userToken, userId: ownerUserId }),
            completed: false,
          }
          provisionAttemptRef.current = attempt
        }

        const created = await attempt.promise
        if (cancelled) return
        setBinding(created)

        const onlineResult = await waitUntilOnline({
          userToken,
          connectorId: created.connectorId,
          controller,
        })
        if (cancelled || onlineResult === "cancelled") return

        if (onlineResult === "reconnect-required") {
          attempt.completed = true
          setConnectionStatus("disconnected")
          return
        }
        if (onlineResult === "timeout") {
          if (provisionAttemptRef.current?.key === attemptKey) provisionAttemptRef.current = null
          toast.error(t("onlineTimeout"))
          return
        }

        attempt.completed = true
        setProvisionError(null)
        await refresh()
        refreshData()
      } catch (error) {
        if (!cancelled) {
          if (provisionAttemptRef.current?.key === attemptKey) provisionAttemptRef.current = null
          const message = error instanceof Error ? error.message : t("provisionFailed")
          showConnectionFailure(message)
          toast.error(message)
        }
      } finally {
        if (!cancelled) {
          setBusy(false)
          setLoading(false)
        }
        finishConnectionCheck(controller)
      }
    }

    void initialize()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    applyState,
    beginConnectionCheck,
    finishConnectionCheck,
    provisionRetryNonce,
    refresh,
    refreshData,
    session?.accessToken,
    session?.userId,
    showConnectionFailure,
    t,
    waitUntilOnline,
  ])

  const reconnect = React.useCallback(async () => {
    const accessToken = session?.accessToken
    const userId = session?.userId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !userId || !bridge?.device || busy) return false
    setBusy(true)
    setConnectionStatus("connecting")
    setProvisionError(null)
    try {
      const reconnected = await bridge.device.reconnectAndConnect({
        userToken: accessToken,
        userId,
        connectorId: binding?.connectorId ?? state?.connectorId ?? undefined,
      })
      reconnectPromptDismissedRef.current = null
      setBinding(reconnected)
      setReconnectPromptOpen(false)
      await refresh()
      const onlineResult = await waitUntilOnline({
        userToken: accessToken,
        connectorId: reconnected.connectorId,
      })
      if (onlineResult === "cancelled") return false
      if (onlineResult === "reconnect-required") {
        setConnectionStatus("disconnected")
        toast.error(t("reconnectFailed"))
        return false
      }
      if (onlineResult === "timeout") {
        toast.error(t("onlineTimeout"))
        return false
      }
      toast.success(t("reconnected"))
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("reconnectFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [
    binding?.connectorId,
    busy,
    refresh,
    session?.accessToken,
    session?.userId,
    state?.connectorId,
    t,
    waitUntilOnline,
  ])

  const disconnect = React.useCallback(async () => {
    const accessToken = session?.accessToken
    const userId = session?.userId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !userId || !bridge?.device || busy) return false
    setBusy(true)
    try {
      const disconnected = await bridge.device.disconnectLocal({ userToken: accessToken, userId })
      reconnectPromptDismissedRef.current = disconnected.connectorId
      setBinding(disconnected)
      setReconnectPromptOpen(false)
      setConnectionStatus("disconnected")
      await refresh()
      refreshData()
      toast.success(t("disconnected"))
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("disconnectFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [busy, refresh, refreshData, session?.accessToken, session?.userId, t])

  const start = React.useCallback(async () => {
    const accessToken = session?.accessToken
    const connectorId = binding?.connectorId ?? state?.connectorId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !connectorId || !bridge?.connector || busy) return false
    setBusy(true)
    setConnectionStatus("connecting")
    setProvisionError(null)
    try {
      applyState(await bridge.connector.start())
      const onlineResult = await waitUntilOnline({
        userToken: accessToken,
        connectorId,
      })
      if (onlineResult === "cancelled") return false
      if (onlineResult === "reconnect-required") {
        setConnectionStatus("disconnected")
        return false
      }
      if (onlineResult === "timeout") {
        toast.error(t("onlineTimeout"))
        return false
      }
      toast.success(t("started"))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : t("startFailed")
      showConnectionFailure(message)
      toast.error(message)
      return false
    } finally {
      setBusy(false)
    }
  }, [
    applyState,
    binding?.connectorId,
    busy,
    session?.accessToken,
    showConnectionFailure,
    state?.connectorId,
    t,
    waitUntilOnline,
  ])

  const restart = React.useCallback(async () => {
    const accessToken = session?.accessToken
    const connectorId = binding?.connectorId ?? state?.connectorId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !connectorId || !bridge?.connector || busy) return false
    setBusy(true)
    setConnectionStatus("connecting")
    try {
      applyState(await bridge.connector.restart())
      const onlineResult = await waitUntilOnline({ userToken: accessToken, connectorId })
      if (onlineResult !== "online") {
        if (onlineResult === "timeout") toast.error(t("onlineTimeout"))
        return false
      }
      toast.success(t("restarted"))
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("restartFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyState, binding?.connectorId, busy, session?.accessToken, state?.connectorId, t, waitUntilOnline])

  const stop = React.useCallback(async () => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector || busy) return false
    connectionCheckRef.current?.abort()
    setBusy(true)
    try {
      applyState(await bridge.connector.stop())
      setConnectionStatus("stopped")
      refreshData()
      toast.success(t("stopped"))
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("stopFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyState, busy, refreshData, t])

  const saveSettings = React.useCallback(async (settings: DesktopConnectorSettings) => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector || busy) return false
    setBusy(true)
    const restartsConnector = Boolean(
      state?.running && ("uvPath" in settings || "uvPypiIndexUrl" in settings),
    )
    if (restartsConnector) setConnectionStatus("connecting")
    const previous = state
    if (previous) setState({ ...previous, ...settings })
    try {
      applyState(await bridge.connector.saveSettings(settings))
      const connectorId = binding?.connectorId ?? state?.connectorId
      const accessToken = session?.accessToken
      if (restartsConnector && connectorId && accessToken) {
        const onlineResult = await waitUntilOnline({ userToken: accessToken, connectorId })
        if (onlineResult !== "online") {
          if (onlineResult === "timeout") toast.error(t("onlineTimeout"))
          return false
        }
      }
      return true
    } catch (error) {
      if (previous) setState(previous)
      toast.error(error instanceof Error ? error.message : t("settingsFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyState, binding?.connectorId, busy, session?.accessToken, state, t, waitUntilOnline])

  const saveConnectorConfig = React.useCallback(async (config: DesktopConnectorConfigPatch) => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector || busy) return false
    setBusy(true)
    if (state?.running) setConnectionStatus("connecting")
    try {
      applyState(await bridge.connector.saveConfig(config))
      const connectorId = binding?.connectorId ?? state?.connectorId
      const accessToken = session?.accessToken
      if (state?.running && connectorId && accessToken) {
        const onlineResult = await waitUntilOnline({ userToken: accessToken, connectorId })
        if (onlineResult !== "online") {
          if (onlineResult === "timeout") toast.error(t("onlineTimeout"))
          return false
        }
      }
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("configFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyState, binding?.connectorId, busy, session?.accessToken, state?.connectorId, state?.running, t, waitUntilOnline])

  const factoryReset = React.useCallback(async (forceLocal = false) => {
    const accessToken = session?.accessToken
    const userId = session?.userId
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector?.factoryReset || busy || (!forceLocal && (!accessToken || !userId))) {
      throw new Error(t("factoryResetUnavailable"))
    }
    setBusy(true)
    try {
      const serverUrl = binding?.serverUrl || state?.serverUrl || undefined
      await bridge.connector.factoryReset(forceLocal
        ? { forceLocal: true, serverUrl }
        : { userToken: accessToken!, userId: userId!, serverUrl })
    } finally {
      setBusy(false)
    }
  }, [binding?.serverUrl, busy, session?.accessToken, session?.userId, state?.serverUrl, t])

  const openDataFolder = React.useCallback(async () => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector) return false
    try {
      await bridge.connector.openDataFolder()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("openDataFolderFailed"))
      return false
    }
  }, [t])

  const updateLocalName = React.useCallback(async (name: string) => {
    const bridge = getDesktopWorkbenchBridge()
    const normalizedName = name.trim()
    if (!normalizedName || !bridge?.device) return false
    try {
      const nextBinding = await bridge.device.updateLocalBindingName({ name: normalizedName })
      setBinding(nextBinding)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("localNameFailed"))
      return false
    }
  }, [t])

  const explainRemoteReconnect = React.useCallback((name: string) => {
    setRemoteReconnectName(name)
  }, [])

  const value = React.useMemo<DesktopConnectorContextValue>(() => ({
    supported,
    loading,
    busy,
    connectionStatus,
    provisionError,
    state,
    binding,
    isLocalConnector: (connectorId: string) => connectorId === binding?.connectorId,
    refresh,
    retryProvision,
    reconnect,
    disconnect,
    start,
    stop,
    restart,
    saveSettings,
    saveConnectorConfig,
    factoryReset,
    openDataFolder,
    updateLocalName,
    explainRemoteReconnect,
  }), [
    binding,
    busy,
    connectionStatus,
    disconnect,
    explainRemoteReconnect,
    factoryReset,
    loading,
    openDataFolder,
    provisionError,
    reconnect,
    refresh,
    retryProvision,
    restart,
    saveConnectorConfig,
    saveSettings,
    start,
    state,
    stop,
    supported,
    updateLocalName,
  ])

  return (
    <DesktopConnectorContext.Provider value={value}>
      {children}

      <AlertDialog open={reconnectPromptOpen} onOpenChange={(open) => {
        setReconnectPromptOpen(open)
        if (!open) reconnectPromptDismissedRef.current = binding?.connectorId ?? state?.connectorId ?? null
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reconnectDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("later")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reconnect()} disabled={busy}>
              {busy ? t("reconnecting") : t("reconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={provisionErrorPromptOpen} onOpenChange={setProvisionErrorPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("connectionFailedTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">{t("connectionFailedDescription")}</span>
              {provisionError ? <span className="block text-destructive">{provisionError}</span> : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("later")}</AlertDialogCancel>
            <AlertDialogAction onClick={retryProvision} disabled={busy}>
              {t("retry")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={remoteReconnectName !== null} onOpenChange={(open) => {
        if (!open) setRemoteReconnectName(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("remoteReconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("remoteReconnectDescription", { name: remoteReconnectName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setRemoteReconnectName(null)}>{t("gotIt")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DesktopConnectorContext.Provider>
  )
}
