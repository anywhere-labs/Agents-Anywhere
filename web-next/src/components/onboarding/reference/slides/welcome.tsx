import { ArrowRightIcon } from "lucide-react"
import { DesktopArtwork } from "@/components/onboarding/reference/components/desktop-artwork"
import { SlideFrame } from "@/components/onboarding/reference/components/slide-frame"
import { Button } from "@/components/onboarding/reference/components/ui/button"
import { onboarding, type SlideProps } from "@/components/onboarding/reference/lib/onboarding"

export function WelcomeSlide({ onNext, onSkip }: SlideProps & { onSkip: (trigger: HTMLButtonElement) => void }) {
  return (
    <SlideFrame
      id="welcome"
      title={"你的 Agent，\n随时，随地。"}
      description={"连接你电脑上的智能体（Agent）。\n用手机或其他电脑，也能继续使用。"}
      artwork={<DesktopArtwork />} artworkLayout="desktop"
      details={<ul className="agent-list" aria-label="支持的智能体">{onboarding.agents.map((name) => <li key={name}>{name}</li>)}</ul>}
      actions={<>
        <Button size="lg" onClick={onNext}>下一页<ArrowRightIcon data-icon="inline-end" /></Button>
        <Button variant="ghost" size="lg" onClick={(event) => onSkip(event.currentTarget)}>跳过引导</Button>
      </>}
    />
  )
}
