"use client"

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/components/auth/auth-context'
import { useWorkspace } from '@/components/workspace-context'
import { AgentSetupContent } from '@/components/agent-setup-content'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { hasConfiguredAgents } from '@/features/onboarding/agent-presence'

/** Check once per workspace entry; a failed query is never treated as empty. */
export function EmptyAgentPrompt({ blocked = false }: { blocked?: boolean }) {
  const { session } = useAuth()
  const { connectors, runtimes, isLoading, page, routeReady, pairDeviceDialogOpen, firstDevicePromptOpen, refreshData, navigateToDevice } = useWorkspace()
  const t = useTranslations('agentReminder')
  const checked = React.useRef<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const token = session?.accessToken
  const userId = session?.userId
  React.useEffect(() => {
    if (!token || !userId || isLoading || !routeReady || page !== 'home' || blocked || pairDeviceDialogOpen || firstDevicePromptOpen || connectors.length === 0 || checked.current === userId) return
    if (runtimes.some(runtime => runtime.configured)) { checked.current = userId; return }
    let cancelled = false
    void hasConfiguredAgents(token).then(hasAgents => {
      if (cancelled) return
      checked.current = userId
      if (!hasAgents) setOpen(true)
    }).catch(() => { /* Leave the check retryable after a later workspace update. */ })
    return () => { cancelled = true }
  }, [token, userId, isLoading, routeReady, page, blocked, pairDeviceDialogOpen, firstDevicePromptOpen, connectors, runtimes])
  const online = connectors.filter(connector => connector.status === 'online')
  const connector = online.find(item => item.id === selectedId) ?? online[0]
  const close = () => { if (!busy) setOpen(false) }
  return <Dialog open={open && !blocked && !pairDeviceDialogOpen && !firstDevicePromptOpen} onOpenChange={value => { if (!busy) setOpen(value) }}>
    <DialogContent className="sm:max-w-xl" showCloseButton={!busy}
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
      onInteractOutside={event => { if (busy) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      {online.length > 1 && <div className="flex flex-wrap gap-2" role="group" aria-label={t('chooseDevice')}>
        {online.map(item => <Button key={item.id} variant={item.id === connector?.id ? 'default' : 'outline'} disabled={busy} onClick={() => setSelectedId(item.id)}>{item.name}</Button>)}
      </div>}
      {connector ? <AgentSetupContent key={connector.id} connector={connector} onContinue={close} onSkip={close} onChanged={refreshData} onActionBusyChange={setBusy} continueLabel={t('done')} /> : <>
        <p className="text-sm text-muted-foreground">{t('offline')}</p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={close}>{t('later')}</Button>
          <Button onClick={() => { close(); if (connectors[0]) navigateToDevice(connectors[0].id) }}>{t('openDevice')}</Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>
}
