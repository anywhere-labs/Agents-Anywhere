"use client"

// The drive page (docs/v3/client-experience-proposal.md §2.6): one folder of the account's cloud drive at a time,
// laid out like a file manager — breadcrumbs, folders then files with size, modified time and expiry, and per-row
// actions (open, download, rename, move, copy the `drive:/…` reference, delete). Uploads go into the open folder
// (button, or drop files on the page). Orches' workspace (/Orches) is listed read-only apart from deletes.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react"
import {
  CircleAlertIcon,
  CloudOffIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSyncIcon,
  FolderXIcon,
  LinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { EmptyState, PageContainer, PageHeader } from "@/components/console/page-header"
import { DriveBreadcrumbs } from "@/components/drive/drive-breadcrumbs"
import { DriveEntryTable, type DriveRowHandlers } from "@/components/drive/drive-entry-table"
import { driveErrorMessage, driveFolderLabel, driveUploadRejection } from "@/components/drive/drive-labels"
import { DriveMoveDialog } from "@/components/drive/drive-move-dialog"
import { DriveNameDialog } from "@/components/drive/drive-name-dialog"
import { DriveUploadList, useDriveUploads } from "@/components/drive/drive-uploads"
import { Notice } from "@/components/field"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ControlApiError,
  createDriveFolder,
  deleteDriveFile,
  deleteDriveFolder,
  fetchDriveDownloadUrl,
  listDriveEntries,
  moveDriveFile,
  moveDriveFolder,
} from "@/lib/api/control-http"
import {
  appendDrivePage,
  canWriteInto,
  driveRows,
  formatDriveDuration,
  planDriveUpload,
  type DriveRow,
} from "@/lib/drive/entries"
import { DRIVE_ROOT, driveBasename, driveJoin, driveParent, isOrchesPath } from "@/lib/drive/paths"
import { useWorkbench } from "@/lib/state/workbench-context"
import type { DriveEntriesResponse, DriveQuotaView } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/workbench/time"

/** Files fetched per page (the server's maximum); "show more" fetches the next page. */
const PAGE_SIZE = 1000

/** Listing errors that mean "this folder is not there" rather than "something went wrong". */
const MISSING_FOLDER = new Set(["drive_path_not_found", "drive_not_a_folder", "drive_invalid_path"])

type Loaded = { path: string; listing?: DriveEntriesResponse; error?: unknown; at: number }
type NameRequest = { mode: "create" } | { mode: "rename"; row: DriveRow }

/**
 * A dialog's subject, kept while the dialog animates closed so its content does not blank out. `key` changes with
 * every opening, so a dialog reopened mid-animation still starts fresh.
 */
function useDialogSubject<T>() {
  const [state, setState] = useState<{ subject: T | null; open: boolean; key: number }>({
    subject: null,
    open: false,
    key: 0,
  })
  const show = useCallback((subject: T) => setState((s) => ({ subject, open: true, key: s.key + 1 })), [])
  const hide = useCallback(() => setState((s) => ({ ...s, open: false })), [])
  return { ...state, show, hide }
}

const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files")

