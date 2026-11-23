"use client"

import { AGENTS_ANYWHERE_WORDMARK } from "@/components/brand-wordmark-path"
import { cn } from "@/lib/utils"

export const DEFAULT_BRAND_NAME = "Agents Anywhere"

const sizes = {
  sm: "text-xl",
  default: "text-2xl",
  lg: "text-5xl",
}

/**
 * The product's brand mark: "Agents Anywhere" renders from pre-shaped Caveat
 * 500 SVG outlines; any custom `name` falls back to `@fontsource/caveat`
 * script typography (`font-script`).
 */
export function BrandWordmark({
  size = "default",
  name = DEFAULT_BRAND_NAME,
  className,
}: {
  size?: keyof typeof sizes
  name?: string
  className?: string
}) {
  if (name.trim().toLowerCase() === "agents anywhere") {
    const { unitsPerEm, top, advance, path } = AGENTS_ANYWHERE_WORDMARK
    return (
      <svg
        role="img"
        aria-label={name}
        viewBox={`0 ${-top} ${advance} ${top}`}
        overflow="visible"
        className={cn(
          "inline-block shrink-0 fill-current align-baseline",
          sizes[size],
          className
        )}
        style={{
          width: `${advance / unitsPerEm}em`,
          height: `${top / unitsPerEm}em`,
        }}
      >
        <path d={path} />
      </svg>
    )
  }

  return (
    <span
      className={cn(
        "inline-block shrink-0 font-script leading-none font-medium tracking-normal whitespace-nowrap",
        sizes[size],
        className
      )}
    >
      {name}
    </span>
  )
}
