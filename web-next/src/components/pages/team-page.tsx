"use client"

import { useState, useEffect } from "react"
import { ChevronLeft, Plus, Search, Pencil, Ban, ArrowDown, Trash2, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { LoadingState } from "@/components/loading-state"
import { useAuth } from "@/components/auth/auth-context"
import { authApi } from "@/features/auth/api"
import type { AdminUser } from "@/features/auth/types"
import { useTranslations } from "next-intl"

type FilterTab = "all" | "admins" | "members"

function StatusDot({ disabled }: { disabled: boolean }) {
  return (
    <span
      className={cn(
        "mr-1.5 inline-block size-1.5 rounded-full",
        !disabled ? "bg-emerald-500" : "bg-muted-foreground/40",
      )}
    />
  )
}

function RoleDot({ role }: { role: AdminUser["role"] }) {
  return (
    <span
      className={cn(
        "mr-1.5 inline-block size-1.5 rounded-full",
        role === "admin" ? "bg-blue-400" : "bg-muted-foreground/50",
      )}
    />
  )
}

function formatDate(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

function UserContextMenu({
  user,
  isYou,
  onToggleDisable,
  onToggleRole,
  onDelete,
}: {
  user: AdminUser
  isYou: boolean
  onToggleDisable: () => void
  onToggleRole: () => void
  onDelete: () => void
}) {
  const t = useTranslations("pages.team")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 opacity-0 group-hover/row:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem className="gap-2.5" disabled>
          <Pencil className="size-4 text-muted-foreground" />
          {t("editUser")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onClick={onToggleDisable} disabled={isYou}>
          <Ban className="size-4 text-muted-foreground" />
          {user.disabled ? t("enable") : t("disable")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onClick={onToggleRole} disabled={isYou}>
          <ArrowDown className="size-4 text-muted-foreground" />
          {user.role === "admin" ? t("demote") : t("promote")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2.5 text-destructive focus:text-destructive"
          onClick={onDelete}
          disabled={isYou}
        >
          <Trash2 className="size-4" />
          {t("deleteUser")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TeamPage() {
  const { navigate } = useWorkspace()
  const { session, me } = useAuth()
  const t = useTranslations("pages.team")
  const tCommon = useTranslations("common")
  const [users, setUsers] = useState<AdminUser[]>([])
  const [filterTab, setFilterTab] = useState<FilterTab>("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!session?.accessToken) {
      setUsers([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    authApi
      .listUsers(session.accessToken)
      .then((res) => {
        if (!cancelled) setUsers(res.users)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("loadFailed"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [session?.accessToken, t])

  const filtered = users.filter((u) => {
    if (filterTab === "admins" && u.role !== "admin") return false
    if (filterTab === "members" && u.role !== "member") return false
    if (search && !u.userId.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const counts = {
    all: users.length,
    admins: users.filter((u) => u.role === "admin").length,
    members: users.filter((u) => u.role === "member").length,
  }

  const tabItems: { id: FilterTab; label: string }[] = [
    { id: "all", label: t("all") },
    { id: "admins", label: t("admins") },
    { id: "members", label: t("members") },
  ]

  const handleToggleDisable = async (user: AdminUser) => {
    if (!session?.accessToken) return
    const updated = await authApi.updateUser(session.accessToken, user.userId, { disabled: !user.disabled })
    setUsers((prev) => prev.map((u) => (u.userId === updated.userId ? updated : u)))
  }

  const handleToggleRole = async (user: AdminUser) => {
    if (!session?.accessToken) return
    const newRole = user.role === "admin" ? "member" : "admin"
    const updated = await authApi.updateUser(session.accessToken, user.userId, { role: newRole })
    setUsers((prev) => prev.map((u) => (u.userId === updated.userId ? updated : u)))
  }

  const handleDelete = async (user: AdminUser) => {
    if (!session?.accessToken) return
    await authApi.deleteUser(session.accessToken, user.userId)
    setUsers((prev) => prev.filter((u) => u.userId !== user.userId))
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto w-full max-w-4xl px-8 pt-8 pb-16">
        <button
          type="button"
          onClick={() => navigate("home")}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {tCommon("back")}
        </button>

        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("description")}
        </p>

        <div className="mt-6 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex items-center rounded-lg border border-border bg-card p-1 gap-0.5">
            {tabItems.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setFilterTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  filterTab === t.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
                <span className={cn("text-xs", filterTab === t.id ? "text-foreground" : "text-muted-foreground/60")}>
                  {counts[t.id]}
                </span>
              </button>
            ))}
          </div>

          <Button size="sm">
            <Plus className="size-4" />
            {t("newUser")}
          </Button>
        </div>

        <div className="mt-6 rounded-xl border border-border overflow-hidden">
          {loading ? (
            <LoadingState className="py-12" />
          ) : error ? (
            <div className="px-4 py-12 text-center text-sm text-destructive">{error}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t("user")}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t("role")}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t("status")}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t("created")}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">{t("lastUpdated")}</th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((user) => {
                  const isYou = user.userId === me?.userId
                  return (
                    <tr key={user.userId} className="group/row transition-colors hover:bg-muted/10">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar className="size-8 rounded-full">
                            <AvatarFallback className="rounded-full bg-primary/20 text-xs font-bold text-primary">
                              {user.userId.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{user.userId}</span>
                          {isYou && (
                            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {t("you")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <RoleDot role={user.role} />
                        {user.role === "admin" ? t("admin") : t("member")}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <StatusDot disabled={user.disabled} />
                        {user.disabled ? t("disabled") : t("active")}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {formatDate(user.createdAt) === "today" ? t("today") : formatDate(user.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {formatDate(user.updatedAt) === "today" ? t("today") : formatDate(user.updatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <UserContextMenu
                          user={user}
                          isYou={isYou}
                          onToggleDisable={() => handleToggleDisable(user)}
                          onToggleRole={() => handleToggleRole(user)}
                          onDelete={() => handleDelete(user)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}
