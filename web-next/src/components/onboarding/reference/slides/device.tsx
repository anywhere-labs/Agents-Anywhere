import { useState } from "react"
import { ArrowRightIcon, CheckIcon } from "lucide-react"
import { AgentSetupContent } from "@/components/agent-setup-content"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import type { SlideProps } from "@/components/onboarding/reference/lib/onboarding"

export function DeviceSlide({ connector, onNext }: SlideProps & { connector: { id: string; name: string } }) {
  const [busy, setBusy] = useState(false)
  return (
    <SlideFrame
      id="device"
      title={`${connector.name}\n已连接。`}
      titleSuffix={<CheckIcon className="completion-check" strokeWidth={2.1} />}
      description={"添加这台电脑上可用的 Agent，\n也可以稍后在设备页面配置。"}
      sideContent={<section className="onboarding-agent-panel" aria-labelledby="agent-setup-title">
        <h2 id="agent-setup-title">配置 Agent</h2>
        <AgentSetupContent connector={connector} presentation="onboarding" onContinue={onNext} onSkip={onNext} onBusyChange={setBusy} />
      </section>}
      actions={<Button size="lg" disabled={busy} onClick={onNext}>下一步<ArrowRightIcon data-icon="inline-end" /></Button>}
    />
  )
}
