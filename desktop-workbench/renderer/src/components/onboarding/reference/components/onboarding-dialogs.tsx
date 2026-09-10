import { useState } from "react"
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
  onRestoreFocus: () => void
}

export function OnboardingDialogs({ token, userId, kind, open, onOpenChange, onPhoneConnected, onConfirmSkip, onRestoreFocus }: OnboardingDialogsProps) {
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
            <DialogTitle>连接手机</DialogTitle>
            <DialogDescription>打开手机端 Agents Anywhere，扫描二维码。</DialogDescription>
          </DialogHeader>
          <MobileConnectionContent token={token} userId={userId} onComplete={onPhoneConnected} onCancel={close} onBusyChange={setBusy} />
        </>}
        {kind === "skip" && <>
          <DialogHeader>
            <DialogTitle>确认跳过引导？</DialogTitle>
            <DialogDescription>跳过后将略过设备与 Agent 的配置引导，你可以稍后在设备页面继续设置。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="lg" onClick={close}>继续引导</Button>
            <Button size="lg" onClick={onConfirmSkip}>确认跳过</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  )
}
