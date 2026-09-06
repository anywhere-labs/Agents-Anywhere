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
export function AgentSetupContent({ connector, onContinue, onSkip, onChanged, continueLabel = '下一步' }: {
  connector: { id: string; name: string }
  onContinue: () => void
  onSkip: () => void
  onChanged?: () => void
  continueLabel?: string
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

  return <div className="flex flex-col gap-6">
    <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
      <p className="text-sm text-muted-foreground">{t('agentsDescription')}</p>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {loading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t(waitingOnline ? 'waitingReconnectTitle' : 'discoveringAgents')}</div> : null}
      {!loading && !loadFailed ? <>
        {configured.map(runtime => <div key={runtime.runtimeId} className="flex items-center gap-3 rounded-lg border p-4">
          <CheckCircle2 className="size-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{runtimeInstanceName(runtime)}</p><p className="text-xs text-muted-foreground">{t(runtime.status === 'running' ? 'agentRunning' : 'agentConfigured')}</p></div>
          {!runtime.active || runtime.status === 'error' || runtime.status === 'stopped' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void start(runtime)}>
            {addingType === runtime.runtimeType ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{tDevice('activateRuntime', { name: runtimeInstanceName(runtime) })}
          </Button> : null}
        </div>)}
        {addable.map(runtimeType => <div key={runtimeType.runtimeType} className="flex items-center gap-3 rounded-lg border p-4">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{runtimeType.displayName}</p>{runtimeType.description ? <p className="text-xs text-muted-foreground">{runtimeType.description}</p> : null}</div>
          <Button size="sm" disabled={busy} onClick={() => void add(runtimeType)}>{addingType === runtimeType.runtimeType ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}{t('quickAdd')}</Button>
        </div>)}
        {configured.length === 0 && addable.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('noAgentsFound')}</p> : null}
      </> : null}
      {loadFailed ? <Button variant="outline" onClick={() => setReload(value => value + 1)}><RefreshCw data-icon="inline-start" />重新检测</Button> : null}
    </div>
    <div className="flex flex-wrap justify-end gap-3">
      <Button variant="ghost" disabled={busy || loading || loadFailed} onClick={onSkip}>{t('skipAgents')}</Button>
      <Button disabled={busy || loading || loadFailed} onClick={onContinue}>{continueLabel}</Button>
    </div>
  </div>
}
