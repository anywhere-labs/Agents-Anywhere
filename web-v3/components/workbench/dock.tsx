"use client"

// A panel on the right that slides in and out whole (Effi's assistant dock). Docked, it sits beside the content and
// pushes it over: the outer box animates its width and clips, the panel inside keeps its width and hugs the left
// edge. As an overlay (when there is not room beside the content) it slides over the content from the right edge.
// Both keep the same element tree, so switching between them does not remount what is inside. The width is dragged
// by the left edge and kept in this browser. What is inside mounts on the first open and, unless `keepMounted`,
// unmounts once the panel has slid away.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { ResizeHandle } from "@/components/workbench/resize-handle"
import { clampWidth, usePanelWidth, type PanelWidthSpec } from "@/hooks/use-panel-width"
import { cn } from "@/lib/utils"

/** The slide: quick out of the gate, settling softly (Effi, iOS sheets). */
export const DOCK_EASE = "duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"

export function Dock({
  open,
  spec,
  cap,
  overlay = false,
  keepMounted = false,
  resizeLabel,
  resizeTitle,
  className,
  children,
}: {
  open: boolean
  spec: PanelWidthSpec
  /** The room there is now: the panel is never wider. */
  cap?: number
  overlay?: boolean
  keepMounted?: boolean
  resizeLabel: string
  resizeTitle: string
  className?: string
  children: ReactNode
}) {
  const { width, preview, commit, reset } = usePanelWidth(spec)
  const [resizing, setResizing] = useState(false)
  const shown = clampWidth(spec, width, cap)

  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open || keepMounted || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), 350)
    return () => window.clearTimeout(timer)
  }, [open, keepMounted, mounted])

  const ease = !resizing && DOCK_EASE
  return (
    <div
      inert={!open}
      style={{ "--dock-w": `${shown}px` } as CSSProperties}
      className={cn(
        overlay
          ? cn("absolute inset-y-0 right-0 z-30 w-(--dock-w)", !open && "pointer-events-none")
          : cn("relative h-full shrink-0 overflow-hidden", open ? "w-(--dock-w)" : "w-0", ease && `transition-[width] ${ease}`)
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex w-(--dock-w) flex-col border-l border-border bg-background",
          overlay && (open ? "translate-x-0 shadow-xl" : "translate-x-full shadow-none"),
          overlay && ease && `transition-[translate,box-shadow] ${ease}`,
          className
        )}
      >
        {mounted && children}
      </div>
      {open && (
        <ResizeHandle
          edge="left"
          inside
          width={shown}
          min={spec.min}
          max={clampWidth(spec, Infinity, cap)}
          label={resizeLabel}
          title={resizeTitle}
          onPreview={preview}
          onCommit={commit}
          onReset={reset}
          onResizing={setResizing}
        />
      )}
    </div>
  )
}
