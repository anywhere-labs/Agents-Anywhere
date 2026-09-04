"use client"

import * as React from "react"
import {
  Download,
  LayoutDashboard,
  LogOut,
  Server,
  Settings,
  Users,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarFooter } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { WorkspaceState } from "@/components/workspace-context"
import type { AuthMe } from "@/features/auth/types"
import { useDesktopUpdate } from "@/features/desktop/desktop-update-context"
import { useTranslations } from "next-intl"

type SidebarAccountFooterProps = {
  me: AuthMe | null
  navigate: WorkspaceState["navigate"]
  signOut: () => void
}

export function SidebarAccountFooter({
  me,
  navigate,
  signOut,
}: SidebarAccountFooterProps) {
  const t = useTranslations("dashboard")
  const tCommon = useTranslations("common")
  const [signOutOpen, setSignOutOpen] = React.useState(false)
  const { state: updateState, showDeferredUpdate } = useDesktopUpdate()
  const userId = me?.userId ?? "Unknown"
  const userRole = me?.role ? me.role.replace(/^\w/, (char) => char.toUpperCase()) : ""
  const userInitials = userId.slice(0, 2).toUpperCase()
  const isAdmin = me?.role === "admin"
  const showUpdateHint = updateState?.phase === "deferred" && Boolean(updateState.release)

  return (
    <>
      <SidebarFooter className="px-3 py-3">
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-sidebar-accent"
              >
                <Avatar className="size-9 rounded-full">
                  {me?.avatar && <AvatarImage src={me.avatar} alt={userId} />}
                  <AvatarFallback className="rounded-full bg-primary text-primary-foreground">{userInitials}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col leading-tight text-left">
                  <span className="truncate text-sm font-medium">{userId}</span>
                  <span className="truncate text-xs text-muted-foreground">{userRole}</span>
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
              {isAdmin ? (
                <>
                  <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("dashboard")}>
                    <LayoutDashboard className="size-4 text-muted-foreground" />
                    {t("nav.dashboard")}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("team")}>
                    <Users className="size-4 text-muted-foreground" />
                    {t("nav.team")}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-3 py-2.5" onClick={() => navigate("service")}>
                    <Server className="size-4 text-muted-foreground" />
                    {t("nav.service")}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-3 py-2.5" onClick={() => setSignOutOpen(true)}>
                <LogOut className="size-4 text-muted-foreground" />
                {t("actions.signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {showUpdateHint ? (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="relative shrink-0"
                    aria-label={t("updates.available")}
                    onClick={showDeferredUpdate}
                  >
                    <Download />
                    <span
                      aria-hidden="true"
                      className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive"
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t("updates.available")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
      </SidebarFooter>

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
    </>
  )
}
