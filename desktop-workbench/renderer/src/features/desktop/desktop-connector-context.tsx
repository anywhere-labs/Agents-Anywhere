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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { dashboardApi } from "@/features/dashboard/api"
import {
  getDesktopWorkbenchBridge,
  type DesktopConnectorSettings,
  type DesktopConnectorState,
  type DesktopLocalBinding,
} from "@/features/desktop/bridge"

type DesktopConnectorContextValue = {
  supported: boolean
  loading: boolean
  busy: boolean
  state: DesktopConnectorState | null
  binding: DesktopLocalBinding | null
  isLocalConnector: (connectorId: string) => boolean
  refresh: () => Promise<void>
  reconnect: () => Promise<boolean>
  disconnect: () => Promise<boolean>
  restart: () => Promise<boolean>
  saveSettings: (settings: DesktopConnectorSettings) => Promise<boolean>
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
  const [state, setState] = React.useState<DesktopConnectorState | null>(null)
  const [binding, setBinding] = React.useState<DesktopLocalBinding | null>(null)
  const [reconnectPromptOpen, setReconnectPromptOpen] = React.useState(false)
  const [remoteReconnectName, setRemoteReconnectName] = React.useState<string | null>(null)
  const [newDevice, setNewDevice] = React.useState<DesktopLocalBinding | null>(null)
  const [newDeviceName, setNewDeviceName] = React.useState("")
  const [savingName, setSavingName] = React.useState(false)
  const provisionAttemptRef = React.useRef<string | null>(null)
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
      return
    }
    if (reconnectPromptDismissedRef.current !== connectorId) {
      setReconnectPromptOpen(true)
    }
  }, [])

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

  React.useEffect(() => {
    const accessToken = session?.accessToken
    const userId = session?.userId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !userId || !bridge?.device || !bridge.connector) return
    const deviceBridge = bridge.device
    const connectorBridge = bridge.connector
    const userToken = accessToken
    const ownerUserId = userId
    if (provisionAttemptRef.current === accessToken) return
    provisionAttemptRef.current = accessToken
    let cancelled = false

    async function initialize() {
      setLoading(true)
      try {
        const [existingBinding, initialState] = await Promise.all([
          deviceBridge.getLocalBinding(),
          connectorBridge.getState(),
        ])
        if (cancelled) return
        setBinding(existingBinding)
        applyState(initialState)
        setBusy(true)
        const created = await deviceBridge.createAndConnect({ userToken, userId: ownerUserId })
        if (cancelled) return
        setBinding(created)
        const isNewBinding = !existingBinding || existingBinding.connectorId !== created.connectorId
        if (isNewBinding) {
          setNewDevice(created)
          setNewDeviceName(created.name ?? "")
        }
        await refresh()
        refreshData()
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : t("provisionFailed"))
        }
      } finally {
        if (!cancelled) {
          setBusy(false)
          setLoading(false)
        }
      }
    }

    void initialize()
    return () => {
      cancelled = true
    }
  }, [applyState, refresh, refreshData, session?.accessToken, session?.userId, t])

  const reconnect = React.useCallback(async () => {
    const accessToken = session?.accessToken
    const userId = session?.userId
    const bridge = getDesktopWorkbenchBridge()
    if (!accessToken || !userId || !bridge?.device || busy) return false
    setBusy(true)
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
      refreshData()
      toast.success(t("reconnected"))
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("reconnectFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [binding?.connectorId, busy, refresh, refreshData, session?.accessToken, session?.userId, state?.connectorId, t])

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

  const restart = React.useCallback(async () => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector || busy) return false
    setBusy(true)
    try {
      applyState(await bridge.connector.restart())
      toast.success(t("restarted"))
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("restartFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyState, busy, t])

  const saveSettings = React.useCallback(async (settings: DesktopConnectorSettings) => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.connector || busy) return false
    setBusy(true)
    const previous = state
    if (previous) setState({ ...previous, ...settings })
    try {
      applyState(await bridge.connector.saveSettings(settings))
      return true
    } catch (error) {
      if (previous) setState(previous)
      toast.error(error instanceof Error ? error.message : t("settingsFailed"))
      return false
    } finally {
      setBusy(false)
    }
  }, [applyState, busy, state, t])

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

  const saveNewDeviceName = async () => {
    const accessToken = session?.accessToken
    if (!accessToken || !newDevice || !newDeviceName.trim() || savingName) return
    if (newDeviceName.trim() === newDevice.name) {
      setNewDevice(null)
      return
    }
    setSavingName(true)
    try {
      const response = await dashboardApi.updateConnector(accessToken, newDevice.connectorId, {
        name: newDeviceName.trim(),
      })
      await updateLocalName(response.connector.name)
      setNewDevice(null)
      refreshData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("renameFailed"))
    } finally {
      setSavingName(false)
    }
  }

  const value = React.useMemo<DesktopConnectorContextValue>(() => ({
    supported,
    loading,
    busy,
    state,
    binding,
    isLocalConnector: (connectorId: string) => connectorId === binding?.connectorId,
    refresh,
    reconnect,
    disconnect,
    restart,
    saveSettings,
    openDataFolder,
    updateLocalName,
    explainRemoteReconnect,
  }), [
    binding,
    busy,
    disconnect,
    explainRemoteReconnect,
    loading,
    openDataFolder,
    reconnect,
    refresh,
    restart,
    saveSettings,
    state,
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

      <Dialog open={newDevice !== null} onOpenChange={(open) => {
        if (!open) setNewDevice(null)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("onlineTitle")}</DialogTitle>
            <DialogDescription>{t("onlineDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor="desktop-device-name" className="text-sm font-medium">
              {t("deviceName")}
            </label>
            <Input
              id="desktop-device-name"
              value={newDeviceName}
              onChange={(event) => setNewDeviceName(event.currentTarget.value)}
              disabled={savingName}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewDevice(null)}>
              {t("keepName")}
            </Button>
            <Button
              type="button"
              onClick={() => void saveNewDeviceName()}
              disabled={savingName || !newDeviceName.trim() || newDeviceName.trim() === newDevice?.name}
            >
              {savingName ? t("saving") : t("saveName")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DesktopConnectorContext.Provider>
  )
}
