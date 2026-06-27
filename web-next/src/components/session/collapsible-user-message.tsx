"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const COLLAPSED_LINES = 10

export function CollapsibleUserMessage({ children }: { children: React.ReactNode }) {
  const tSession = useTranslations("dashboard.session")
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const [collapsedHeight, setCollapsedHeight] = useState<number | null>(null)

  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const measure = () => {
      const style = window.getComputedStyle(content)
      const lineHeight = parseFloat(style.lineHeight)
      const fallbackLineHeight = parseFloat(style.fontSize) * 1.5
      const maxHeight = (Number.isFinite(lineHeight) ? lineHeight : fallbackLineHeight) * COLLAPSED_LINES
      setCollapsedHeight(maxHeight)
      setCollapsible(content.scrollHeight > maxHeight + 1)
    }

    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [children])

  const shouldClamp = collapsible && !expanded && collapsedHeight != null

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn("min-w-0 overflow-hidden", shouldClamp && "relative")}
        style={shouldClamp ? { maxHeight: collapsedHeight } : undefined}
      >
        {children}
      </div>
      {shouldClamp ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-secondary to-transparent" />
      ) : null}
      {collapsible ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-2 h-6 rounded-md px-2 text-xs text-secondary-foreground/80 hover:bg-secondary-foreground/10 hover:text-secondary-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
          {expanded ? tSession("collapseMessage") : tSession("expandMessage")}
        </Button>
      ) : null}
    </div>
  )
}
