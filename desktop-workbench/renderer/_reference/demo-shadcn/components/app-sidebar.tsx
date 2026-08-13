"use client"

import * as React from "react"
import { Search, PanelLeft, Plus, Settings, Users, Server, LogOut, Pin, Archive } from "lucide-react"
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
  useSidebar,
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
import { cn } from "@/lib/utils"
import { filterSessions } from "@/lib/api"
import { useWorkspace } from "@/components/workspace-context"
import { SessionFilterMenu } from "@/components/session-filter-menu"
import { useAuth } from "@/components/auth/auth-context"

export function AppSidebar() {
  const { toggleSidebar } = useSidebar()
  const {
    connectors,
    sessions,
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
  const { signOut } = useAuth()
  const [signOutOpen, setSignOutOpen] = React.useState(false)
  const [pairOpen, setPairOpen] = React.useState(false)

  const inSession = page === "session"

  const filtered = filterSessions(
    sessions.filter((s) => !s.archived),
    filter,
    search,
  )

  return (
    <Sidebar className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <button type="button" onClick={goHome} className="font-serif text-xl italic tracking-tight">
            Agents Anywhere
          </button>
          <div className="flex items-center gap-1 text-muted-foreground">
            <button
              type="button"
              aria-label="搜索"
              className="rounded-md p-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Search className="size-4" />
            </button>
            {!inSession && (
              <button
                type="button"
                aria-label="收起侧边栏"
                onClick={toggleSidebar}
                className="rounded-md p-1.5 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <PanelLeft className="size-4" />
              </button>
            )}
          </div>
        </div>

        <SidebarMenu className="mt-3">
          <SidebarMenuItem>
            <SidebarMenuButton className="h-10 font-medium" onClick={goHome}>
              <Plus className="size-4" />
              <span>New session</span>
              <Kbd className="ml-auto">⌘N</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-2">
        {/* Devices section */}
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between pr-1">
            <span>Devices</span>
            <button
              type="button"
              aria-label="配对新设备"
              onClick={() => setPairOpen(true)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {connectors.map((connector) => (
                <SidebarMenuItem key={connector.id}>
                  <SidebarMenuButton
                    className="font-mono text-[13px]"
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
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Sessions section */}
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-1">
            <span>Recents</span>
            <SessionFilterMenu />
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">没有匹配的会话</p>
              ) : (
                filtered.map((item) => (
                  <SidebarMenuItem key={item.id} className="group/session">
                    <SidebarMenuButton
                      isActive={page === "session" && activeSessionId === item.id}
                      onClick={() => openSession(item.id)}
                      className="text-muted-foreground data-[active=true]:text-foreground"
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full border",
                          item.status === "running"
                            ? "border-emerald-500 bg-emerald-500"
                            : item.status === "error"
                              ? "border-red-500/70"
                              : item.status === "waiting_approval"
                                ? "border-amber-400/70"
                                : "border-muted-foreground/50",
                        )}
                      />
                      <span className="truncate">{item.title}</span>
                      {item.unread && (
                        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
                      )}
                    </SidebarMenuButton>

                    {/* Hover actions */}
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden items-center gap-0.5 group-hover/session:flex">
                      <button
                        type="button"
                        aria-label={item.pinned ? "取消置顶" : "置顶"}
                        onClick={(e) => {
                          e.stopPropagation()
                          togglePinSession(item.id)
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
                        aria-label="归档"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleArchiveSession(item.id)
                        }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                      >
                        <Archive className="size-3" />
                      </button>
                    </div>
                  </SidebarMenuItem>
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
              <Avatar className="size-9 rounded-md">
                <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
                <AvatarFallback className="rounded-md bg-primary text-primary-foreground">T4</AvatarFallback>
              </Avatar>
              <div className="flex flex-col leading-tight text-left">
                <span className="text-sm font-medium">t4wefan</span>
                <span className="text-xs text-muted-foreground">Admin</span>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64 p-1">
            <div className="flex items-center gap-3 px-2 py-3">
              <Avatar className="size-12 rounded-md">
                <AvatarImage src="/abstract-pixelated-avatar.png" alt="t4wefan" />
                <AvatarFallback className="rounded-md bg-primary text-primary-foreground">T4</AvatarFallback>
              </Avatar>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold">t4wefan</span>
                <span className="text-xs text-muted-foreground">Admin</span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("settings", "account")}>
              <Settings className="size-4 text-muted-foreground" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("team")}>
              <Users className="size-4 text-muted-foreground" />
              Team
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("service")}>
              <Server className="size-4 text-muted-foreground" />
              Service
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-3 py-2.5" onClick={() => setSignOutOpen(true)}>
              <LogOut className="size-4 text-muted-foreground" />
              Sign out
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
            <DialogTitle>Sign out</DialogTitle>
            <DialogDescription>
              Are you sure you want to sign out of your account?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setSignOutOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setSignOutOpen(false)
                signOut()
              }}
            >
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}
