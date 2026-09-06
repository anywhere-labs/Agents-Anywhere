import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { OnboardingDialogs } from "@/components/onboarding/reference/components/onboarding-dialogs"
import { OnboardingShell } from "@/components/onboarding/reference/components/onboarding-shell"
import { useReducedMotion } from "@/components/onboarding/reference/hooks/use-reduced-motion"
import { steps, type DialogKind } from "@/components/onboarding/reference/lib/onboarding"
import { CompleteSlide } from "@/components/onboarding/reference/slides/complete"
import { DeviceSlide } from "@/components/onboarding/reference/slides/device"
import { PhoneSlide } from "@/components/onboarding/reference/slides/phone"
import { WelcomeSlide } from "@/components/onboarding/reference/slides/welcome"
import type { ConnectorView } from "@/features/dashboard/types"
import { PRODUCT_LINKS } from "@/lib/product-links"

type Props = {
  connector: ConnectorView
  token: string
  userId: string
  initialPage: number
  onPageChange: (page: number) => void
}

export function App({ connector, token, userId, initialPage, onPageChange }: Props) {
  const [page, setPage] = useState(initialPage)
  const [transitioning, setTransitioning] = useState(false)
  const [direction, setDirection] = useState(1)
  const [dialog, setDialog] = useState<{ kind: DialogKind; open: boolean }>({ kind: "agent", open: false })
  const pageRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const navigationLock = useRef(false)
  const hasNavigated = useRef(false)
  const reducedMotion = useReducedMotion()

  const navigate = useCallback(async (next: number) => {
    if (navigationLock.current || next === page || next < 0 || next >= steps.length) return
    navigationLock.current = true
    hasNavigated.current = true
    setTransitioning(true)
    const nextDirection = next > page ? 1 : -1
    if (!reducedMotion && pageRef.current) {
      const currentStyle = getComputedStyle(pageRef.current)
      const animation = pageRef.current.animate([
        { opacity: currentStyle.opacity, transform: currentStyle.transform, filter: currentStyle.filter },
        { opacity: 0, transform: `translateX(${-nextDirection * 18}px)`, filter: "blur(4px)" },
      ], { duration: 220, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" })
      await animation.finished.catch(() => undefined)
    }
    setDirection(nextDirection)
    setPage(next)
    onPageChange(next)
    setTransitioning(false)
    navigationLock.current = false
  }, [page, reducedMotion, onPageChange])

  useEffect(() => {
    if (hasNavigated.current) {
      pageRef.current?.closest(".onboarding-viewport")?.scrollTo({ top: 0, behavior: "instant" })
      pageRef.current?.querySelector("h1")?.focus({ preventScroll: true })
    }
  }, [page])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || dialog.open || transitioning) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      if (event.key === "ArrowLeft" && page > 0) {
        event.preventDefault()
        void navigate(page - 1)
      } else if (event.key === "ArrowRight" && page < steps.length - 1) {
        event.preventDefault()
        void navigate(page + 1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [dialog.open, navigate, page, transitioning])

  function openDialog(kind: DialogKind, trigger: HTMLButtonElement) {
    triggerRef.current = trigger
    setDialog({ kind, open: true })
  }

  const next = () => { void navigate(page + 1) }

  return (
    <>
      <OnboardingShell artwork={page === 0 ? "desktop" : page === 2 ? "phone" : undefined}>
        <div key={page} ref={pageRef} className="slide-page" inert={transitioning} style={{ "--entry-x": `${direction * 22}px` } as CSSProperties}>
          {page === 0 && <WelcomeSlide onNext={next} onSkip={() => { void navigate(3) }} />}
          {page === 1 && <DeviceSlide deviceName={connector.name} onNext={next} onConfigure={(trigger) => openDialog("agent", trigger)} />}
          {page === 2 && <PhoneSlide onNext={next} onConnect={(trigger) => openDialog("phone", trigger)} />}
          {page === 3 && <CompleteSlide onExperience={() => { window.location.href = PRODUCT_LINKS.webAppHref }} />}
        </div>
      </OnboardingShell>
      <OnboardingDialogs
        connector={connector} token={token} userId={userId}
        kind={dialog.kind} open={dialog.open}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onRestoreFocus={() => { if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true }) }}
        onPhoneConnected={() => { setDialog((current) => ({ ...current, open: false })); void navigate(3) }}
      />
    </>
  )
}
