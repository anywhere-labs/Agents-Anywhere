"use client"

import * as React from "react"
import {
  Ban,
  ChevronLeft,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Shield,
  Trash2,
  UserRound,
  Users,
} from "lucide-react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAuth } from "@/components/auth/auth-context"
import { LoadingState } from "@/components/loading-state"
import { useWorkspace } from "@/components/workspace-context"
import { authApi } from "@/features/auth/api"
import type { AdminUser, UserRole } from "@/features/auth/types"
import { cn } from "@/lib/utils"

type FilterTab = "all" | "admins" | "members"
type UserDraft = {
  userId: string
  role: UserRole
  password: string
  confirmPassword: string
}

const USER_ID_RE = /^[a-z0-9_-]{3,64}$/

function initialDraft(): UserDraft {
  return {
    userId: "",
    role: "member",
    password: "",
    confirmPassword: "",
  }
}

export function TeamPage() {
  const { navigate } = useWorkspace()
  const { session, me } = useAuth()
  const t = useTranslations("pages.team")
  const tCommon = useTranslations("common")
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [filterTab, setFilterTab] = React.useState<FilterTab>("all")
  const [search, setSearch] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editingUser, setEditingUser] = React.useState<AdminUser | null>(null)
  const [deleteUser, setDeleteUser] = React.useState<AdminUser | null>(null)
  const [rowBusyUserId, setRowBusyUserId] = React.useState<string | null>(null)
  const isAdmin = me?.role === "admin"

  const loadUsers = React.useCallback(() => {
    if (!session?.accessToken) {
      setUsers([])
      setLoading(false)
      return
    }

    let cancelled = false
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

  React.useEffect(() => loadUsers(), [loadUsers])

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return users.filter((user) => {
      if (filterTab === "admins" && user.role !== "admin") return false
      if (filterTab === "members" && user.role !== "member") return false
      if (query && !user.userId.toLowerCase().includes(query)) return false
      return true
    })
  }, [filterTab, search, users])

  const counts = React.useMemo(
    () => ({
      all: users.length,
      admins: users.filter((user) => user.role === "admin").length,
      members: users.filter((user) => user.role === "member").length,
    }),
    [users],
  )

  const upsertUser = React.useCallback((updated: AdminUser) => {
    setUsers((current) =>
      current.some((user) => user.userId === updated.userId)
        ? current.map((user) => (user.userId === updated.userId ? updated : user))
        : [updated, ...current],
    )
  }, [])

  const handleToggleDisabled = async (user: AdminUser) => {
    if (!session?.accessToken || rowBusyUserId) return
    setRowBusyUserId(user.userId)
    setError(null)
    try {
      upsertUser(await authApi.updateUser(session.accessToken, user.userId, { disabled: !user.disabled }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("updateFailed"))
    } finally {
      setRowBusyUserId(null)
    }
  }

  const handleToggleRole = async (user: AdminUser) => {
    if (!session?.accessToken || rowBusyUserId) return
    const nextRole: UserRole = user.role === "admin" ? "member" : "admin"
    setRowBusyUserId(user.userId)
    setError(null)
    try {
      upsertUser(await authApi.updateUser(session.accessToken, user.userId, { role: nextRole }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("updateFailed"))
    } finally {
      setRowBusyUserId(null)
    }
  }

  const handleDeleted = (userId: string) => {
    setUsers((current) => current.filter((user) => user.userId !== userId))
    setDeleteUser(null)
    if (editingUser?.userId === userId) setEditingUser(null)
  }

  const filterItems: { id: FilterTab; label: string }[] = [
    { id: "all", label: t("all") },
    { id: "admins", label: t("admins") },
    { id: "members", label: t("members") },
  ]

  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pb-16 pt-8">
        <div>
          <button
            type="button"
            onClick={() => navigate("home")}
            className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            {tCommon("back")}
          </button>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{t("title")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
            </div>
            <Button size="sm" disabled={!isAdmin} onClick={() => setCreateOpen(true)}>
              <Plus data-icon="inline-start" />
              {t("newUser")}
            </Button>
          </div>
        </div>

        {!isAdmin ? (
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            {t("adminOnly")}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-64 flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              className="pl-9"
            />
          </div>

          <ToggleGroup
            type="single"
            value={filterTab}
            onValueChange={(value) => {
              if (value) setFilterTab(value as FilterTab)
            }}
            variant="outline"
            spacing={0}
          >
            {filterItems.map((item) => (
              <ToggleGroupItem key={item.id} value={item.id} className="gap-1.5">
                {item.label}
                <span className="text-xs text-muted-foreground">{counts[item.id]}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {loading ? (
            <LoadingState className="py-16" />
          ) : filtered.length === 0 ? (
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>{search ? t("noSearchResults") : t("noUsers")}</EmptyTitle>
                <EmptyDescription>{search ? t("noSearchDescription") : t("noUsersDescription")}</EmptyDescription>
              </EmptyHeader>
              {isAdmin && !search ? (
                <EmptyContent>
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus data-icon="inline-start" />
                    {t("newUser")}
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/20 hover:bg-muted/20">
                  <TableHead className="px-4">{t("user")}</TableHead>
                  <TableHead>{t("role")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("created")}</TableHead>
                  <TableHead>{t("lastUpdated")}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((user) => {
                  const isYou = user.userId === me?.userId
                  const busy = rowBusyUserId === user.userId
                  return (
                    <TableRow key={user.userId} className="group/row">
                      <TableCell className="px-4">
                        <div className="flex min-w-56 items-center gap-3">
                          <Avatar className="size-8 rounded-full">
                            {user.avatar ? <AvatarImage src={user.avatar} alt={user.userId} /> : null}
                            <AvatarFallback className="rounded-full bg-primary/15 text-xs font-semibold text-primary">
                              {user.userId.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{user.userId}</span>
                              {isYou ? <Badge variant="secondary">{t("you")}</Badge> : null}
                            </div>
                            <div className="code-mono mt-0.5 truncate text-xs text-muted-foreground">
                              {user.userId}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={user.role} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge disabled={user.disabled} />
                      </TableCell>
                      <TableCell className="code-mono text-xs text-muted-foreground">
                        {formatDate(user.createdAt, t)}
                      </TableCell>
                      <TableCell className="code-mono text-xs text-muted-foreground">
                        {formatDate(user.updatedAt, t)}
                      </TableCell>
                      <TableCell>
                        <UserContextMenu
                          user={user}
                          isYou={isYou}
                          disabled={!isAdmin || busy}
                          busy={busy}
                          onEdit={() => setEditingUser(user)}
                          onToggleDisabled={() => void handleToggleDisabled(user)}
                          onToggleRole={() => void handleToggleRole(user)}
                          onDelete={() => setDeleteUser(user)}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <CreateUserDialog
        open={createOpen}
        token={session?.accessToken ?? ""}
        onOpenChange={setCreateOpen}
        onCreated={upsertUser}
      />
      <EditUserDialog
        user={editingUser}
        token={session?.accessToken ?? ""}
        currentUserId={me?.userId ?? ""}
        onOpenChange={(open) => {
          if (!open) setEditingUser(null)
        }}
        onSaved={upsertUser}
        onDelete={(user) => setDeleteUser(user)}
      />
      <DeleteUserDialog
        user={deleteUser}
        token={session?.accessToken ?? ""}
        onOpenChange={(open) => {
          if (!open) setDeleteUser(null)
        }}
        onDeleted={handleDeleted}
      />
    </ScrollArea>
  )
}

function UserContextMenu({
  user,
  isYou,
  disabled,
  busy,
  onEdit,
  onToggleDisabled,
  onToggleRole,
  onDelete,
}: {
  user: AdminUser
  isYou: boolean
  disabled: boolean
  busy: boolean
  onEdit: () => void
  onToggleDisabled: () => void
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
          disabled={disabled}
          className="size-8 opacity-0 group-hover/row:opacity-100 data-[state=open]:opacity-100"
          aria-label={t("userActions")}
        >
          {busy ? <Spinner /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem className="gap-2.5" onSelect={onEdit}>
          <Pencil data-icon="inline-start" />
          {t("editUser")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onSelect={onToggleDisabled} disabled={isYou}>
          <Ban data-icon="inline-start" />
          {user.disabled ? t("enable") : t("disable")}
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onSelect={onToggleRole} disabled={isYou}>
          <Shield data-icon="inline-start" />
          {user.role === "admin" ? t("demote") : t("promote")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5 text-destructive focus:text-destructive" onSelect={onDelete} disabled={isYou}>
          <Trash2 data-icon="inline-start" />
          {t("deleteUser")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CreateUserDialog({
  open,
  token,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  token: string
  onOpenChange: (open: boolean) => void
  onCreated: (user: AdminUser) => void
}) {
  const t = useTranslations("pages.team")
  const [draft, setDraft] = React.useState<UserDraft>(() => initialDraft())
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) {
      setDraft(initialDraft())
      setSaving(false)
      setError(null)
    }
  }, [open])

  const validation = validateUserDraft(draft, true)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!token || saving || validation) {
      if (validation) setError(t(validation))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await authApi.createUser(token, {
        userId: draft.userId,
        role: draft.role,
        password: draft.password,
      })
      onCreated(created)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("newUser")}</DialogTitle>
          <DialogDescription>{t("newUserDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <UserFormFields draft={draft} onDraftChange={setDraft} requirePassword />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving || Boolean(validation)}>
              {saving ? <Spinner /> : <Plus data-icon="inline-start" />}
              {t("createUser")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditUserDialog({
  user,
  token,
  currentUserId,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  user: AdminUser | null
  token: string
  currentUserId: string
  onOpenChange: (open: boolean) => void
  onSaved: (user: AdminUser) => void
  onDelete: (user: AdminUser) => void
}) {
  const t = useTranslations("pages.team")
  const [role, setRole] = React.useState<UserRole>("member")
  const [active, setActive] = React.useState(true)
  const [passwordOpen, setPasswordOpen] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (user) {
      setRole(user.role)
      setActive(!user.disabled)
    }
    setPasswordOpen(false)
    setPassword("")
    setConfirmPassword("")
    setSaving(false)
    setError(null)
  }, [user])

  if (!user) return null

  const isSelf = user.userId === currentUserId
  const dirty = role !== user.role || active === user.disabled
  const passwordValidation = passwordOpen
    ? validatePasswordPair(password, confirmPassword)
    : null

  const saveChanges = async () => {
    if (!token || saving || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const updated = await authApi.updateUser(token, user.userId, {
        ...(role !== user.role ? { role } : {}),
        ...(active === user.disabled ? { disabled: !active } : {}),
      })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("updateFailed"))
    } finally {
      setSaving(false)
    }
  }

  const resetPassword = async () => {
    if (!token || saving || passwordValidation) {
      if (passwordValidation) setError(t(passwordValidation))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const updated = await authApi.updateUser(token, user.userId, { password })
      onSaved(updated)
      setPasswordOpen(false)
      setPassword("")
      setConfirmPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("passwordResetFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(user)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editUser")}</DialogTitle>
          <DialogDescription>{t("editUserDescription", { userId: user.userId })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/20 p-3">
            <Avatar className="size-10 rounded-full">
              {user.avatar ? <AvatarImage src={user.avatar} alt={user.userId} /> : null}
              <AvatarFallback className="rounded-full bg-primary/15 text-sm font-semibold text-primary">
                {user.userId.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{user.userId}</p>
                {isSelf ? <Badge variant="secondary">{t("you")}</Badge> : null}
              </div>
              <p className="code-mono mt-0.5 truncate text-xs text-muted-foreground">{user.userId}</p>
            </div>
          </div>

          <FieldGroup>
            <Field data-disabled={isSelf}>
              <FieldLabel>{t("role")}</FieldLabel>
              <ToggleGroup
                type="single"
                value={role}
                onValueChange={(value) => {
                  if (value && !isSelf) setRole(value as UserRole)
                }}
                variant="outline"
                spacing={0}
              >
                <ToggleGroupItem value="member">{t("member")}</ToggleGroupItem>
                <ToggleGroupItem value="admin">{t("admin")}</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>{role === "admin" ? t("adminDescription") : t("memberDescription")}</FieldDescription>
            </Field>

            <Field orientation="horizontal" data-disabled={isSelf}>
              <FieldContent>
                <FieldLabel>{t("active")}</FieldLabel>
                <FieldDescription>{active ? t("activeDescription") : t("disabledDescription")}</FieldDescription>
              </FieldContent>
              <Switch checked={active} disabled={isSelf} onCheckedChange={setActive} />
            </Field>

            <Field>
              <FieldLabel>{t("password")}</FieldLabel>
              {!passwordOpen ? (
                <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setPasswordOpen(true)}>
                  <KeyRound data-icon="inline-start" />
                  {t("resetPassword")}
                </Button>
              ) : (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-3">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={t("newPassword")}
                    value={password}
                    onChange={(event) => setPassword(event.currentTarget.value)}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    placeholder={t("confirmPassword")}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPasswordOpen(false)
                        setPassword("")
                        setConfirmPassword("")
                      }}
                    >
                      {t("cancel")}
                    </Button>
                    <Button type="button" size="sm" disabled={saving || Boolean(passwordValidation)} onClick={resetPassword}>
                      {saving ? <Spinner /> : <KeyRound data-icon="inline-start" />}
                      {t("setPassword")}
                    </Button>
                  </div>
                </div>
              )}
            </Field>
          </FieldGroup>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <Button type="button" variant="destructive" disabled={isSelf} onClick={() => onDelete(user)}>
            <Trash2 data-icon="inline-start" />
            {t("deleteUser")}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" disabled={saving || !dirty} onClick={() => void saveChanges()}>
              {saving ? <Spinner /> : null}
              {t("saveChanges")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteUserDialog({
  user,
  token,
  onOpenChange,
  onDeleted,
}: {
  user: AdminUser | null
  token: string
  onOpenChange: (open: boolean) => void
  onDeleted: (userId: string) => void
}) {
  const t = useTranslations("pages.team")
  const [confirmation, setConfirmation] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setConfirmation("")
    setSaving(false)
    setError(null)
  }, [user])

  if (!user) return null

  const confirmed = confirmation === user.userId
  const deleteUser = async () => {
    if (!token || saving || !confirmed) return
    setSaving(true)
    setError(null)
    try {
      await authApi.deleteUser(token, user.userId)
      onDeleted(user.userId)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deleteFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open={Boolean(user)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteUser")}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteDescription", { userId: user.userId })}</AlertDialogDescription>
        </AlertDialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="team-delete-confirm">{t("typeUserId")}</FieldLabel>
            <Input
              id="team-delete-confirm"
              value={confirmation}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
              className="code-mono"
              autoFocus
            />
          </Field>
        </FieldGroup>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={!confirmed || saving} onClick={(event) => {
            event.preventDefault()
            void deleteUser()
          }}>
            {saving ? <Spinner /> : <Trash2 data-icon="inline-start" />}
            {t("deleteUser")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function UserFormFields({
  draft,
  onDraftChange,
  requirePassword,
}: {
  draft: UserDraft
  onDraftChange: (draft: UserDraft) => void
  requirePassword: boolean
}) {
  const t = useTranslations("pages.team")
  const passwordError = validatePasswordPair(draft.password, draft.confirmPassword)
  return (
    <FieldGroup>
      <Field data-invalid={Boolean(draft.userId && !USER_ID_RE.test(draft.userId))}>
        <FieldLabel htmlFor="team-user-id">{t("userId")}</FieldLabel>
        <Input
          id="team-user-id"
          value={draft.userId}
          onChange={(event) =>
            onDraftChange({
              ...draft,
              userId: event.currentTarget.value.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase(),
            })
          }
          className="code-mono"
          autoComplete="username"
          autoFocus
          aria-invalid={Boolean(draft.userId && !USER_ID_RE.test(draft.userId))}
        />
        <FieldDescription>{t("userIdDescription")}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel>{t("role")}</FieldLabel>
        <ToggleGroup
          type="single"
          value={draft.role}
          onValueChange={(value) => {
            if (value) onDraftChange({ ...draft, role: value as UserRole })
          }}
          variant="outline"
          spacing={0}
        >
          <ToggleGroupItem value="member">{t("member")}</ToggleGroupItem>
          <ToggleGroupItem value="admin">{t("admin")}</ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription>{draft.role === "admin" ? t("adminDescription") : t("memberDescription")}</FieldDescription>
      </Field>

      <Field data-invalid={Boolean(draft.password && passwordError)}>
        <FieldLabel htmlFor="team-password">{t("password")}</FieldLabel>
        <Input
          id="team-password"
          type="password"
          autoComplete="new-password"
          value={draft.password}
          onChange={(event) => onDraftChange({ ...draft, password: event.currentTarget.value })}
          aria-invalid={Boolean(draft.password && passwordError)}
        />
        <FieldDescription>{requirePassword ? t("passwordDescription") : t("optionalPasswordDescription")}</FieldDescription>
      </Field>

      <Field data-invalid={Boolean(draft.confirmPassword && passwordError)}>
        <FieldLabel htmlFor="team-confirm-password">{t("confirmPassword")}</FieldLabel>
        <Input
          id="team-confirm-password"
          type="password"
          autoComplete="new-password"
          value={draft.confirmPassword}
          onChange={(event) => onDraftChange({ ...draft, confirmPassword: event.currentTarget.value })}
          aria-invalid={Boolean(draft.confirmPassword && passwordError)}
        />
      </Field>
    </FieldGroup>
  )
}

function RoleBadge({ role }: { role: UserRole }) {
  const t = useTranslations("pages.team")
  return (
    <Badge variant={role === "admin" ? "default" : "secondary"}>
      {role === "admin" ? <Shield data-icon="inline-start" /> : <UserRound data-icon="inline-start" />}
      {role === "admin" ? t("admin") : t("member")}
    </Badge>
  )
}

function StatusBadge({ disabled }: { disabled: boolean }) {
  const t = useTranslations("pages.team")
  return (
    <Badge variant={disabled ? "outline" : "secondary"}>
      <span className={cn("size-1.5 rounded-full", disabled ? "bg-muted-foreground" : "bg-emerald-500")} />
      {disabled ? t("disabled") : t("active")}
    </Badge>
  )
}

function validateUserDraft(draft: UserDraft, requirePassword: boolean): string | null {
  if (!USER_ID_RE.test(draft.userId)) return "invalidUserId"
  if (!requirePassword && !draft.password && !draft.confirmPassword) return null
  return validatePasswordPair(draft.password, draft.confirmPassword)
}

function validatePasswordPair(password: string, confirmPassword: string): string | null {
  if (password.length < 8) return "passwordTooShort"
  if (password !== confirmPassword) return "passwordMismatch"
  return null
}

function formatDate(iso: string, t: ReturnType<typeof useTranslations<"pages.team">>) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const diff = Date.now() - date.getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days <= 0) return t("today")
  if (days === 1) return t("oneDayAgo")
  if (days < 7) return t("daysAgo", { count: days })
  if (days < 30) return t("weeksAgo", { count: Math.floor(days / 7) })
  return date.toLocaleDateString()
}
