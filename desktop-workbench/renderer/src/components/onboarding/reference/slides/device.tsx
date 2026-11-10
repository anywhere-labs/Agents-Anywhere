import { useTranslations } from 'next-intl'
import { useState } from "react"
import { ArrowRightIcon, CheckIcon } from "lucide-react"
import { AgentSetupContent } from "@/components/agent-setup-content"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import type { SlideProps } from "@/components/onboarding/reference/lib/onboarding"

export function DeviceSlide({ connector, onNext }: SlideProps & { connector: { id: string; name: string } }) {
  const t = useTranslations('agentReminder')
  const [busy, setBusy] = useState(true)
  return (
    <SlideFrame
      id="device"
      title={t('deviceConnected', { name: connector.name })}
      titleSuffix={<CheckIcon className="completion-check" strokeWidth={2.1} />}
      description={t('deviceDescription')}
      sideContent={<section className="onboarding-agent-panel" aria-labelledby="agent-setup-title">
        <h2 id="agent-setup-title">{t('configureAgent')}</h2>
        <AgentSetupContent connector={connector} presentation="onboarding" onContinue={onNext} onSkip={onNext} onBusyChange={setBusy} />
      </section>}
      actions={<Button data-onboarding-next size="lg" disabled={busy} onClick={onNext}>{t('next')}<ArrowRightIcon data-icon="inline-end" /></Button>}
    />
  )
}
