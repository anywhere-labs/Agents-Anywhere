"use client"

import { ArrowLeft, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { useAuth } from "@/components/auth/auth-context"
import { SidebarAccountFooter } from "@/components/sidebar/sidebar-account-footer"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useWorkspace } from "@/components/workspace-context"

export type SectionNavigationItem<Id extends string = string> = {
  id: Id
  label: string
  icon: LucideIcon
}

export type SectionNavigationGroup<Id extends string = string> = {
  id: string
  label?: string
  items: readonly SectionNavigationItem<Id>[]
}

/**
 * Sidebar for pages that live outside the workspace (administration, personal
 * settings): a way back home, the page's own sections, and the account menu.
 * It occupies the same slot as the workspace sidebar, so the mobile drawer and
 * the desktop resizable panel keep working unchanged.
 */
export function WorkspaceSectionSidebar<Id extends string>({
  contained = false,
  title,
  groups,
  activeId,
  onNavigate,
}: {
  contained?: boolean
  title: string
  groups: readonly SectionNavigationGroup<Id>[]
  activeId: Id
  onNavigate: (id: Id) => void
}) {
  const tCommon = useTranslations("common")
  const { me, signOut } = useAuth()
  const { navigate, goHome } = useWorkspace()
  const { setOpenMobile } = useSidebar()

  return (
    <Sidebar contained={contained} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pb-2 pt-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-10 font-medium"
              onClick={() => {
                goHome()
                setOpenMobile(false)
              }}
            >
              <ArrowLeft />
              <span>{tCommon("backHome")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p className="mt-3 px-2 text-sm font-semibold">{title}</p>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {groups.map((group) => (
          <SidebarGroup key={group.id}>
            {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon
                  const active = item.id === activeId
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active}
                        aria-current={active ? "page" : undefined}
                        onClick={() => {
                          onNavigate(item.id)
                          setOpenMobile(false)
                        }}
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarAccountFooter me={me} navigate={navigate} signOut={signOut} />
    </Sidebar>
  )
}
