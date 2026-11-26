"use client"

import { ChevronDown, type LucideIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"

import { BrandWordmark } from "@/components/brand-wordmark"
import {
  ForwardIndicator,
  NAV_FORWARD,
  NAV_STILL,
  sectionTransitionTypes,
} from "@/components/console/page-transition"
import { useSidebar } from "@/components/ui/sidebar"

export interface SectionDestination {
  href: string
  title: string
  icon: LucideIcon
}

/**
 * The sidebar's top row: brand wordmark + optional section badge (e.g.
 * "Admin"). Hovering never paints a selected pill background — only clicking
 * opens the floating switcher card when `destinations` is non-empty.
 */
export function SectionSwitcher({
  homeHref,
  homeLabel = "Home",
  brandName,
  badge,
  destinations = [],
  switchLabel = "Switch console",
  children,
}: {
  homeHref: string
  homeLabel?: string
  brandName?: string
  badge?: string
  destinations?: readonly SectionDestination[]
  switchLabel?: string
  children?: React.ReactNode
}) {
  const pathname = usePathname()
  const { isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const cardId = useId()
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  const slideTo = (href: string) =>
    isMobile ? [NAV_STILL] : sectionTransitionTypes(pathname, href)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    return () => document.removeEventListener("pointerdown", closeOutside)
  }, [open])

  const brand = (
    <>
      <BrandWordmark size="sm" name={brandName} />
      {badge && (
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {badge}
        </span>
      )}
    </>
  )

  if (destinations.length === 0) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 pl-3">
        <Link
          href={homeHref}
          transitionTypes={slideTo(homeHref)}
          aria-label={homeLabel}
          className="flex min-w-0 items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          {brand}
        </Link>
        {children}
      </div>
    )
  }

  return (
    <div
      ref={root}
      data-open={open || undefined}
      className="group/switch relative z-30 flex h-9 items-center gap-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return
        event.stopPropagation()
        setOpen(false)
        toggle.current?.focus()
      }}
    >
      <button
        ref={toggle}
        type="button"
        aria-label={switchLabel}
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setOpen(!open)}
        className="flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-full pr-2 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        {brand}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-open/switch:rotate-180 group-data-open/switch:text-foreground motion-reduce:transition-none" />
      </button>
      <nav
        id={cardId}
        aria-label={switchLabel}
        inert={!open}
        className={
          destinations.length === 1
            ? "invisible absolute inset-x-0 top-full mt-1.5 flex -translate-y-1 flex-col gap-0.5 rounded-full bg-popover p-1 text-popover-foreground opacity-0 shadow-2xl ring-1 ring-foreground/5 transition-[opacity,translate,visibility] duration-150 group-data-open/switch:visible group-data-open/switch:translate-y-0 group-data-open/switch:opacity-100 motion-reduce:transition-none dark:ring-foreground/10"
            : "invisible absolute inset-x-0 top-full mt-1.5 flex -translate-y-1 flex-col gap-0.5 rounded-3xl bg-popover p-1.5 text-popover-foreground opacity-0 shadow-2xl ring-1 ring-foreground/5 transition-[opacity,translate,visibility] duration-150 group-data-open/switch:visible group-data-open/switch:translate-y-0 group-data-open/switch:opacity-100 motion-reduce:transition-none dark:ring-foreground/10"
        }
      >
        {destinations.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            transitionTypes={slideTo(destination.href)}
            className="flex items-center gap-2.5 rounded-full px-3.5 py-2 text-sm outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <destination.icon />
            <span className="min-w-0 truncate">{destination.title}</span>
            {sectionTransitionTypes(pathname, destination.href)[0] === NAV_FORWARD && (
              <ForwardIndicator />
            )}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center">{children}</div>
    </div>
  )
}
