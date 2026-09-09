import { ArrowRightIcon, SmartphoneIcon } from "lucide-react"
import { PhoneArtwork } from "@/components/onboarding/reference/components/phone-artwork"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button } from "@/components/onboarding/reference/components/ui/button"

// The onboarding flow keeps the reference copy; callers that render the slide
// on its own, such as the mobile connection page, pass translated strings.
const DEFAULT_TITLE = "Agent 在工作。\n你，尽管自由。"
const DEFAULT_DESCRIPTION = "点击下方「连接手机」，\n用手机查看进度、发消息、确认操作。"
const DEFAULT_CONNECT_LABEL = "连接手机"
const DEFAULT_NEXT_LABEL = "下一步"

type PhoneSlideProps = {
  title?: string
  description?: string
  connectLabel?: string
  nextLabel?: string
  /** Omitted when the slide stands alone, such as on the mobile connection page. */
  onNext?: () => void
  onConnect: (trigger: HTMLButtonElement) => void
}

export function PhoneSlide({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  connectLabel = DEFAULT_CONNECT_LABEL,
  nextLabel = DEFAULT_NEXT_LABEL,
  onNext,
  onConnect,
}: PhoneSlideProps) {
  return (
    <SlideFrame
      id="phone"
      title={title}
      description={description}
      artwork={<PhoneArtwork />}
      actions={<>
        <Button size="lg" onClick={(event) => onConnect(event.currentTarget)}><SmartphoneIcon data-icon="inline-start" />{connectLabel}</Button>
        {onNext ? <Button variant="ghost" size="lg" onClick={onNext}>{nextLabel}<ArrowRightIcon data-icon="inline-end" /></Button> : null}
      </>}
    />
  )
}
