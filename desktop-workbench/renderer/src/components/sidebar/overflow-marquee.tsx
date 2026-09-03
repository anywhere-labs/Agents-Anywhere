"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const MARQUEE_MILLISECONDS_PER_PIXEL = 30

type OverflowMarqueeProps = {
  text: string
  active: boolean
  className?: string
}

export function OverflowMarquee({
  text,
  active,
  className,
}: OverflowMarqueeProps) {
  const viewportRef = React.useRef<HTMLSpanElement>(null)
  const contentRef = React.useRef<HTMLSpanElement>(null)
  const animationRef = React.useRef<Animation | null>(null)
  const [overflowDistance, setOverflowDistance] = React.useState(0)

  React.useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    const measure = () => {
      const nextDistance = Math.max(0, Math.ceil(content.scrollWidth - viewport.clientWidth))
      setOverflowDistance((current) => current === nextDistance ? current : nextDistance)
    }

    measure()
    window.addEventListener("resize", measure)

    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [text])

  React.useEffect(() => {
    animationRef.current?.cancel()
    animationRef.current = null

    const content = contentRef.current
    if (!content || !active || overflowDistance <= 0) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    animationRef.current = content.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(-${overflowDistance}px)` },
      ],
      {
        delay: 350,
        duration: overflowDistance * MARQUEE_MILLISECONDS_PER_PIXEL,
        easing: "linear",
        fill: "forwards",
      },
    )

    return () => {
      animationRef.current?.cancel()
      animationRef.current = null
    }
  }, [active, overflowDistance, text])

  return (
    <span
      ref={viewportRef}
      className={cn("min-w-0 flex-1 overflow-hidden", className)}
    >
      <span ref={contentRef} className="inline-block whitespace-nowrap">
        {text}
      </span>
    </span>
  )
}
