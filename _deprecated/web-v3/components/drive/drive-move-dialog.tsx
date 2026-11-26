"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronRightIcon, FolderIcon, FolderSymlinkIcon, FolderSyncIcon, LoaderCircleIcon } from "lucide-react"

import { DriveBreadcrumbs } from "@/components/drive/drive-breadcrumbs"
import { driveErrorMessage, driveFolderLabel } from "@/components/drive/drive-labels"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { listDriveEntries, moveDriveFile, moveDriveFolder } from "@/lib/api/control-http"
import { driveRows, type DriveRow } from "@/lib/drive/entries"
import {
  driveBasename,
  driveJoin,
  driveParent,
  isOrchesPath,
  isWithinDrivePath,
} from "@/lib/drive/paths"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DriveFolderView } from "@/lib/types/v3"

/** Picks the folder to move a file or folder into, browsing the drive's folders. */
export function DriveMoveDialog({
  row,
  open,
  onOpenChange,
  onMoved,
}: {
  /** What to move; kept while the dialog closes so its content does not blank out. */
  row: DriveRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the folder it went to (already moved). */
  onMoved: (folder: string) => void
}) {
  return (
    <Dialog open={open && row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {row && (
          <MovePicker
            key={`${row.kind}:${row.id}`}
            row={row}
            onCancel={() => onOpenChange(false)}
            onMoved={onMoved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MovePicker({
  row,
  onCancel,
  onMoved,
}: {
  row: DriveRow
  onCancel: () => void
  onMoved: (folder: string) => void
}) {
  const { t, locale } = useI18n()
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const serverUrl = activeAccount?.serverUrl ?? null
  const source = driveParent(row.path)
  const [browse, setBrowse] = useState(source)
  const [listing, setListing] = useState<{ path: string; folders: DriveFolderView[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const load = useCallback(
    async (path: string) => {
      if (!serverUrl) return
      setLoadError(null)
      try {
        const tok = await getFreshAccessToken()
        const res = await listDriveEntries(serverUrl, tok, path, { limit: 1 })
        setListing({ path, folders: res.folders })
      } catch (err) {
        setLoadError(driveErrorMessage(err, t))
      }
    },
    [getFreshAccessToken, serverUrl, t]
  )

  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (alive) void load(browse)
    })
    return () => {
      alive = false
    }
  }, [browse, load])

  const folders = useMemo(
    () => (listing?.path === browse ? driveRows({ folders: listing.folders, files: [] }, locale) : null),
    [browse, listing, locale]
  )
  // Nothing goes into Orches' workspace, and a folder never into itself.
  const blocked = (path: string) => isOrchesPath(path) || (row.kind === "folder" && isWithinDrivePath(path, row.path))
  const canMoveHere = browse !== source && !blocked(browse)
  const name = driveBasename(row.path)
  const shownName = row.kind === "file" && row.nameHidden ? t("drive.encryptedFile") : name

  const submit = async () => {
    if (!serverUrl || !canMoveHere) return
    setPending(true)
    setError(null)
    try {
      const tok = await getFreshAccessToken()
      const target = driveJoin(browse, name)
      if (row.kind === "folder") await moveDriveFolder(serverUrl, tok, row.id, target)
      else await moveDriveFile(serverUrl, tok, row.id, target)
      onMoved(browse)
    } catch (err) {
      setError(driveErrorMessage(err, t, name))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-6">
      <DialogHeader>
        <DialogTitle>{t("drive.moveTitle", { name: shownName })}</DialogTitle>
        <DialogDescription>{t("drive.moveDesc")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <DriveBreadcrumbs path={browse} onNavigate={setBrowse} />
        <div className="h-64 overflow-y-auto rounded-2xl bg-background p-1.5">
          {loadError ? (
            <p className="p-3 text-sm text-destructive">{loadError}</p>
          ) : !folders ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          ) : folders.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("drive.moveNoFolders")}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {folders.map((folder) => {
                const disabled = blocked(folder.path)
                const Icon =
                  folder.kind === "folder" && folder.system === "transfers"
                    ? FolderSymlinkIcon
                    : folder.kind === "folder" && folder.system === "orches"
                      ? FolderSyncIcon
                      : FolderIcon
                return (
                  <li key={folder.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setBrowse(folder.path)}
                      className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-full px-3 text-left text-sm outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{driveFolderLabel(folder.path, folder.name, t)}</span>
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" disabled={!canMoveHere || pending} onClick={() => void submit()}>
          {t("drive.moveHere")}
        </Button>
      </DialogFooter>
    </div>
  )
}
