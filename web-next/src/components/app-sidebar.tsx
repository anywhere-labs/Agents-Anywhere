"use client"

import * as React from "react"
import { Search, Plus, Settings, Users, Server, LogOut, Pin, Archive, CheckCheck } from "lucide-react"
import { PairDeviceDialog } from "@/components/pair-device-dialog"

import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { filterSessions } from "@/lib/demo-api"
import { useWorkspace } from "@/components/workspace-context"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { useAuth } from "@/components/auth/auth-context"
import { dashboardApi } from "@/features/dashboard/api"
import { useTranslations } from "next-intl"

export function AppSidebar({ contained = false }: { contained?: boolean }) {
  const {
    connectors,
    sessions,
    isLoading,
    activeSessionId,
    activeConnectorId,
    page,
    filter,
    search,
    openSession,
    goHome,
    navigate,
    navigateToDevice,
    togglePinSession,
    toggleArchiveSession,
    refreshData,
  } = useWorkspace()
  const { signOut, me, session: authSession } = useAuth()
  const t = useTranslations("dashboard")
  const tCommon = useTranslations("common")
  const [signOutOpen, setSignOutOpen] = React.useState(false)
  const [pairOpen, setPairOpen] = React.useState(false)

  const userId = me?.userId ?? "Unknown"
  const userRole = me?.role ? me.role.replace(/^\w/, (char) => char.toUpperCase()) : ""
  const userInitials = userId.slice(0, 2).toUpperCase()

  const pinnedSessions = React.useMemo(
    () => sessions.filter((session) => session.pinned && !session.archived),
    [sessions],
  )

  const markAllRead = React.useCallback(async () => {
    if (!authSession?.accessToken) return
    const unreadIds = sessions.filter((s) => s.unread).map((s) => s.id)
    if (unreadIds.length === 0) return
    await dashboardApi.bulkMarkSessionsRead(authSession.accessToken, unreadIds)
    refreshData()
  }, [authSession?.accessToken, refreshData, sessions])


  const filtered = filterSessions(
    sessions.filter((s) => !s.archived),
    filter,
    search,
  ).filter((session) => !session.pinned)

  return (
    <Sidebar contained={contained} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <button type="button" onClick={goHome} className="font-brand text-xl font-medium tracking-tight">
            Agents Anywhere
          </button>
          <div className="flex items-center gap-1 text-muted-foreground">
            <button
              type="button"
              aria-label={t("actions.search")}
              className="rounded-md p-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Search className="size-4" />
            </button>
          </div>
        </div>

        <SidebarMenu className="mt-3">
          <SidebarMenuItem>
            <SidebarMenuButton className="h-10 font-medium" onClick={goHome}>
              <Plus className="size-4" />
              <span>{t("actions.newSession")}</span>
              <Kbd className="ml-auto">⌘N</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {/* Devices section */}
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between pr-1" role="heading" aria-level={2}>
            <span>{t("sections.devices")}</span>
            <button
              type="button"
              aria-label={t("actions.pairDevice")}
              onClick={() => setPairOpen(true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingDevices")} />
              ) : connectors.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noDevicesShort")}</p>
              ) : (
                connectors.map((connector) => (
                  <SidebarMenuItem key={connector.id}>
                    <SidebarMenuButton
                      className="code-mono text-[13px]"
                      isActive={
                        (page === "device" || page === "device-workspace") &&
                        activeConnectorId === connector.id
                      }
                      onClick={() => navigateToDevice(connector.id)}
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          connector.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/40",
                        )}
                      />
                      <span className={cn(connector.status === "offline" && "text-muted-foreground")}>
                        {connector.name}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Pinned section */}
        {!isLoading && pinnedSessions.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel role="heading" aria-level={2}>{t("sections.pinned")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinnedSessions.map((item) => (
                  <SessionSidebarItem
                    key={item.id}
                    item={item}
                    isActive={page === "session" && activeSessionId === item.id}
                    onOpen={() => openSession(item.id)}
                    onTogglePin={() => togglePinSession(item.id)}
                    onToggleArchive={() => toggleArchiveSession(item.id)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        {/* Sessions section */}
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-1" role="heading" aria-level={2}>
            <span>{t("sections.recents")}</span>
            <SessionFilterMenu />
            <button
              type="button"
              aria-label={t("actions.markAllRead")}
              onClick={() => void markAllRead()}
              className="rounded-md p-0.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <CheckCheck className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                <SidebarLoadingItem label={t("status.loadingSessions")} />
              ) : filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t("empty.noSessionsMatch")}</p>
              ) : (
                filtered.map((item) => (
                  <SessionSidebarItem
                    key={item.id}
                    item={item}
                    isActive={page === "session" && activeSessionId === item.id}
                    onOpen={() => openSession(item.id)}
                    onTogglePin={() => togglePinSession(item.id)}
                    onToggleArchive={() => toggleArchiveSession(item.id)}
                  />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-sidebar-accent"
            >
              <Avatar className="size-9 rounded-full">
                {me?.avatar && <AvatarImage src={me.avatar} alt={userId} />}
                <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{userInitials}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col leading-tight text-left">
                <span className="text-sm font-medium">{userId}</span>
                <span className="text-xs text-muted-foreground">{userRole}</span>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64 p-1">
            <div className="flex items-center gap-3 px-2 py-3">
              <Avatar className="size-12 rounded-full">
                {me?.avatar && <AvatarImage src={me.avatar} alt={userId} />}
                <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{userInitials}</AvatarFallback>
              </Avatar>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold">{userId}</span>
                <span className="text-xs text-muted-foreground">{userRole}</span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("settings", "account")}>
              <Settings className="size-4 text-muted-foreground" />
              {t("nav.settings")}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("team")}>
              <Users className="size-4 text-muted-foreground" />
              {t("nav.team")}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("service")}>
              <Server className="size-4 text-muted-foreground" />
              {t("nav.service")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => setSignOutOpen(true)}>
              <LogOut className="size-4 text-muted-foreground" />
              {t("actions.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        onConnectorCreated={() => {
          refreshData()
        }}
      />

      <Dialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("signOut.title")}</DialogTitle>
            <DialogDescription>
              {t("signOut.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setSignOutOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setSignOutOpen(false)
                signOut()
              }}
            >
              {t("actions.signOut")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}

function SessionSidebarItem({
  item,
  isActive,
  onOpen,
  onTogglePin,
  onToggleArchive,
}: {
  item: { id: string; title?: string | null; status: string; unread: boolean; pinned: boolean }
  isActive: boolean
  onOpen: () => void
  onTogglePin: () => void
  onToggleArchive: () => void
}) {
  const t = useTranslations("dashboard")
  return (
    <SidebarMenuItem className="group/session">
      <SidebarMenuButton
        isActive={isActive}
        onClick={onOpen}
        className="text-muted-foreground data-[active=true]:text-foreground"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full border",
            item.unread
              ? "border-primary bg-primary"
              : item.status === "running"
              ? "border-emerald-500 bg-emerald-500"
              : item.status === "error"
                ? "border-red-500/70"
                : item.status === "waiting_approval"
                  ? "border-amber-400/70"
                  : "border-muted-foreground/50",
          )}
        />
        <span className="truncate">{item.title}</span>
      </SidebarMenuButton>

      <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden items-center gap-0.5 group-hover/session:flex">
        <button
          type="button"
          aria-label={item.pinned ? t("actions.unpin") : t("actions.pin")}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          className={cn(
            "rounded p-1 transition-colors hover:bg-sidebar-accent",
            item.pinned ? "text-primary" : "text-muted-foreground",
          )}
        >
          <Pin className="size-3" />
        </button>
        <button
          type="button"
          aria-label={t("actions.archive")}
          onClick={(e) => {
            e.stopPropagation()
            onToggleArchive()
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
        >
          <Archive className="size-3" />
        </button>
      </div>
    </SidebarMenuItem>
  )
}

function SidebarLoadingItem({ label }: { label: string }) {
  return (
    <SidebarMenuItem>
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{label}</span>
      </div>
    </SidebarMenuItem>
  )
}