export function DriveBrowser({
  path,
  highlight = null,
  onNavigate,
}: {
  path: string
  /** A file of the folder to point out (by id), e.g. one a reply linked to. */
  highlight?: string | null
  onNavigate: (path: string) => void
}) {
  const { t, locale } = useI18n()
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const serverUrl = activeAccount?.serverUrl ?? null

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [quota, setQuota] = useState<DriveQuotaView | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const nameDialog = useDialogSubject<NameRequest>()
  const moveDialog = useDialogSubject<DriveRow>()
  const deleteDialog = useDialogSubject<DriveRow>()
  const fileInput = useRef<HTMLInputElement>(null)
  const loadSeq = useRef(0)
  // How many files of the folder are shown: a reload (after an upload or a delete) fetches as many again, so "show
  // more" is not undone by the next change.
  const shown = useRef<{ path: string; count: number }>({ path: "", count: 0 })
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    if (!serverUrl) return
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const tok = await getFreshAccessToken()
      const want = shown.current.path === path ? shown.current.count : 0
      let listing = await listDriveEntries(serverUrl, tok, path, { limit: PAGE_SIZE })
      while (listing.files.length < Math.min(want, listing.total_files)) {
        const next = await listDriveEntries(serverUrl, tok, path, { limit: PAGE_SIZE, offset: listing.files.length })
        if (next.files.length === 0) break
        listing = appendDrivePage(listing, next)
      }
      if (seq !== loadSeq.current) return
      shown.current = { path, count: listing.files.length }
      setLoaded({ path, listing, at: Date.now() })
      setQuota(listing.quota)
    } catch (error) {
      if (seq !== loadSeq.current) return
      setLoaded({ path, error, at: Date.now() })
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [getFreshAccessToken, path, serverUrl])

  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [load])

  // A listing of another folder (the one just left) is never shown for this one.
  const current = loaded?.path === path ? loaded : null
  const listing = current?.listing

  const loadMore = async () => {
    if (!serverUrl || !listing || loadingMore) return
    const seq = loadSeq.current
    setLoadingMore(true)
    try {
      const tok = await getFreshAccessToken()
      const next = await listDriveEntries(serverUrl, tok, path, { limit: PAGE_SIZE, offset: listing.files.length })
      // A reload or another folder since: its listing stands.
      if (seq !== loadSeq.current) return
      const merged = appendDrivePage(listing, next)
      shown.current = { path, count: merged.files.length }
      setLoaded({ path, listing: merged, at: Date.now() })
      setQuota(next.quota)
    } catch (error) {
      toast.error(driveErrorMessage(error, t))
    } finally {
      setLoadingMore(false)
    }
  }
  const loadError = current?.error
  const rows = useMemo(() => (listing ? driveRows(listing, locale) : []), [listing, locale])
  const enabled = quota?.enabled ?? null
  const writable = enabled === true && canWriteInto(path) && !loadError
  const folderLabel = driveFolderLabel(path, driveBasename(path), t)

  const uploads = useDriveUploads({
    serverUrl,
    getToken: getFreshAccessToken,
    onUploaded: () => void load(),
    describeError: (err) => driveErrorMessage(err, t),
  })

  const startUploads = (files: readonly File[]) => {
    let reserved = uploads.pendingBytes
    const accepted: File[] = []
    for (const file of files) {
      const plan = planDriveUpload(file.size, quota, reserved)
      if (!plan.ok) {
        toast.error(driveUploadRejection(plan, file.name, t))
        continue
      }
      reserved += file.size
      accepted.push(file)
    }
    uploads.enqueue(accepted, path)
  }

  const copyRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref)
      toast.success(t("drive.refCopied"), { description: ref })
    } catch {
      toast.error(t("common.copyFailed"))
    }
  }

  const download = async (row: DriveRow) => {
    if (row.kind !== "file" || !serverUrl) return
    try {
      const tok = await getFreshAccessToken()
      const res = await fetchDriveDownloadUrl(serverUrl, tok, row.id)
      // The presigned link answers with "Content-Disposition: attachment", so the browser saves the file.
      const link = document.createElement("a")
      link.href = res.download.url
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      link.click()
    } catch (err) {
      toast.error(driveErrorMessage(err, t, row.name))
    }
  }

  const handlers: DriveRowHandlers = {
    onOpen: (row) => {
      if (row.kind === "folder") onNavigate(row.path)
    },
    onDownload: (row) => void download(row),
    onRename: (row) => nameDialog.show({ mode: "rename", row }),
    onMove: (row) => moveDialog.show(row),
    onCopyRef: (row) => void copyRef(row.ref),
    onDelete: (row) => deleteDialog.show(row),
  }

  /** New folder or rename; throws to keep the dialog open with the error. */
  const submitName = async (name: string) => {
    const request = nameDialog.subject
    if (!serverUrl || !request) return
    const tok = await getFreshAccessToken()
    if (request.mode === "create") {
      await createDriveFolder(serverUrl, tok, driveJoin(path, name))
      toast.success(t("drive.folderCreated", { name }))
    } else {
      const { row } = request
      const target = driveJoin(driveParent(row.path), name)
      if (target !== row.path) {
        if (row.kind === "folder") await moveDriveFolder(serverUrl, tok, row.id, target)
        else await moveDriveFile(serverUrl, tok, row.id, target)
        toast.success(t("drive.renamed", { name }))
      }
    }
    nameDialog.hide()
    await load()
  }

  const toDelete = deleteDialog.subject
  const confirmDelete = async () => {
    if (!serverUrl || !toDelete) return
    setDeleting(true)
    try {
      const tok = await getFreshAccessToken()
      if (toDelete.kind === "folder") {
        const res = await deleteDriveFolder(serverUrl, tok, toDelete.id)
        toast.success(
          res.deleted_files > 0
            ? t("drive.deletedFolderFiles", { count: res.deleted_files })
            : t("drive.deletedFolder")
        )
      } else {
        await deleteDriveFile(serverUrl, tok, toDelete.id)
        toast.success(t("drive.deletedFile"))
      }
      deleteDialog.hide()
      await load()
    } catch (err) {
      toast.error(driveErrorMessage(err, t))
    } finally {
      setDeleting(false)
    }
  }
  const deleteName = !toDelete
    ? ""
    : toDelete.kind === "folder"
      ? driveFolderLabel(toDelete.path, toDelete.name, t)
      : toDelete.nameHidden
        ? t("drive.encryptedFile")
        : toDelete.name
  const deleteNote = !toDelete
    ? null
    : toDelete.kind === "folder" && toDelete.system === "transfers"
      ? t("drive.deleteTransfersNote")
      : isOrchesPath(toDelete.path)
        ? t("drive.deleteOrchesNote")
        : null

  const usage = quota?.enabled
    ? [
        quota.quota_bytes != null
          ? t("drive.usage", { used: formatSize(quota.used_bytes), quota: formatSize(quota.quota_bytes) })
          : t("drive.usageUnlimited", { used: formatSize(quota.used_bytes) }),
        t("drive.retention", { duration: formatDriveDuration(quota.default_ttl_seconds, locale) }),
      ].join(" · ")
    : null

  const dropProps = writable
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!isFileDrag(event)) return
          event.preventDefault()
          setDragDepth((depth) => depth + 1)
        },
        onDragOver: (event: DragEvent) => {
          if (!isFileDrag(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        },
        onDragLeave: (event: DragEvent) => {
          if (!isFileDrag(event)) return
          setDragDepth((depth) => Math.max(0, depth - 1))
        },
        onDrop: (event: DragEvent) => {
          if (!isFileDrag(event)) return
          event.preventDefault()
          setDragDepth(0)
          startUploads(Array.from(event.dataTransfer.files))
        },
      }
    : {}

  const uploadButton = (variant: "default" | "outline") => (
    <Button variant={variant} size="sm" onClick={() => fileInput.current?.click()}>
      <UploadIcon className="size-4" />
      {t("drive.upload")}
    </Button>
  )

  let body: ReactNode
  if (enabled === false) {
    body = <EmptyState icon={CloudOffIcon} title={t("drive.disabledTitle")} description={t("drive.disabledDesc")} />
  } else if (loadError) {
    body =
      loadError instanceof ControlApiError && MISSING_FOLDER.has(loadError.code) ? (
        <EmptyState
          icon={FolderXIcon}
          title={t("drive.notFoundTitle")}
          description={t("drive.notFoundDesc")}
          action={
            <Button variant="outline" size="sm" onClick={() => onNavigate(DRIVE_ROOT)}>
              {t("drive.backToRoot")}
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={CircleAlertIcon}
          title={t("drive.loadFailed")}
          description={driveErrorMessage(loadError, t)}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("common.refresh")}
            </Button>
          }
        />
      )
  } else if (!listing) {
    body = (
      <div className="flex flex-col gap-2 py-2" aria-busy="true" aria-label={t("common.loading")}>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-2xl" />
        ))}
      </div>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={FolderOpenIcon}
        title={path === DRIVE_ROOT ? t("drive.rootEmptyTitle") : t("drive.emptyTitle")}
        description={
          isOrchesPath(path)
            ? t("drive.emptyOrches")
            : path === DRIVE_ROOT
              ? t("drive.rootEmptyDesc")
              : t("drive.emptyDesc")
        }
        action={writable ? uploadButton("outline") : undefined}
      />
    )
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <DriveEntryTable rows={rows} now={current?.at ?? 0} highlight={highlight} handlers={handlers} />
        {listing.files.length < listing.total_files && (
          <div className="flex items-center gap-3 px-2">
            <p className="text-sm text-muted-foreground">
              {t("drive.moreFiles", { shown: listing.files.length, total: listing.total_files })}
            </p>
            <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore && <LoaderCircleIcon className="size-3.5 animate-spin" />}
              {t("drive.showMore")}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const renaming = nameDialog.subject?.mode === "rename" ? nameDialog.subject.row : null

  return (
    <PageContainer className="min-h-full" {...dropProps}>
      <PageHeader
        title={t("drive.title")}
        description={usage ?? t("drive.description")}
        actions={
          enabled ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("common.refresh")}
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
              </Button>
              {writable && (
                <>
                  <Button variant="outline" size="sm" onClick={() => nameDialog.show({ mode: "create" })}>
                    <FolderPlusIcon className="size-4" />
                    {t("drive.newFolder")}
                  </Button>
                  {uploadButton("default")}
                </>
              )}
            </>
          ) : undefined
        }
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          startUploads(Array.from(event.target.files ?? []))
          event.target.value = ""
        }}
      />

      <DriveUploadList items={uploads.items} onCancel={uploads.cancel} onDismiss={uploads.dismissFinished} />

      <section aria-label={folderLabel} className="relative flex flex-col gap-4 rounded-card bg-card p-4 sm:p-6">
        {enabled !== false && (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <DriveBreadcrumbs path={path} onNavigate={onNavigate} className="flex-1" />
            {listing && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("drive.copyFolderRef")}
                title={listing.ref}
                onClick={() => void copyRef(listing.ref)}
              >
                <LinkIcon className="size-4" />
              </Button>
            )}
          </div>
        )}
        {enabled && isOrchesPath(path) && <Notice icon={<FolderSyncIcon />}>{t("drive.orchesNotice")}</Notice>}
        {body}
        {dragDepth > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-card border-2 border-dashed border-border-strong bg-background/85 px-6 text-center text-sm font-medium text-foreground">
            {t("drive.dropHere", { folder: folderLabel })}
          </div>
        )}
      </section>

      <DriveNameDialog
        key={`name-${nameDialog.key}`}
        open={nameDialog.open}
        onOpenChange={(open) => {
          if (!open) nameDialog.hide()
        }}
        title={renaming ? t("drive.renameTitle") : t("drive.newFolderTitle")}
        description={renaming ? undefined : t("drive.newFolderIn", { folder: folderLabel })}
        label={renaming ? t("drive.newName") : t("drive.folderName")}
        submitLabel={renaming ? t("drive.renameSubmit") : t("common.create")}
        initialName={renaming?.name ?? ""}
        selectStem={renaming?.kind === "file"}
        onSubmit={submitName}
      />

      <DriveMoveDialog
        key={`move-${moveDialog.key}`}
        row={moveDialog.subject}
        open={moveDialog.open}
        onOpenChange={(open) => {
          if (!open) moveDialog.hide()
        }}
        onMoved={(folder) => {
          moveDialog.hide()
          toast.success(t("drive.moved", { folder: driveFolderLabel(folder, driveBasename(folder), t) }))
          void load()
        }}
      />

      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={(open) => {
          if (!open && !deleting) deleteDialog.hide()
        }}
        title={
          toDelete?.kind === "folder"
            ? t("drive.deleteFolderTitle", { name: deleteName })
            : t("drive.deleteFileTitle", { name: deleteName })
        }
        description={toDelete?.kind === "folder" ? t("drive.deleteFolderDesc") : t("drive.deleteFileDesc")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={deleting}
        onConfirm={() => void confirmDelete()}
      >
        {deleteNote && <p className="text-sm text-muted-foreground">{deleteNote}</p>}
      </ConfirmDialog>
    </PageContainer>
  )
}
