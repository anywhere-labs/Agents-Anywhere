"use client"

// Picking a working directory on a device (v2 workspace-picker + file browser dialog): the home directory, the
// device's recent project folders, a folder browser (Device/list_dirs, folders only) and a typed path.
import { useCallback, useEffect, useState } from "react"
import { ArrowUpIcon, CheckIcon, FolderIcon, HomeIcon, LoaderCircleIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { DeviceRecord, ListDirsResult } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { tildePath } from "@/lib/workbench/tree"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

export function FolderPickerDialog({
  open,
  onOpenChange,
  tunnelManager,
  device,
  start,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  start?: string
  onPick: (path: string) => void
}) {
  const { t } = useI18n()
  const [listing, setListing] = useState<ListDirsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState("")

  const load = useCallback(
    async (path?: string) => {
      if (!tunnelManager || !device) return
      setLoading(true)
      setError(null)
      try {
        const res = await tunnelManager.listDirs(device, path || "~")
        setListing({
          ...res,
          entries: res.entries.filter((e) => e.is_dir && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name)),
        })
        setTyped(res.path)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [device, tunnelManager]
  )

  useEffect(() => {
    if (!open) return
    let alive = true
    queueMicrotask(() => {
      if (alive) void load(start)
    })
    return () => {
      alive = false
    }
  }, [load, open, start])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("newConv.chooseDirectory")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim()) void load(typed.trim())
          }}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("newConv.up")}
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
          >
            <ArrowUpIcon className="size-4" />
          </Button>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={t("newConv.typePath")}
            placeholder={t("newConv.typePath")}
            className="font-mono text-xs"
          />
        </form>
        <div className="h-72 overflow-y-auto rounded-2xl bg-background p-1.5">
          {loading && !listing && (
            <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {t("common.loading")}
            </p>
          )}
          {error && <p className="p-3 text-xs text-destructive">{error}</p>}
          {listing?.entries.length === 0 && (
            <p className="p-6 text-center text-xs text-muted-foreground">{t("panel.emptyDir")}</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {listing?.entries.map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => void load(e.path)}
                  className="flex h-8 w-full min-w-0 items-center gap-2 rounded-full px-3 text-left text-sm hover:bg-surface-hover"
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{e.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!listing}
            onClick={() => {
              if (!listing) return
              onPick(listing.path)
              onOpenChange(false)
            }}
          >
            <CheckIcon className="size-4" />
            {t("newConv.useThisFolder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The directory menu's rows: home, then recent projects. */
export function DirectoryOptions({
  value,
  recent,
  onPick,
  onBrowse,
}: {
  value: string | null
  recent: { cwd: string; name: string }[]
  onPick: (cwd: string | null) => void
  onBrowse: () => void
}) {
  const { t } = useI18n()
  const row = (key: string, active: boolean, icon: React.ReactNode, label: string, meta: string | null, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 w-full min-w-0 items-center gap-2.5 rounded-full px-3 text-left text-sm hover:bg-surface-hover",
        active && "bg-surface-raised"
      )}
    >
      <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 truncate text-foreground">{label}</span>
      {meta && <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground">{meta}</span>}
    </button>
  )
  return (
    <div className="flex flex-col gap-0.5">
      {row("home", value === null, <HomeIcon />, t("newConv.homeDirectory"), "~", () => onPick(null))}
      {recent.length > 0 && <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{t("newConv.recentProjects")}</p>}
      {recent.slice(0, 8).map((p) =>
        row(p.cwd, value === p.cwd, <FolderIcon />, p.name, tildePath(p.cwd), () => onPick(p.cwd))
      )}
      <div className="mt-1 border-t border-border pt-1">
        {row("browse", false, <FolderIcon />, t("newConv.browse"), null, onBrowse)}
      </div>
    </div>
  )
}
