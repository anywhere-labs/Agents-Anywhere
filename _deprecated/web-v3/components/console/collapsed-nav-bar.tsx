"use client"

import { PanelLeftIcon } from "lucide-react"

import { BrandWordmark } from "@/components/brand-wordmark"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"

/**
 * The top bar shown on narrow screens while the sidebar is folded away.
 * The sidebar trigger is its own standalone ghost icon button; the brand
 * wordmark sits beside it with no hover or selected highlight.
 */
export function CollapsedNavBar({
  brand,
  brandName,
  openLabel = "Open navigation",
}: {
  brand?: React.ReactNode
  brandName?: string
  openLabel?: string
}) {
  const { toggleSidebar } = useSidebar()

  return (
    <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
      <Button
        variant="ghost"
        size="icon-sm"
        data-sidebar="trigger"
        aria-label={openLabel}
        onClick={toggleSidebar}
      >
        <PanelLeftIcon />
      </Button>
      {brand ?? <BrandWordmark size="sm" name={brandName} />}
    </header>
  )
}
