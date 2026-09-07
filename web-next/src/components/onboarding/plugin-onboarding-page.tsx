"use client"

import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-context'
import { LoginScreen } from '@/components/auth/login-screen'
import { useRouteSearchParams } from '@/components/hash-route-params'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from './reference/components/ui/button'
import { dashboardApi } from '@/features/dashboard/api'
import type { ConnectorView } from '@/features/dashboard/types'
import { readOnboardingTarget, restoreOnboardingStep, saveOnboardingStep, type OnboardingStep, type OnboardingTarget } from '@/features/onboarding/flow'
import { isApiError } from '@/lib/api/errors'
import { App as Onboarding } from './reference/app'
import { OnboardingShell } from './reference/components/onboarding-shell'
import { steps } from './reference/lib/onboarding'
import './reference/styles/onboarding.css'

export function PluginOnboardingPage() {
  const params = useRouteSearchParams()
  const { session, me } = useAuth()
  const target = React.useMemo(() => readOnboardingTarget(params), [params])
  if (!target) return <OnboardingFrame><Alert variant="destructive"><AlertTitle>引导链接无效</AlertTitle><AlertDescription>请回到 DSH 插件，重新点击“继续 Web 引导”。</AlertDescription></Alert></OnboardingFrame>
  if (!session || !me) return <LoginScreen />
  return <DeviceOnboarding key={`${me.userId}:${target.connectorId}:${target.flowId}`} target={target} token={session.accessToken} userId={me.userId} />
}

function DeviceOnboarding({ target, token, userId }: { target: OnboardingTarget; token: string; userId: string }) {
  const { signOut } = useAuth()
  const [connector, setConnector] = React.useState<ConnectorView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [reload, setReload] = React.useState(0)
  const [step, setStep] = React.useState<OnboardingStep>('welcome')
  const [restored, setRestored] = React.useState(false)

  React.useEffect(() => {
    setStep(restoreOnboardingStep(target, userId, window.sessionStorage))
    setRestored(true)
  }, [target, userId])

  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      try {
        // Server endpoint enforces ownership; the URL is never authorization.
        const result = await dashboardApi.getConnector(token, target.connectorId)
        if (stopped) return
        if (result.connector.userId !== userId) { setConnector(null); setError('这台设备不属于当前账号，请切换到插件授权时使用的账号。'); return }
        setConnector(result.connector); setError(null)
      } catch (error) {
        if (stopped) return
        setConnector(null)
        if (isApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404)) {
          setError('登录已失效或当前账号无权访问这台设备，请重新登录。')
          return
        }
        setError('暂时无法读取设备状态，正在重试。')
      }
      if (!stopped) timer = setTimeout(() => void check(), 2500)
    }
    void check()
    return () => { stopped = true; clearTimeout(timer) }
  }, [target.connectorId, token, userId, reload])

  const onPageChange = React.useCallback((page: number) => {
    const next = steps[page]?.id
    if (!next) return
    saveOnboardingStep(target, userId, next, window.sessionStorage)
    setStep(next)
  }, [target, userId])
  const switchAccount = () => {
    const hash = window.location.hash
    signOut()
    window.location.hash = hash
  }
  if (error) return <OnboardingFrame>
    <Alert variant="destructive"><AlertTitle>暂时无法继续设置</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
    <div className="flex gap-3"><Button variant="outline" onClick={() => setReload(value => value + 1)}>重新检查</Button><Button onClick={switchAccount}>重新登录</Button></div>
  </OnboardingFrame>
  if (!restored || !connector || connector.status !== 'online') return <OnboardingFrame>
    <Loader2 className="size-8 animate-spin text-muted-foreground" />
    <h1 className="text-2xl font-semibold">正在等待这台电脑上线</h1>
    <p className="text-sm leading-6 text-muted-foreground">请保持 DSH 和插件运行。连接就绪后会自动继续，你也可以回到插件查看进度或重试。</p>
  </OnboardingFrame>

  return <div className="onboarding-viewport">
    <Onboarding connector={connector} token={token} userId={userId}
      initialPage={steps.findIndex(item => item.id === step)} onPageChange={onPageChange} />
  </div>
}

function OnboardingFrame({ children }: { children: React.ReactNode }) {
  return <div className="onboarding-viewport">
    <OnboardingShell><div className="flex max-w-xl flex-col gap-6">{children}</div></OnboardingShell>
  </div>
}
