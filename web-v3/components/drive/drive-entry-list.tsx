"use client"

import {
  DownloadIcon,
  EllipsisIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileLockIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderSymlinkIcon,
  FolderSyncIcon,
  LinkIcon,
  LockIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react"

import { driveFolderLabel } from "@/components/drive/drive-labels"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { driveExpiry, driveRowActions, formatDriveTime, type DriveRow } from "@/lib/drive/entries"
import { formatSize } from "@/lib/workbench/time"
import { cn } from "@/lib/utils"

export interface DriveRowHandlers {
  onOpen: (row: DriveRow) => void
  onDownload: (row: DriveRow) => void
  onRename: (row: DriveRow) => void
  onMove: (row: DriveRow) => void
  onCopyRef: (row: DriveRow) => void
  onDelete: (row: DriveRow) => void
}

const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar)$/i
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cpp|cs|php|sh|zsh|json|ya?ml|toml|xml|html|css|scss|sql)$/i
const SHEET = /\.(csv|tsv|xlsx?|numbers|ods)$/i
const TEXT = /\.(txt|md|markdown|mdx|pdf|docx?|rtf|odt|pages|log)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic|ico)$/i
const VIDEO = /\.(mp4|mov|webm|mkv|avi|m4v)$/i
const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i

export function RowIcon({ row }: { row: DriveRow }) {
  const className = "size-4 shrink-0 text-muted-foreground"
  if (row.kind === "folder") {
    if (row.system === "transfers") return <FolderSymlinkIcon className={className} />
    if (row.system === "orches") return <FolderSyncIcon className={className} />
    return <FolderIcon className={className} />
  }
  if (row.nameHidden) return <FileLockIcon className={className} />
  const mime = row.file.mime_type ?? ""
  const name = row.name
  if (mime.startsWith("image/") || IMAGE.test(name)) return <FileImageIcon className={className} />
  if (mime.startsWith("video/") || VIDEO.test(name)) return <FileVideoIcon className={className} />
  if (mime.startsWith("audio/") || AUDIO.test(name)) return <FileAudioIcon className={className} />
  if (ARCHIVE.test(name)) return <FileArchiveIcon className={className} />
  if (SHEET.test(name)) return <FileSpreadsheetIcon className={className} />
  if (CODE.test(name)) return <FileCodeIcon className={className} />
  if (mime.startsWith("text/") || TEXT.test(name)) return <FileTextIcon className={className} />
  return <FileIcon className={className} />
}

export function RowMenu({ row, label, handlers }: { row: DriveRow; label: string; handlers: DriveRowHandlers }) {
  const { t } = useI18n()
  const actions = driveRowActions(row)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={t("drive.moreActions", { name: label })} />}
      >
        <EllipsisIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {actions.open && (
          <DropdownMenuItem onClick={() => handlers.onOpen(row)}>
            <FolderOpenIcon />
            {t("drive.open")}
          </DropdownMenuItem>
        )}
        {row.kind === "file" && (
          <DropdownMenuItem disabled={!actions.download} onClick={() => handlers.onDownload(row)}>
            <DownloadIcon />
            {t("drive.download")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!actions.rename} onClick={() => handlers.onRename(row)}>
          <PencilIcon />
          {t("drive.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!actions.move} onClick={() => handlers.onMove(row)}>
          <FolderInputIcon />
          {t("drive.move")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handlers.onCopyRef(row)}>
          <LinkIcon />
          {t("drive.copyRef")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => handlers.onDelete(row)}>
          <Trash2Icon />
          {t("common.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A row's label: system folders by their role, files the server cannot name as "encrypted file". */
export function driveRowLabel(row: DriveRow, t: ReturnType<typeof useI18n>["t"]): string {
  if (row.kind === "folder") return driveFolderLabel(row.path, row.name, t)
  return row.nameHidden ? t("drive.encryptedFile") : row.name
}

/**
 * Folders and files of one folder as a plain list (no frame): icon, name, size, modified, expiry, and the row's
 * actions. A folder opens on click, a file its page.
 */
export function DriveEntryList({
  rows,
  now,
  onOpenFile,
  handlers,
}: {
  rows: readonly DriveRow[]
  /** When the listing was loaded; expiries read relative to it. */
  now: number
  onOpenFile: (row: DriveRow) => void
  handlers: DriveRowHandlers
}) {
  const { t, locale } = useI18n()
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((row) => {
        const label = driveRowLabel(row, t)
        const expiry = row.kind === "file" ? driveExpiry(row.expiresAt, locale, now) : null
        return (
          <li key={`${row.kind}:${row.id}`} className="group/row relative">
            <button
              type="button"
              title={row.path}
              onClick={() => (row.kind === "folder" ? handlers.onOpen(row) : onOpenFile(row))}
              className="flex h-12 w-full min-w-0 items-center gap-3 pr-10 pl-1 text-left text-sm transition-colors hover:bg-surface-hover/60"
            >
              <RowIcon row={row} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {row.kind === "file" && row.encrypted && (
                <LockIcon aria-label={t("drive.encrypted")} className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                {row.kind === "file" ? formatSize(row.size) : ""}
              </span>
              <span className="hidden w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground md:block">
                {row.kind === "file" ? formatDriveTime(row.modifiedAt, locale, now) : ""}
              </span>
              <span
                title={expiry?.title}
                className={cn(
                  "w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground",
                  expiry?.soon && "text-destructive"
                )}
              >
                {expiry ? (expiry.expired ? t("drive.expired") : expiry.label) : ""}
              </span>
            </button>
            <div className="absolute top-1/2 right-0 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-popup-open]]:opacity-100 max-md:opacity-100">
              <RowMenu row={row} label={label} handlers={handlers} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
