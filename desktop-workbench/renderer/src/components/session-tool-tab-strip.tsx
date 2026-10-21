"use client"

import * as React from "react"

import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"

export function SessionToolTabStrip({ children, label, onKeyDown }: {
  children: React.ReactNode
  label: string
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
}) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      if (viewport.scrollWidth <= viewport.clientWidth) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1
      const next = Math.max(0, Math.min(
        viewport.scrollWidth - viewport.clientWidth,
        viewport.scrollLeft + event.deltaY * unit,
      ))
      if (next === viewport.scrollLeft) return
      event.preventDefault()
      viewport.scrollLeft = next
    }
    viewport.addEventListener("wheel", handleWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", handleWheel)
  }, [])

  return (
    <ScrollArea className="h-8 min-w-0 flex-1" contentWide type="auto" viewportRef={viewportRef}>
      <div role="tablist" aria-label={label} className="flex h-8 items-center gap-1" onKeyDown={onKeyDown}>
        {children}
      </div>
      <ScrollBar orientation="horizontal" className="data-horizontal:h-1.5 data-horizontal:translate-y-full data-horizontal:border-t-0 p-0" />
    </ScrollArea>
  )
}
