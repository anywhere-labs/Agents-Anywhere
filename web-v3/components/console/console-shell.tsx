"use client"

import { usePathname } from "next/navigation"

import { CollapsedNavBar } from "@/components/console/collapsed-nav-bar"
import { ConsoleSidebar } from "@/components/console/console-sidebar"
import type { NavGroup } from "@/components/console/nav"
import { PageTransition } from "@/components/console/page-transition"
import type { SectionDestination } from "@/components/console/section-switcher"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

/**
 * The complete console shell: `<ViewTransition>` entrance (`console-enter`),
 * collapsible sidebar, mobile `CollapsedNavBar`, optional top banner slot,
 * and a per-route `page-rise` content stage.
 */
export function ConsoleShell({
  sectionKey,
  brandName,
  badge,
  home,
  homeLabel,
  openNavigationLabel,
  switchLabel,
  destinations,
  nav,
  footer,
  banner,
  children,
}: {
  sectionKey: string
  brandName?: string
  badge?: string
  home: string
  homeLabel?: string
  openNavigationLabel?: string
  switchLabel?: string
  destinations?: readonly SectionDestination[]
  nav: readonly NavGroup[]
  footer?: React.ReactNode
  banner?: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <PageTransition arrival="enter">
      <SidebarProvider>
        <ConsoleSidebar
          sectionKey={sectionKey}
          brandName={brandName}
          badge={badge}
          home={home}
          homeLabel={homeLabel}
          switchLabel={switchLabel}
          destinations={destinations}
          nav={nav}
          footer={footer}
        />
        <SidebarInset className="min-w-0">
          <CollapsedNavBar
            brandName={brandName}
            openLabel={openNavigationLabel}
          />
          {banner}
          <div className="min-w-0 flex-1">
            <PageTransition key={pathname} arrival="rise">
              {children}
            </PageTransition>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </PageTransition>
  )
}
