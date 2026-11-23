"use client"

import { cn } from "@/lib/utils"

export const DEFAULT_BRAND_NAME = "Agents Anywhere"

const sizes = {
  sm: "text-sm",
  default: "text-base",
  lg: "text-4xl",
}

/**
 * The product's name as the app chrome shows it: the interface's own sans (HarmonyOS Sans SC / SF Pro), semibold and
 * slightly tightened, so it sits with the rest of the type instead of standing apart in a script face.
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
  return (
    <span
      className={cn(
        "inline-block shrink-0 font-heading leading-none font-semibold tracking-tight whitespace-nowrap",
        sizes[size],
        className
      )}
    >
      {name}
    </span>
  )
}
