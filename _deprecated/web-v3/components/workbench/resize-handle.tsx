"use client"

// The draggable edge of a side panel (Effi's assistant dock): drag to resize, arrow keys too (Shift for bigger
// steps), double-click for the default width. `edge` is the side of the panel the handle is on: a left sidebar is
// dragged by its right edge, a right panel by its left edge. `inside` keeps the handle within the panel (for panels
// that clip); otherwise it straddles the edge.
import { useRef, useState } from "react"

import { cn } from "@/lib/utils"

export function ResizeHandle({
  edge,
  inside = false,
  width,
  min,
  max,
  label,
  title,
  onPreview,
  onCommit,
  onReset,
  onResizing,
  className,
}: {
  edge: "left" | "right"
  inside?: boolean
  width: number
  min: number
  max: number
  /** Accessible name, e.g. 「调整侧边栏宽度」. */
  label: string
  /** Hover hint, e.g. 「拖动调整宽度，双击恢复」. */
  title: string
  onPreview: (width: number) => void
  onCommit: (width: number) => void
  onReset: () => void
  onResizing?: (resizing: boolean) => void
  className?: string
}) {
  const start = useRef<{ x: number; width: number } | null>(null)
  const latest = useRef(width)
  const [dragging, setDragging] = useState(false)
  // Dragging right widens a left sidebar and narrows a right panel.
  const sign = edge === "right" ? 1 : -1

  const setResizing = (value: boolean) => {
    setDragging(value)
    onResizing?.(value)
  }
  const finish = () => {
    if (!start.current) return
    start.current = null
    setResizing(false)
    onCommit(latest.current)
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        tabIndex={0}
        title={title}
        className={cn(
          "absolute inset-y-0 z-20 hidden w-2 cursor-col-resize touch-none outline-none md:block",
          edge === "right"
            ? inside
              ? "right-0"
              : "right-0 translate-x-1/2"
            : inside
              ? "left-0"
              : "left-0 -translate-x-1/2",
          // The line shows on hover, focus and while dragging, on the panel's border.
          "after:absolute after:inset-y-0 after:w-0.5 after:bg-ring after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100",
          inside ? (edge === "right" ? "after:right-0" : "after:left-0") : "after:left-1/2 after:-translate-x-1/2",
          dragging && "after:opacity-100",
          className
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          start.current = { x: e.clientX, width }
          latest.current = width
          setResizing(true)
        }}
        onPointerMove={(e) => {
          const s = start.current
          if (!s) return
          latest.current = Math.min(max, Math.max(min, s.width + sign * (e.clientX - s.x)))
          onPreview(latest.current)
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16
          if (e.key === "ArrowLeft") onCommit(width - sign * step)
          else if (e.key === "ArrowRight") onCommit(width + sign * step)
          else if (e.key === "Home") onReset()
          else return
          e.preventDefault()
        }}
      />
      {/* While dragging, the page under the pointer neither selects text nor reacts to hover. */}
      {dragging && <div aria-hidden className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  )
}
