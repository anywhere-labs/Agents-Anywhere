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
  ArrowUp,
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
import { cn } from "@/lib/utils"
import { fsList, type FsEntry } from "@/lib/api"
import { useWorkspace } from "@/components/workspace-context"

const MOCK_TOKEN = "mock-token"

// ── Types ─────────────────────────────────────────────────────

type WorkspaceEntry = {
  label: string
  path: string
  connectorId?: string
}

// ── File browser dialog ────────────────────────────────────────

function FileBrowserDialog({
  open,
  onOpenChange,
  connectorId,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connectorId: string
  onConfirm: (path: string) => void
}) {
  const [currentPath, setCurrentPath] = React.useState("")
  const [inputPath, setInputPath] = React.useState("")
  const [entries, setEntries] = React.useState<FsEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadPath = React.useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      try {
        const res = await fsList(MOCK_TOKEN, connectorId, { root: "~", path })
        setEntries(res.result.entries)
        setCurrentPath(path)
        setInputPath(path)
      } catch {
        setError("Failed to load directory.")
      } finally {
        setLoading(false)
      }
    },
    [connectorId],
  )

  React.useEffect(() => {
    if (open) loadPath(".")
  }, [open, loadPath])

  const dirs = entries.filter((e) => e.type === "directory")
  const files = entries.filter((e) => e.type !== "directory")

  const isWindows = currentPath.includes("\\") || /^[A-Z]:/.test(currentPath)
  const sep = isWindows ? "\\" : "/"

  const parentPath = React.useMemo(() => {
    if (!currentPath || currentPath === "." || currentPath === "") return null
    const parts = currentPath.split(sep)
    return parts.length > 1 ? parts.slice(0, -1).join(sep) || sep : null
  }, [currentPath, sep])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a workspace folder</DialogTitle>
        </DialogHeader>

        {/* Path bar */}
        <div className="flex gap-2">
          <Input
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadPath(inputPath)
            }}
            placeholder="Enter path…"
            className="font-mono text-xs"
          />
          <Button variant="outline" size="icon" onClick={() => loadPath(inputPath)} title="Open">
            <ArrowUp className="size-4" />
          </Button>
          {parentPath && (
            <Button variant="outline" size="icon" onClick={() => loadPath(parentPath)} title="Parent">
              <ChevronRight className="size-4 -rotate-90" />
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={() => loadPath(currentPath)} title="Refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8 text-sm text-destructive">
              {error}
            </div>
          ) : (
            <div className="p-2">
              {dirs.length === 0 && files.length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Empty directory
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
              {files.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  disabled
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm opacity-50"
                >
                  <span className="size-4 shrink-0" />
                  <span className="truncate">{entry.name}</span>
                  {entry.size != null && (
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {entry.size > 1024 ? `${(entry.size / 1024).toFixed(1)}k` : `${entry.size}b`}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          {currentPath || "~"}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm(currentPath)
              onOpenChange(false)
            }}
          >
            Open workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Workspace picker ───────────────────────────────────────────

export function WorkspacePicker() {
  const { connectors, sessions } = useWorkspace()

  // Pick first online connector for FS browsing
  const activeConnector = connectors.find((c) => c.status === "online") ?? connectors[0]

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

  // Default home from active connector sessions
  const homeWorkspace: WorkspaceEntry = React.useMemo(() => {
    const homeSessions = sessions.filter((s) => s.connectorId === activeConnector?.id && s.cwd)
    const home = homeSessions[0]?.cwd ?? "~"
    return { label: "Home directory", path: home, connectorId: activeConnector?.id }
  }, [sessions, activeConnector])

  const [workspace, setWorkspace] = React.useState<WorkspaceEntry>(homeWorkspace)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  React.useEffect(() => {
    setWorkspace(homeWorkspace)
  }, [homeWorkspace])

  const isHome = workspace.path === homeWorkspace.path

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{isHome ? "Home directory" : workspace.label}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{workspace.path}</span>
            <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-80">
          {/* Home directory */}
          <DropdownMenuItem className="gap-2.5" onSelect={() => setWorkspace(homeWorkspace)}>
            <Home className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col">
              <span>Home directory</span>
              <span className="font-mono text-xs text-muted-foreground">{homeWorkspace.path}</span>
            </div>
            {isHome && <Check className="ml-auto size-3.5 shrink-0" />}
          </DropdownMenuItem>

          {/* Browse */}
          <DropdownMenuItem className="gap-2.5" onSelect={() => setDialogOpen(true)}>
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            <span>Browse filesystem…</span>
          </DropdownMenuItem>

          {/* Recent workspaces */}
          {recentWorkspaces.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {recentWorkspaces.map((ws) => (
                <DropdownMenuItem
                  key={ws.path}
                  className="gap-2.5"
                  onSelect={() => setWorkspace(ws)}
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
        onConfirm={(path) => {
          const isWin = path.includes("\\")
          const sep = isWin ? "\\" : "/"
          const parts = path.split(sep)
          const label = parts[parts.length - 1] || path
          setWorkspace({ label, path, connectorId: activeConnector?.id })
        }}
      />
    </>
  )
}
