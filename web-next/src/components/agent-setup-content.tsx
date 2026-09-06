"use client"

import * as React from 'react'
import { CheckCircle2, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/components/auth/auth-context'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { dashboardApi } from '@/features/dashboard/api'
import { quickAddRuntime } from '@/features/dashboard/quick-add-runtime'
import { discoverConnectorRuntimeOverview, type ConnectorRuntimeOverview } from '@/features/dashboard/runtime-discovery'
import { addableRuntimeTypes, configuredRuntimeInstances, runtimeInstanceName } from '@/features/dashboard/runtime-instances'
import type { DeviceRuntimeView, RuntimeTypeView } from '@/features/dashboard/types'
import { isApiError } from '@/lib/api/errors'
import { isTransientHttpStatus } from '@/lib/retry'

/** Page content shared by onboarding and the existing quick-add dialog. */
export function AgentSetupContent({ connector, onContinue, onSkip, onChanged, continueLabel = '下一步', presentation = 'default', onBusyChange }: {
  connector: { id: string; name: string }
  onContinue: () => void
  onSkip: () => void
  onChanged?: () => void
  continueLabel?: string
  presentation?: 'default' | 'onboarding'
  onBusyChange?: (busy: boolean) => void
}) {
  const { session } = useAuth()
  const t = useTranslations('dashboard.pairDevice')
  const tDevice = useTranslations('dashboard.device')
  const [overview, setOverview] = React.useState<ConnectorRuntimeOverview>({ runtimes: [], runtimeTypes: [] })
  const [loading, setLoading] = React.useState(true)
  const [waitingOnline, setWaitingOnline] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [reload, setReload] = React.useState(0)
  const [addingType, setAddingType] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const generation = React.useRef(0)

  React.useEffect(() => {
    const token = session?.accessToken
    if (!token) return
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true); setError(null); setLoadFailed(false)
    const load = async () => {
      try {
        const response = await dashboardApi.getConnector(token, connector.id)
        if (current !== generation.current) return
        if (response.connector.status !== 'online') {
          setWaitingOnline(true)
          timer = setTimeout(() => void load(), 2000)
          return
        }
        setWaitingOnline(false)
        const next = await discoverConnectorRuntimeOverview(token, connector.id)
        if (current !== generation.current) return
        setOverview(next); setLoading(false)
      } catch (error) {
        if (current !== generation.current) return
        if (isApiError(error) && (isTransientHttpStatus(error.status) || error.status === 409)) {
          setWaitingOnline(true)
          timer = setTimeout(() => void load(), 2000)
          return
        }
        setError(error instanceof Error ? error.message : t('errors.discoverRuntimesFailed'))
        setLoadFailed(true); setLoading(false)
      }
    }
    void load()
    return () => { generation.current++; clearTimeout(timer) }
  }, [connector.id, reload, session?.accessToken, t])

  const runAction = async (runtimeType: string, action: (update: (runtime: DeviceRuntimeView) => void) => Promise<DeviceRuntimeView>) => {
    if (busyRef.current) return
    const current = generation.current
    const update = (runtime: DeviceRuntimeView) => {
      if (current !== generation.current) return
      setOverview(previous => ({ ...previous, runtimes: [...previous.runtimes.filter(item => item.runtimeId !== runtime.runtimeId), runtime] }))
    }
    busyRef.current = true; setAddingType(runtimeType); setError(null)
    try {
      update(await action(update))
      if (current === generation.current) onChanged?.()
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : t('errors.configureAndStartFailed'))
    } finally {
      busyRef.current = false
      if (current === generation.current) setAddingType(null)
    }
  }

  const add = (runtimeType: RuntimeTypeView) => {
    if (!session?.accessToken) return
    return runAction(runtimeType.runtimeType, update => quickAddRuntime({
      token: session.accessToken, connectorId: connector.id, runtimeType, onRuntimeUpdated: update,
    }))
  }
  const start = (runtime: DeviceRuntimeView) => {
    if (!session?.accessToken) return
    return runAction(runtime.runtimeType, () => dashboardApi.setConnectorRuntimeActive(session.accessToken, connector.id, runtime.runtimeId, true))
  }
  const configured = configuredRuntimeInstances(overview.runtimes)
  const addable = addableRuntimeTypes(overview.runtimeTypes, overview.runtimes)
  const busy = addingType !== null
  const inline = presentation === 'onboarding'
  const rowClassName = inline ? 'flex min-h-20 items-center gap-3 border-b border-border/60 py-5 last:border-b-0' : 'flex items-center gap-3 rounded-lg border p-4'
  const buttonClassName = inline ? 'h-9 rounded-lg px-3' : undefined
  React.useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  return <div className="flex flex-col gap-6">
    <div className={inline ? 'flex max-h-[55vh] flex-col overflow-y-auto' : 'flex max-h-[55vh] flex-col gap-3 overflow-y-auto'}>
      {!inline ? <p className="text-sm text-muted-foreground">{t('agentsDescription')}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t(waitingOnline ? 'waitingReconnectTitle' : 'discoveringAgents')}</div> : null}
      {!loading && !loadFailed ? <>
        {configured.map(runtime => {
          const ready = runtime.active && runtime.status === 'running'
          const starting = runtime.active && runtime.status === 'starting'
          const needsSetup = inline ? !ready && !starting : !runtime.active || runtime.status === 'error' || runtime.status === 'stopped'
          return <div key={runtime.runtimeId} className={rowClassName}>
            {!inline ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : null}
            <div className="min-w-0 flex-1">
              <p className={inline ? 'truncate text-base font-medium' : 'truncate text-sm font-medium'}>{runtimeInstanceName(runtime)}</p>
              <p className="text-xs text-muted-foreground">{inline ? ready ? '已就绪' : starting ? '正在启动' : '未就绪' : t(runtime.status === 'running' ? 'agentRunning' : 'agentConfigured')}</p>
            </div>
            {inline && ready ? <CheckCircle2 className="size-5 shrink-0 text-[var(--success)]" /> : null}
            {inline && starting ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
            {needsSetup ? <Button size="sm" variant={inline ? 'default' : 'outline'} className={buttonClassName} disabled={busy} onClick={() => void start(runtime)}>
              {addingType === runtime.runtimeType ? <Loader2 data-icon="inline-start" className="animate-spin" /> : inline ? <Plus data-icon="inline-start" /> : null}
              {inline ? '一键配置' : tDevice('activateRuntime', { name: runtimeInstanceName(runtime) })}
            </Button> : null}
          </div>
        })}
        {addable.map(runtimeType => <div key={runtimeType.runtimeType} className={rowClassName}>
          <div className="min-w-0 flex-1"><p className={inline ? 'text-base font-medium' : 'text-sm font-medium'}>{runtimeType.displayName}</p>{!inline && runtimeType.description ? <p className="text-xs text-muted-foreground">{runtimeType.description}</p> : null}</div>
          <Button size="sm" className={buttonClassName} disabled={busy} onClick={() => void add(runtimeType)}>{addingType === runtimeType.runtimeType ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}{inline ? '一键配置' : t('quickAdd')}</Button>
        </div>)}
        {configured.length === 0 && addable.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('noAgentsFound')}</p> : null}
      </> : null}
      {loadFailed ? <Button variant="outline" onClick={() => setReload(value => value + 1)}><RefreshCw data-icon="inline-start" />重新检测</Button> : null}
    </div>
    {!inline ? <div className="flex flex-wrap justify-end gap-3">
      <Button variant="ghost" disabled={busy || loading || loadFailed} onClick={onSkip}>{t('skipAgents')}</Button>
      <Button disabled={busy || loading || loadFailed} onClick={onContinue}>{continueLabel}</Button>
    </div> : null}
  </div>
}
