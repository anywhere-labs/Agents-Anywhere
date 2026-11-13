import { useTranslations } from 'next-intl'
import { hasConfiguredAgents } from '@/features/onboarding/agent-presence'
import { useEffect, useRef, useState } from "react"
import { MobileConnectionContent } from "@/components/pages/mobile-signin-panel"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/onboarding/reference/components/ui/dialog"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import type { DialogKind } from "@/components/onboarding/reference/lib/onboarding"

type OnboardingDialogsProps = {
  token: string
  userId: string
  kind: DialogKind
  open: boolean
  onOpenChange: (open: boolean) => void
  onPhoneConnected: () => void
  onConfirmSkip: () => void
  onAddAgent: () => void
  onlyIfEmpty?: boolean
  onRestoreFocus: () => void
}

export function OnboardingDialogs({ token, userId, kind, open, onOpenChange, onPhoneConnected, onConfirmSkip, onRestoreFocus, onAddAgent, onlyIfEmpty }: OnboardingDialogsProps) {
  const t = useTranslations('agentReminder')
  const [hasAgents, setHasAgents] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const confirmRef = useRef(onConfirmSkip)
  confirmRef.current = onConfirmSkip
  useEffect(() => {
    if (!open || kind !== 'skip') return
    let cancelled = false
    setHasAgents(null)
    setFailed(false)
    void hasConfiguredAgents(token).then(value => {
      if (cancelled) return
      setHasAgents(value)
      if (value && onlyIfEmpty) confirmRef.current()
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [open, kind, token, onlyIfEmpty, retry])
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) onOpenChange(false) }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="onboarding-dialog max-h-[calc(100svh-2rem)] overflow-y-auto" showCloseButton={!busy}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}
        onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus() }}>
        {kind === "phone" && <>
          <DialogHeader>
            <DialogTitle>{t('phoneTitle')}</DialogTitle>
            <DialogDescription>{t('phoneDescription')}</DialogDescription>
          </DialogHeader>
          <MobileConnectionContent token={token} userId={userId} onComplete={onPhoneConnected} onCancel={close} onBusyChange={setBusy} />
        </>}
        {kind === "skip" && <>
          <DialogHeader>
            <DialogTitle>{t(hasAgents === false ? 'title' : 'skipTitle')}</DialogTitle>
            <DialogDescription>{t(failed ? 'checkFailed' : hasAgents === null ? 'checking' : hasAgents ? 'skipDescription' : 'description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="lg" onClick={close}>{t('continueTutorial')}</Button>
            {failed ? <Button size="lg" onClick={() => setRetry(value => value + 1)}>{t('retry')}</Button> : <>
              <Button variant={hasAgents === false ? 'ghost' : 'default'} size="lg" disabled={hasAgents === null} onClick={onConfirmSkip}>{t('skipAnyway')}</Button>
              {hasAgents === false && <Button size="lg" onClick={onAddAgent}>{t('addAgent')}</Button>}
            </>}
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  )
}
