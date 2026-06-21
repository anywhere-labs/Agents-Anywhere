"use client"

import { useState, useEffect } from "react"
import { ChevronLeft, Plus, Search, Pencil, Ban, ArrowDown, Trash2, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/components/workspace-context"
import { listUsers, updateUser, deleteUser, type AdminUser } from "@/lib/api"

type FilterTab = "all" | "admins" | "members"

const MOCK_TOKEN = "mock-token"
const CURRENT_USER_ID = "t4wefan"

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
  if (days === 0) return "今天"
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
          Edit user
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onClick={onToggleDisable} disabled={isYou}>
          <Ban className="size-4 text-muted-foreground" />
          {user.disabled ? "Enable" : "Disable"}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onClick={onToggleRole} disabled={isYou}>
          <ArrowDown className="size-4 text-muted-foreground" />
          {user.role === "admin" ? "Demote to member" : "Promote to admin"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2.5 text-destructive focus:text-destructive"
          onClick={onDelete}
          disabled={isYou}
        >
          <Trash2 className="size-4" />
          Delete user
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TeamPage() {
  const { navigate } = useWorkspace()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [filterTab, setFilterTab] = useState<FilterTab>("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listUsers(MOCK_TOKEN).then((res) => {
      setUsers(res.users)
      setLoading(false)
    })
  }, [])

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
    { id: "all", label: "All" },
    { id: "admins", label: "Admins" },
    { id: "members", label: "Members" },
  ]

  const handleToggleDisable = async (user: AdminUser) => {
    const updated = await updateUser(MOCK_TOKEN, user.userId, { disabled: !user.disabled })
    setUsers((prev) => prev.map((u) => (u.userId === updated.userId ? updated : u)))
  }

  const handleToggleRole = async (user: AdminUser) => {
    const newRole = user.role === "admin" ? "member" : "admin"
    const updated = await updateUser(MOCK_TOKEN, user.userId, { role: newRole })
    setUsers((prev) => prev.map((u) => (u.userId === updated.userId ? updated : u)))
  }

  const handleDelete = async (user: AdminUser) => {
    await deleteUser(MOCK_TOKEN, user.userId)
    setUsers((prev) => prev.filter((u) => u.userId !== user.userId))
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl px-8 pt-8 pb-16">
        <button
          type="button"
          onClick={() => navigate("home")}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Back
        </button>

        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage who can sign in to this instance and what they can do.
        </p>

        <div className="mt-6 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by user id"
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
            New user
          </Button>
        </div>

        <div className="mt-6 rounded-xl border border-border overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Loading...
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">User</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Last updated</th>
                  <th className="w-10 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((user) => {
                  const isYou = user.userId === CURRENT_USER_ID
                  return (
                    <tr key={user.userId} className="group/row transition-colors hover:bg-muted/10">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar className="size-8">
                            <AvatarFallback className="bg-primary/20 text-xs font-bold text-primary">
                              {user.userId.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{user.userId}</span>
                          {isYou && (
                            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              You
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <RoleDot role={user.role} />
                        {user.role === "admin" ? "Admin" : "Member"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <StatusDot disabled={user.disabled} />
                        {user.disabled ? "Disabled" : "Active"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {formatDate(user.updatedAt)}
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
    </div>
  )
}
