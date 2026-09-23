"use client"

import type * as React from "react"
import { cn } from "@/lib/utils"

const HEADER_BLUR_LAYERS = buildBlurGradientLayers({
  height: 56,
  layerCount: 9,
  maxBlur: 10,
  minBlur: 0,
  overlap: 8,
  gamma: 1.85,
})

type BlurLayerStyle = React.CSSProperties & {
  WebkitBackdropFilter?: string
  WebkitMaskImage?: string
}

// Shared chrome for session and tool headers; each caller supplies its own content.
export function WorkspaceHeader({
  children,
  overlay = false,
}: {
  children: React.ReactNode
  overlay?: boolean
}) {
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        "pointer-events-none z-10 h-14 shrink-0 overflow-hidden",
        overlay ? "absolute inset-x-0 top-0" : "relative",
      )}
    >
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-background/80 to-background/0" />
      {HEADER_BLUR_LAYERS.map((layer) => (
        <div aria-hidden="true" key={layer.key} className={layer.className} style={layer.style} />
      ))}
      <div className="pointer-events-auto relative flex h-14 items-center gap-3 px-3">
        {children}
      </div>
    </header>
  )
}

function buildBlurGradientLayers({
  height,
  layerCount,
  maxBlur,
  minBlur,
  overlap,
  gamma,
}: {
  height: number
  layerCount: number
  maxBlur: number
  minBlur: number
  overlap: number
  gamma: number
}) {
  const step = height / layerCount
  return Array.from({ length: layerCount }, (_, index) => {
    const start = Math.max(0, Math.round(index * step - overlap * 0.5))
    const end = Math.min(height, Math.round((index + 1) * step + overlap))
    const progress = index / Math.max(1, layerCount - 1)
    const blur = minBlur + (maxBlur - minBlur) * Math.pow(1 - progress, gamma)
    const fadeIn = index === 0 ? 0 : 26
    const fadeOut = index === layerCount - 1 ? 72 : 76
    const mask =
      index === 0
        ? `linear-gradient(to bottom, black 0%, black ${fadeOut}%, transparent 100%)`
        : `linear-gradient(to bottom, transparent 0%, black ${fadeIn}%, black ${fadeOut}%, transparent 100%)`

    return {
      key: `${index}-${start}-${end}-${blur.toFixed(2)}`,
      className: "absolute inset-x-0",
      style: {
        top: `${start}px`,
        height: `${Math.max(1, end - start)}px`,
        backdropFilter: `blur(${blur.toFixed(2)}px)`,
        WebkitBackdropFilter: `blur(${blur.toFixed(2)}px)`,
        maskImage: mask,
        WebkitMaskImage: mask,
      } satisfies BlurLayerStyle,
    }
  })
}

