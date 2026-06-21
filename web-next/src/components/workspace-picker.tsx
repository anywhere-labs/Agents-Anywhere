"use client"

import * as React from "react"
import {
  Folder,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Home,
  Plus,
  Check,
  RefreshCw,
} from "lucide-react"
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
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWorkspace } from "@/components/workspace-context"
import { useAuth } from "@/components/auth/auth-context"
import { LoadingState } from "@/components/loading-state"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

// ── Types ─────────────────────────────────────────────────────

type WorkspaceEntry = {
  label: string
  path: string
  connectorId?: string
}

export type WorkspaceSelection = WorkspaceEntry

// ── File browser dialog ────────────────────────────────────────

function FileBrowserDialog({
  open,
  onOpenChange,
  connectorId,
  token,
  initialPath = "~",
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connectorId: string
  token: string | null | undefined
  initialPath?: string
  onConfirm: (path: string) => void
}) {
  const t = useTranslations("dashboard.workspacePicker")
  const tNew = useTranslations("dashboard.new")
  const tCommon = useTranslations("common")
  const [currentPath, setCurrentPath] = React.useState("")
  const [inputPath, setInputPath] = React.useState("")
  const [entries, setEntries] = React.useState<FsEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadPath = React.useCallback(
    async (path: string) => {
      if (!token || !connectorId) {
        setError(tNew("deviceOffline"))
        return
      }
      setLoading(true)
      setError(null)
      try {
        const target = path.trim() || "~"
        const res = await dashboardApi.connectorFsList(token, connectorId, {
          root: target,
          path: ".",
        })
        setEntries(res.result.entries)
        const resolved = res.result.path || target
        setCurrentPath(resolved)
        setInputPath(resolved)
      } catch (err) {
        setEntries([])
        setError(err instanceof Error ? err.message : t("loadFailed"))
      } finally {
        setLoading(false)
      }
    },
    [connectorId, token],
  )

  React.useEffect(() => {
    if (open) loadPath(initialPath || "~")
  }, [initialPath, open, loadPath])

  const dirs = React.useMemo(
    () => entries.filter((entry) => entry.type === "directory").sort((a, b) => a.name.localeCompare(b.name)),
    [entries],
  )

  const isWindows = currentPath.includes("\\") || /^[A-Z]:/.test(currentPath)
  const sep = isWindows ? "\\" : "/"

  const parentPath = React.useMemo(() => {
    if (!currentPath || currentPath === "." || currentPath === "") return null
    const parts = currentPath.split(sep)
    return parts.length > 1 ? parts.slice(0, -1).join(sep) || sep : null
  }, [currentPath, sep])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(760px,calc(100vh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        {/* Path bar */}
        <div className="flex min-w-0 gap-2">
          <Input
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadPath(inputPath)
            }}
            placeholder={t("enterPath")}
            className="min-w-0 font-mono text-xs"
          />
          {parentPath && (
            <Button variant="outline" size="icon" onClick={() => loadPath(parentPath)} title={t("parent")}>
              <ChevronRight className="size-4 -rotate-90" />
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={() => loadPath(currentPath)} title={t("refresh")}>
            <RefreshCw className="size-4" />
          </Button>
        </div>

        <ScrollArea className="min-h-0 rounded-md border border-border">
          {loading ? (
            <LoadingState className="py-8" />
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-sm text-destructive">
              {error}
            </div>
          ) : (
            <div className="p-2">
              {dirs.length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t("emptyDirectory")}
                </div>
              )}
              {dirs.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => loadPath(entry.path)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          {currentPath || t("resolvingHome")}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={() => {
              onConfirm(currentPath)
              onOpenChange(false)
            }}
          >
            {t("openWorkspace")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Workspace picker ───────────────────────────────────────────

export function WorkspacePicker({
  connectorId,
  value,
  onChange,
}: {
  connectorId?: string
  value?: WorkspaceSelection | null
  onChange?: (workspace: WorkspaceSelection) => void
} = {}) {
  const { session: authSession } = useAuth()
  const { connectors, sessions } = useWorkspace()
  const t = useTranslations("dashboard.workspacePicker")

  // Pick first online connector for FS browsing
  const activeConnector =
    connectors.find((c) => c.id === connectorId) ??
    connectors.find((c) => c.status === "online") ??
    connectors[0]
  const [resolvedHomePath, setResolvedHomePath] = React.useState("")

  React.useEffect(() => {
    setResolvedHomePath("")
    if (!authSession?.accessToken || !activeConnector?.id) {
      return
    }
    let cancelled = false
    dashboardApi
      .connectorFsList(authSession.accessToken, activeConnector.id, { root: "~", path: "." })
      .then((response) => {
        if (cancelled) return
        setResolvedHomePath(response.result.path || "")
      })
      .catch(() => {
        if (!cancelled) setResolvedHomePath("")
      })
    return () => {
      cancelled = true
    }
  }, [activeConnector?.id, authSession?.accessToken])

  // Derive recent unique workspaces from session CWDs
  const recentWorkspaces = React.useMemo<WorkspaceEntry[]>(() => {
    const seen = new Set<string>()
    const result: WorkspaceEntry[] = []
    for (const s of sessions) {
      if (!s.cwd || seen.has(s.cwd)) continue
      seen.add(s.cwd)
      const isWin = s.cwd.includes("\\")
      const sep = isWin ? "\\" : "/"
      const parts = s.cwd.split(sep)
      result.push({ label: parts[parts.length - 1] || s.cwd, path: s.cwd, connectorId: s.connectorId })
      if (result.length >= 5) break
    }
    return result
  }, [sessions])

  const homeWorkspace: WorkspaceEntry = React.useMemo(() => {
    return { label: t("home"), path: resolvedHomePath, connectorId: activeConnector?.id }
  }, [activeConnector?.id, resolvedHomePath, t])

  const [internalWorkspace, setInternalWorkspace] = React.useState<WorkspaceEntry>(homeWorkspace)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const valueBelongsToActiveConnector =
    Boolean(value?.path) && (!activeConnector?.id || value?.connectorId === activeConnector.id)
  const workspace = valueBelongsToActiveConnector ? value! : internalWorkspace

  const updateWorkspace = React.useCallback(
    (next: WorkspaceEntry) => {
      if (!value) setInternalWorkspace(next)
      onChange?.(next)
    },
    [onChange, value],
  )

  React.useEffect(() => {
    if (value?.connectorId && activeConnector?.id && value.connectorId !== activeConnector.id) {
      setInternalWorkspace({ label: t("home"), path: "", connectorId: activeConnector.id })
    }
    if (!homeWorkspace.path) return
    if (!value) {
      setInternalWorkspace(homeWorkspace)
      onChange?.(homeWorkspace)
    } else if (activeConnector?.id && value.connectorId !== activeConnector.id) {
      onChange?.(homeWorkspace)
    }
  }, [activeConnector?.id, homeWorkspace, onChange, value])

  const isHome = Boolean(homeWorkspace.path && workspace.path === homeWorkspace.path)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{isHome ? t("home") : workspace.label}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {workspace.path || t("resolvingHome")}
            </span>
            <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-80">
          {/* Home directory */}
          <DropdownMenuItem
            className="gap-2.5"
            disabled={!homeWorkspace.path}
            onSelect={() => updateWorkspace(homeWorkspace)}
          >
            <Home className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col">
              <span>{t("home")}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {homeWorkspace.path || t("resolvingHome")}
              </span>
            </div>
            {isHome && <Check className="ml-auto size-3.5 shrink-0" />}
          </DropdownMenuItem>

          {/* Browse */}
          <DropdownMenuItem className="gap-2.5" onSelect={() => setDialogOpen(true)}>
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            <span>{t("browseFilesystem")}</span>
          </DropdownMenuItem>

          {/* Recent workspaces */}
          {recentWorkspaces.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {recentWorkspaces.map((ws) => (
                <DropdownMenuItem
                  key={ws.path}
                  className="gap-2.5"
                  onSelect={() => updateWorkspace(ws)}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col">
                    <span>{ws.label}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{ws.path}</span>
                  </div>
                  {workspace.path === ws.path && <Check className="ml-auto size-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <FileBrowserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connectorId={activeConnector?.id ?? ""}
        token={authSession?.accessToken}
        initialPath={workspace.path || homeWorkspace.path || "~"}
        onConfirm={(path) => {
          const isWin = path.includes("\\")
          const sep = isWin ? "\\" : "/"
          const parts = path.split(sep)
          const label = parts[parts.length - 1] || path
          updateWorkspace({ label, path, connectorId: activeConnector?.id })
        }}
      />
    </>
  )
}
