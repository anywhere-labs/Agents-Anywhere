"use client"

import * as React from "react"
import { ChevronRight, FolderOpen, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { LoadingState } from "@/components/loading-state"
import { dashboardApi } from "@/features/dashboard/api"
import type { FsEntry } from "@/features/dashboard/types"

export function FileBrowserDialog({
  open,
  onOpenChange,
  connectorId,
  connectorDeviceOs,
  token,
  initialPath = "~",
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connectorId: string
  connectorDeviceOs?: string | null
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
  const requestRef = React.useRef(0)
  const isWindowsConnector = connectorDeviceOs === "windows"

  const loadPath = React.useCallback(
    async (path: string) => {
      const request = ++requestRef.current
      setCurrentPath("")
      if (!token || !connectorId) {
        setError(tNew("deviceOffline"))
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const trimmedPath = path.trim()
        const target = isWindowsConnector ? trimmedPath : trimmedPath || "/"
        const root = target || "~"
        const res = await dashboardApi.connectorFsList(token, connectorId, {
          root,
          path: target ? "." : "",
        })
        if (request !== requestRef.current) return
        if (res.result.targetType === "file") throw new Error(t("directoryRequired"))
        setEntries(res.result.entries)
        const resolved = res.result.path || target
        setCurrentPath(resolved)
        setInputPath(resolved)
      } catch (err) {
        if (request !== requestRef.current) return
        setEntries([])
        setError(err instanceof Error ? err.message : t("loadFailed"))
      } finally {
        if (request === requestRef.current) setLoading(false)
      }
    },
    [connectorId, isWindowsConnector, t, tNew, token],
  )

  React.useEffect(() => {
    if (open) void loadPath(isWindowsConnector ? initialPath : initialPath || "~")
    return () => { requestRef.current++ }
  }, [initialPath, isWindowsConnector, open, loadPath])

  const dirs = React.useMemo(
    () => entries.filter((entry) => entry.type === "directory").sort((a, b) => a.name.localeCompare(b.name)),
    [entries],
  )

  const isWindows = currentPath.includes("\\") || /^[A-Z]:/.test(currentPath)
  const sep = isWindows ? "\\" : "/"

  const parentPath = React.useMemo(() => {
    if (!currentPath || currentPath === "." || currentPath === "") return null
    if (isWindows && /^[A-Za-z]:[\\/]?$/.test(currentPath)) return ""
    const parts = currentPath.split(sep)
    return parts.length > 1 ? parts.slice(0, -1).join(sep) || sep : null
  }, [currentPath, isWindows, sep])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(760px,calc(100vh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto_auto] gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        {/* Path bar */}
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label={t("enterPath")}
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                e.stopPropagation()
                void loadPath(inputPath)
              }
            }}
            placeholder={t("enterPath")}
            className="min-w-0 code-mono text-xs"
          />
          {parentPath !== null && (
            <Button type="button" variant="outline" size="icon" onClick={() => void loadPath(parentPath)} aria-label={t("parent")}>
              <ChevronRight className="-rotate-90" />
            </Button>
          )}
          <Button type="button" variant="outline" size="icon" disabled={loading} onClick={() => void loadPath(currentPath || inputPath || initialPath)} aria-label={t("refresh")}>
            <RefreshCw />
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

        <div className="truncate rounded-md border border-border bg-muted/40 px-3 py-2 code-mono text-xs text-muted-foreground">
          {currentPath || t("resolvingHome")}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            disabled={loading || Boolean(error) || !currentPath}
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
