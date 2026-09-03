"use client"

import * as React from "react"
import {
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
import type { WorkspaceState } from "@/components/workspace-context"
import type { AuthMe } from "@/features/auth/types"
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
  const userId = me?.userId ?? "Unknown"
  const userRole = me?.role ? me.role.replace(/^\w/, (char) => char.toUpperCase()) : ""
  const userInitials = userId.slice(0, 2).toUpperCase()
  const isAdmin = me?.role === "admin"

  return (
    <>
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
