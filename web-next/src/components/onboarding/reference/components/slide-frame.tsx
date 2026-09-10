import type { CSSProperties, ReactNode } from "react"
import { RevealText, revealEnd } from "@/components/onboarding/reference/components/reveal-text"
import { cn } from "@/components/onboarding/reference/lib/utils"

type SlideFrameProps = {
  id: string
  title: string
  titleSuffix?: ReactNode
  description: string
  details?: ReactNode
  artwork?: ReactNode
  artworkLayout?: "phone" | "desktop"
  sideContent?: ReactNode
  actions: ReactNode
  englishTitle?: boolean
}

export function SlideFrame({
  id, title, titleSuffix, description, details, artwork, artworkLayout = "phone", sideContent, actions, englishTitle,
}: SlideFrameProps) {
  const descriptionDelay = revealEnd(title, 120) - 90
  const detailDelay = revealEnd(description, descriptionDelay) - 30

  return (
    <section
      className={cn("slide-layout", artwork && "slide-layout-with-artwork", artwork && artworkLayout === "desktop" && "slide-layout-desktop", sideContent && "slide-layout-with-panel")}
      aria-labelledby={`${id}-title`}
      data-slide={id}
    >
      <div className="slide-copy">
        <RevealText
          as="h1" id={`${id}-title`} text={title} delay={120} suffix={titleSuffix}
          className={cn("slide-title", englishTitle && "slide-title-english")}
        />
        <RevealText text={description} delay={descriptionDelay} className="slide-description" />
        {details && (
          <div className="slide-details reveal-detail" data-reveal style={{ "--reveal-delay": `${detailDelay}ms` } as CSSProperties}>
            {details}
          </div>
        )}
        {!sideContent && <div className="slide-actions">
          {actions}
        </div>}
      </div>
      {sideContent && <>
        <div className="slide-panel reveal-detail" style={{ "--reveal-delay": "240ms" } as CSSProperties}>{sideContent}</div>
        <div className="slide-actions">{actions}</div>
      </>}
      {artwork && (
        <div className="slide-artwork reveal-detail" style={{ "--reveal-delay": "240ms" } as CSSProperties} aria-hidden="true">
          {artwork}
        </div>
      )}
    </section>
  )
}
