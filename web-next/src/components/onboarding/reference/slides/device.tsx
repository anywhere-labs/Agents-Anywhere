import { ArrowRightIcon, CheckIcon, Settings2Icon } from "lucide-react"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import type { SlideProps } from "@/components/onboarding/reference/lib/onboarding"

export function DeviceSlide({ deviceName, onNext, onConfigure }: SlideProps & { deviceName: string; onConfigure: (trigger: HTMLButtonElement) => void }) {
  return (
    <SlideFrame
      id="device"
      title={`${deviceName}\n已连接。`}
      titleSuffix={<CheckIcon className="completion-check" strokeWidth={2.1} />}
      description={"点击下方「配置 Agent」，\n开始配置这台电脑上的 Agent。"}
      actions={<>
        <Button size="lg" onClick={(event) => onConfigure(event.currentTarget)}><Settings2Icon data-icon="inline-start" />配置 Agent</Button>
        <Button variant="ghost" size="lg" onClick={onNext}>下一步<ArrowRightIcon data-icon="inline-end" /></Button>
      </>}
    />
  )
}
