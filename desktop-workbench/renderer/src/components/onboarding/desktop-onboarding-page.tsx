"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { useAuth } from "@/components/auth/auth-context"
import { LoginScreen } from "@/components/auth/login-screen"
import { useRouteSearchParams } from "@/components/hash-route-params"
import { App as Onboarding } from "@/components/onboarding/reference/app"
import { OnboardingShell } from "@/components/onboarding/reference/components/onboarding-shell"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { dashboardApi } from "@/features/dashboard/api"
import type { ConnectorView } from "@/features/dashboard/types"
import { getDesktopWorkbenchBridge } from "@/features/desktop/bridge"
import { isApiError } from "@/lib/api/errors"
import "@/components/onboarding/reference/styles/onboarding.css"

/**
 * Desktop onboarding. The four pages, their copy and their styling are copied
 * from `web-next` unchanged; only the data source differs: this app provisions
 * its own local device instead of reading one handed over by the plugin.
 *
 * `#/onboarding?source=dsh-plugin&flowId=<id>` always starts a new flow.
 * `source=desktop` is a user launch that has not finished yet.
 */
export function DesktopOnboardingPage() {
  const params = useRouteSearchParams()
  const { session, me, loading } = useAuth()
  const source = params.get("source") === "dsh-plugin" ? "dsh-plugin" : "desktop"
  const flowId = params.get("flowId") ?? ""

  if (loading) return <OnboardingFrame><Loader2 className="size-8 animate-spin text-muted-foreground" /></OnboardingFrame>
  if (!session || !me) return <LoginScreen />
  return (
    <DeviceOnboarding
      key={`${me.userId}:${source}:${flowId}`}
      source={source}
      token={session.accessToken}
      userId={me.userId}
    />
  )
}

function DeviceOnboarding({ source, token, userId }: {
  source: "desktop" | "dsh-plugin"
  token: string
  userId: string
}) {
  const [connector, setConnector] = React.useState<ConnectorView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [needsReconnect, setNeedsReconnect] = React.useState(false)
  const [reconnecting, setReconnecting] = React.useState(false)
  const [reload, setReload] = React.useState(0)

  // The local device is Desktop's own responsibility here. Provisioning is
  // idempotent: an existing binding for this account and server is reused.
  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      try {
        const bridge = getDesktopWorkbenchBridge()
        if (!bridge?.device) throw new Error("当前环境不支持本机设备管理。")
        const binding = await bridge.device.createAndConnect({ userToken: token, userId })
        if (stopped) return
        // Another client of this machine (CLI or plugin) can rotate the shared
        // Connector credential, and a user disconnect stops the Connector on
        // purpose. Neither state recovers by itself, so ask for a reconnect
        // instead of waiting for a device that will never come online.
        const connectorState = await bridge.connector?.getState()
        if (stopped) return
        if (connectorState?.authFailed || binding.manualDisconnected) {
          setConnector(null)
          setNeedsReconnect(true)
          setError(connectorState?.authFailed
            ? "本机连接凭据已失效，需要重新连接。"
            : "本机连接已断开，需要重新连接。")
          return
        }
        setNeedsReconnect(false)
        const result = await dashboardApi.getConnector(token, binding.connectorId)
        if (stopped) return
        if (result.connector.userId !== userId) {
          setConnector(null)
          setError("这台设备不属于当前账号，请切换到正确的账号。")
          return
        }
        if (result.connector.status === "online") {
          setConnector(result.connector)
          setError(null)
          return
        }
        setConnector(null)
        setError(null)
      } catch (cause) {
        if (stopped) return
        setConnector(null)
        if (isApiError(cause) && (cause.status === 401 || cause.status === 403)) {
          setError("登录已失效，请重新登录。")
          return
        }
        setError(cause instanceof Error ? cause.message : "暂时无法连接本机设备，正在重试。")
      }
      if (!stopped) timer = setTimeout(() => void check(), 2_500)
    }
    void check()
    return () => { stopped = true; clearTimeout(timer) }
  }, [token, userId, reload])

  const reconnect = React.useCallback(async () => {
    const bridge = getDesktopWorkbenchBridge()
    if (!bridge?.device) return
    setReconnecting(true)
    try {
      await bridge.device.reconnectAndConnect({ userToken: token, userId })
      setError(null)
      setNeedsReconnect(false)
      setReload(value => value + 1)
    } catch (cause) {
      setNeedsReconnect(true)
      setError(cause instanceof Error ? cause.message : "重新连接失败，请稍后再试。")
    } finally {
      setReconnecting(false)
    }
  }, [token, userId])

  const complete = React.useCallback(async () => {
    // Best effort: a failed write only means the user sees the flow again.
    await getDesktopWorkbenchBridge()?.onboarding?.complete(source)
  }, [source])

  if (error) return <OnboardingFrame>
    <Alert variant="destructive"><AlertTitle>暂时无法继续设置</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
    <div className="flex gap-3">
      {needsReconnect
        ? <Button disabled={reconnecting} onClick={() => void reconnect()}>{reconnecting ? "正在重新连接…" : "重新连接"}</Button>
        : null}
      <Button variant="outline" disabled={reconnecting} onClick={() => setReload(value => value + 1)}>重新检查</Button>
    </div>
  </OnboardingFrame>
  if (!connector) return <OnboardingFrame>
    <Loader2 className="size-8 animate-spin text-muted-foreground" />
    <h1 className="text-2xl font-semibold">正在连接这台电脑</h1>
    <p className="text-sm leading-6 text-muted-foreground">正在准备本机设备，就绪后会自动继续。</p>
  </OnboardingFrame>

  return <OnboardingViewport>
    <Onboarding
      connector={connector}
      token={token}
      userId={userId}
      initialPage={0}
      onPageChange={() => undefined}
      onComplete={complete}
      wordmark={false}
    />
  </OnboardingViewport>
}

function OnboardingFrame({ children }: { children: React.ReactNode }) {
  return <OnboardingViewport>
    <OnboardingShell wordmark={false}><div className="flex max-w-xl flex-col gap-6">{children}</div></OnboardingShell>
  </OnboardingViewport>
}

/**
 * The window is frameless on macOS and Windows, so this screen needs its own
 * draggable band. It mirrors the login shell: the wordmark is gone and the
 * shell header below is empty, which is exactly where the band belongs.
 */
function OnboardingViewport({ children }: { children: React.ReactNode }) {
  return <div className="onboarding-viewport">
    <header aria-hidden="true" className="aa-window-drag fixed inset-x-0 top-0 z-20 h-12" />
    {children}
  </div>
}
