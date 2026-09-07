import { ArrowRightIcon, SmartphoneIcon } from "lucide-react"
import { PhoneArtwork } from "@/components/onboarding/reference/components/phone-artwork"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import type { SlideProps } from "@/components/onboarding/reference/lib/onboarding"

export function PhoneSlide({ onNext, onConnect }: SlideProps & { onConnect: (trigger: HTMLButtonElement) => void }) {
  return (
    <SlideFrame
      id="phone"
      title={"Agent 在工作。\n你，尽管自由。"}
      description={"点击下方「连接手机」，\n用手机查看进度、发消息、确认操作。"}
      artwork={<PhoneArtwork />}
      actions={<>
        <Button size="lg" onClick={(event) => onConnect(event.currentTarget)}><SmartphoneIcon data-icon="inline-start" />连接手机</Button>
        <Button variant="ghost" size="lg" onClick={onNext}>下一步<ArrowRightIcon data-icon="inline-end" /></Button>
      </>}
    />
  )
}
