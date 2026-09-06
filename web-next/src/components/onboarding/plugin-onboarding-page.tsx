"use client"

import * as React from 'react'
import { ArrowRight, CheckCircle2, Download, ExternalLink, Loader2, Monitor, Smartphone } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-context'
import { LoginScreen } from '@/components/auth/login-screen'
import { useRouteSearchParams } from '@/components/hash-route-params'
import { AgentSetupContent } from '@/components/agent-setup-content'
import { MobileConnectionContent } from '@/components/pages/mobile-signin-panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { dashboardApi } from '@/features/dashboard/api'
import type { ConnectorView } from '@/features/dashboard/types'
import { readOnboardingTarget, restoreOnboardingStep, saveOnboardingStep, type OnboardingStep, type OnboardingTarget } from '@/features/onboarding/flow'
import { isApiError } from '@/lib/api/errors'
import { PRODUCT_LINKS } from '@/lib/product-links'

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
  const [step, setStep] = React.useState<OnboardingStep>('agents')
  const [mobileStep, setMobileStep] = React.useState<'install' | 'scan'>('install')
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

  const go = (next: OnboardingStep) => {
    saveOnboardingStep(target, userId, next, window.sessionStorage)
    setStep(next)
  }
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

  const progress = step === 'agents' ? 25 : step === 'mobile-choice' ? 50 : step === 'mobile' ? (mobileStep === 'install' ? 65 : 85) : 100
  return <OnboardingFrame>
    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground"><span className="flex items-center gap-2"><Monitor className="size-4" />{connector.name}</span><span>设备已连接</span></div>
    <Progress value={progress} aria-label="设置进度" />
    {step === 'agents' ? <>
      <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold">添加你的 Agent</h1><p className="text-sm leading-6 text-muted-foreground">选择这台电脑上可以使用的 Agent，也可以稍后再添加。</p></div>
      <AgentSetupContent connector={connector} onContinue={() => go('mobile-choice')} onSkip={() => go('mobile-choice')} />
    </> : null}
    {step === 'mobile-choice' ? <>
      <Smartphone className="size-10 text-primary" />
      <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold">也在手机上使用</h1><p className="text-sm leading-7 text-muted-foreground">安装手机客户端，随时发起对话、查看任务进度，或继续电脑上的工作。</p></div>
      <div className="flex flex-wrap justify-end gap-3"><Button variant="ghost" onClick={() => go('agents')}>上一步</Button><Button variant="outline" onClick={() => go('complete')}>暂时跳过</Button><Button onClick={() => go('mobile')}>连接手机<ArrowRight data-icon="inline-end" /></Button></div>
    </> : null}
    {step === 'mobile' ? <MobileConnectionContent token={token} userId={userId} onStepChange={setMobileStep} onComplete={() => go('complete')} onCancel={() => go('mobile-choice')} /> : null}
    {step === 'complete' ? <div className="flex flex-col items-center gap-6 py-8 text-center">
      <CheckCircle2 className="size-14 text-primary" />
      <div className="flex flex-col gap-2"><h1 className="text-3xl font-semibold">设置完成</h1><p className="text-sm leading-7 text-muted-foreground">设备已连接，现在可以开始使用 Agents Anywhere 了。</p></div>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild><a href={PRODUCT_LINKS.webAppHref}>立即体验<ArrowRight data-icon="inline-end" /></a></Button>
        {PRODUCT_LINKS.desktopDownloadUrl ? <Button variant="outline" asChild><a href={PRODUCT_LINKS.desktopDownloadUrl} target="_blank" rel="noreferrer"><Download data-icon="inline-start" />下载桌面端</a></Button> : <Button variant="outline" disabled><Download data-icon="inline-start" />下载桌面端 · 暂未开放</Button>}
      </div>
      <p className="text-xs text-muted-foreground">想了解更多？{PRODUCT_LINKS.landingPageUrl ? <a className="inline-flex items-center gap-1 underline underline-offset-4" href={PRODUCT_LINKS.landingPageUrl} target="_blank" rel="noreferrer">访问官网<ExternalLink className="size-3" /></a> : '官网即将上线'}</p>
    </div> : null}
  </OnboardingFrame>
}

function OnboardingFrame({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-svh items-center justify-center bg-background px-5 py-10">
    <section className="flex w-full max-w-xl flex-col gap-6 rounded-2xl border bg-card p-6 shadow-sm sm:p-10">
      <p className="text-xs font-medium tracking-widest text-muted-foreground">AGENTS ANYWHERE</p>
      {children}
    </section>
  </main>
}
