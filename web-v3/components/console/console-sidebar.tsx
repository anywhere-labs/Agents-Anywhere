"use client"

import { Check, ChevronsUpDown, LogOut, UserPlus } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { isActivePath, type NavGroup } from "@/components/console/nav"
import { PageTransition } from "@/components/console/page-transition"
import {
  SectionSwitcher,
  type SectionDestination,
} from "@/components/console/section-switcher"
import { UserAvatar } from "@/components/console/user-avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export interface SwitchableAccount {
  user: {
    id: string
    display_name?: string | null
    email?: string | null
    avatar?: string | null
  }
  active: boolean
}

export interface AccountSwitcherLabels {
  triggerAria?: string
  accountsHeading?: string
  addAccount?: string
  signOut?: string
  signOutAll?: string
}

/**
 * Reusable console sidebar: top hover-free wordmark switcher, grouped pill
 * navigation with `<ViewTransition>` section keys, and a footer slot (typically
 * `AccountSwitcher`).
 */
export function ConsoleSidebar({
  sectionKey,
  brandName,
  badge,
  home,
  homeLabel,
  switchLabel,
  destinations,
  nav,
  footer,
}: {
  sectionKey: string
  brandName?: string
  badge?: string
  home: string
  homeLabel?: string
  switchLabel?: string
  destinations?: readonly SectionDestination[]
  nav: readonly NavGroup[]
  footer?: React.ReactNode
}) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()

  const closeDrawerOnLink = (event: React.MouseEvent) => {
    if (isMobile && (event.target as Element).closest("a")) {
      setOpenMobile(false)
    }
  }

  return (
    <Sidebar>
      <div className="contents" onClickCapture={closeDrawerOnLink}>
        <SidebarHeader className="px-3 pt-4">
          <SectionSwitcher
            homeHref={home}
            homeLabel={homeLabel}
            brandName={brandName}
            badge={badge}
            destinations={destinations}
            switchLabel={switchLabel}
          />
        </SidebarHeader>

        <SidebarContent className="px-1">
          <PageTransition key={sectionKey}>
            <div className="flex flex-col">
              {nav.map((group, index) => (
                <SidebarGroup key={group.label ?? index}>
                  {group.label && (
                    <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                  )}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => (
                        <SidebarMenuItem key={item.href}>
                          <SidebarMenuButton
                            render={<Link href={item.href} />}
                            isActive={isActivePath(pathname, item.href, home)}
                          >
                            <item.icon />
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </div>
          </PageTransition>
        </SidebarContent>

        {footer && <SidebarFooter className="px-3 pb-4">{footer}</SidebarFooter>}
      </div>
    </Sidebar>
  )
}

/**
 * Footer account pill opening a floating multi-account switcher (`side="top"`):
 * switch between signed-in accounts, add another account, or sign out.
 */
export function AccountSwitcher({
  accounts,
  pending = false,
  onSwitch,
  onAddAccount,
  onSignOut,
  onSignOutAll,
  labels,
}: {
  accounts: readonly SwitchableAccount[]
  pending?: boolean
  onSwitch?: (userId: string) => void
  onAddAccount?: () => void
  onSignOut?: () => void
  onSignOutAll?: () => void
  labels?: AccountSwitcherLabels
}) {
  const active = accounts.find((entry) => entry.active) ?? accounts[0]
  const user = active?.user

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="lg" className="h-10 px-2.5" />}
        aria-label={labels?.triggerAria ?? "Switch account"}
      >
        <UserAvatar user={user} className="size-6 text-[10px]" />
        <span className="min-w-0 flex-1 truncate text-left font-medium">
          {user?.display_name || user?.email}
        </span>
        <ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{labels?.accountsHeading ?? "Accounts"}</DropdownMenuLabel>
          {accounts.map((entry) => (
            <DropdownMenuItem
              key={entry.user.id}
              disabled={pending}
              className="rounded-2xl px-2.5 py-2"
              onClick={() => {
                if (entry.active) return
                onSwitch?.(entry.user.id)
              }}
            >
              <UserAvatar user={entry.user} className="size-7 text-xs" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {entry.user.display_name || entry.user.email}
                </span>
                {entry.user.email && (
                  <span className="truncate text-xs text-muted-foreground">
                    {entry.user.email}
                  </span>
                )}
              </div>
              {entry.active && <Check className="ml-auto size-4 shrink-0 text-foreground" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {(onAddAccount || onSignOut || (accounts.length > 1 && onSignOutAll)) && (
          <DropdownMenuSeparator />
        )}
        {onAddAccount && (
          <DropdownMenuItem disabled={pending} onClick={onAddAccount}>
            <UserPlus />
            <span>{labels?.addAccount ?? "Add account"}</span>
          </DropdownMenuItem>
        )}
        {onSignOut && (
          <DropdownMenuItem disabled={pending} onClick={onSignOut}>
            <LogOut />
            <span>{labels?.signOut ?? "Sign out"}</span>
          </DropdownMenuItem>
        )}
        {accounts.length > 1 && onSignOutAll && (
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onClick={onSignOutAll}
          >
            <LogOut />
            <span>{labels?.signOutAll ?? "Sign out of all accounts"}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
