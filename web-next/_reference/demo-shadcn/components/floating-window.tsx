"use client"

import * as React from "react"
import { PanelBottomClose } from "lucide-react"

import { cn } from "@/lib/utils"

type FloatingWindowProps = {
  title: string
  subtitle?: string
  onClose: () => void
  onDock: () => void
  children: React.ReactNode
  initial?: { x: number; y: number; w: number; h: number }
  className?: string
}

export function FloatingWindow({
  title,
  subtitle,
  onClose,
  onDock,
  children,
  initial,
  className,
}: FloatingWindowProps) {
  const [pos, setPos] = React.useState(() => ({
    x: initial?.x ?? 220,
    y: initial?.y ?? 120,
    w: initial?.w ?? 720,
    h: initial?.h ?? 520,
  }))
  const drag = React.useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setPos((p) => ({
      ...p,
      x: Math.max(8, Math.min(window.innerWidth - 120, e.clientX - drag.current!.dx)),
      y: Math.max(8, Math.min(window.innerHeight - 60, e.clientY - drag.current!.dy)),
    }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  return (
    <div
      className={cn(
        "pointer-events-auto fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl",
        className,
      )}
      style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}
      role="dialog"
      aria-label={title}
    >
      <div
        className="flex h-10 shrink-0 cursor-grab touch-none items-center gap-3 border-b border-border bg-muted/40 px-3 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="关闭窗口"
            onClick={onClose}
            className="size-3 rounded-full bg-[#ff5f57] transition-opacity hover:opacity-80"
          />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <button
            type="button"
            aria-label="停靠回面板"
            onClick={onDock}
            className="size-3 rounded-full bg-[#28c840] transition-opacity hover:opacity-80"
          />
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-xs">
          <span className="truncate font-medium">{title}</span>
          {subtitle ? <span className="truncate text-muted-foreground">{subtitle}</span> : null}
        </div>
        <button
          type="button"
          onClick={onDock}
          aria-label="停靠回面板"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelBottomClose className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
