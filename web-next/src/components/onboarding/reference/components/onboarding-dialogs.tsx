import { useState } from "react"
import { AgentSetupContent } from "@/components/agent-setup-content"
import { MobileConnectionContent } from "@/components/pages/mobile-signin-panel"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/onboarding/reference/components/ui/dialog"
import type { DialogKind } from "@/components/onboarding/reference/lib/onboarding"
import type { ConnectorView } from "@/features/dashboard/types"

type OnboardingDialogsProps = {
  connector: ConnectorView
  token: string
  userId: string
  kind: DialogKind
  open: boolean
  onOpenChange: (open: boolean) => void
  onPhoneConnected: () => void
  onRestoreFocus: () => void
}

export function OnboardingDialogs({ connector, token, userId, kind, open, onOpenChange, onPhoneConnected, onRestoreFocus }: OnboardingDialogsProps) {
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) onOpenChange(false) }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="onboarding-dialog max-h-[calc(100svh-2rem)] overflow-y-auto" showCloseButton={!busy}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}
        onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus() }}>
        {kind === "agent" && <>
          <DialogHeader>
            <DialogTitle>配置 Agent</DialogTitle>
            <DialogDescription>在 {connector.name} 上选择和设置 Agent。</DialogDescription>
          </DialogHeader>
          <AgentSetupContent connector={connector} onContinue={close} onSkip={close} continueLabel="完成配置" />
        </>}
        {kind === "phone" && <>
          <DialogHeader>
            <DialogTitle>连接手机</DialogTitle>
            <DialogDescription>打开手机端 Agents Anywhere，扫描二维码。</DialogDescription>
          </DialogHeader>
          <MobileConnectionContent token={token} userId={userId} onComplete={onPhoneConnected} onCancel={close} onBusyChange={setBusy} />
        </>}
      </DialogContent>
    </Dialog>
  )
}
