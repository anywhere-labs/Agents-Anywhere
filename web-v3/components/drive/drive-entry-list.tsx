"use client"

import { useCallback } from "react"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { driveExpiry, driveRowActions, formatDriveTime, type DriveRow } from "@/lib/drive/entries"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/workbench/time"

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

function RowIcon({ row }: { row: DriveRow }) {
  const className = "size-5 shrink-0 stroke-[1.5] text-muted-foreground"
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

function RowMenu({ row, label, handlers }: { row: DriveRow; label: string; handlers: DriveRowHandlers }) {
  const { t } = useI18n()
  const actions = driveRowActions(row)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={t("drive.moreActions", { name: label })} />}
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

/** Folders and files of one folder, as a file manager list: name, size, modified, expires, actions. */
export function DriveEntryTable({
  rows,
  now,
  highlight = null,
  handlers,
}: {
  rows: readonly DriveRow[]
  /** When the listing was loaded; expiries read relative to it. */
  now: number
  /** A file to point out (by id): selected and scrolled into view. */
  highlight?: string | null
  handlers: DriveRowHandlers
}) {
  const { t, locale } = useI18n()
  // Stable per file, so the row scrolls into view when it appears, not on every render after.
  const scrollIntoView = useCallback(
    (row: HTMLTableRowElement | null) => {
      if (highlight) row?.scrollIntoView({ block: "center" })
    },
    [highlight]
  )
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-muted-foreground">{t("drive.colName")}</TableHead>
          <TableHead className="hidden w-28 text-right text-muted-foreground sm:table-cell">
            {t("drive.colSize")}
          </TableHead>
          <TableHead className="hidden w-44 text-muted-foreground md:table-cell">{t("drive.colModified")}</TableHead>
          <TableHead className="hidden w-32 text-muted-foreground sm:table-cell">{t("drive.colExpires")}</TableHead>
          <TableHead className="w-24">
            <span className="sr-only">{t("drive.colActions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const label =
            row.kind === "folder"
              ? driveFolderLabel(row.path, row.name, t)
              : row.nameHidden
                ? t("drive.encryptedFile")
                : row.name
          const expiry = row.kind === "file" ? driveExpiry(row.expiresAt, locale, now) : null
          const expiryLabel = expiry ? (expiry.expired ? t("drive.expired") : expiry.label) : "—"
          const actions = driveRowActions(row)
          const highlighted = row.kind === "file" && row.id === highlight
          return (
            <TableRow
              key={`${row.kind}:${row.id}`}
              ref={highlighted ? scrollIntoView : undefined}
              data-state={highlighted ? "selected" : undefined}
              className={cn("h-14", row.kind === "folder" && "cursor-pointer")}
              onClick={row.kind === "folder" ? () => handlers.onOpen(row) : undefined}
            >
              <TableCell className="w-full max-w-0">
                <div className="flex min-w-0 items-center gap-3">
                  <RowIcon row={row} />
                  <div className="min-w-0">
                    {row.kind === "folder" ? (
                      <button
                        type="button"
                        title={row.path}
                        className="block max-w-full truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={(event) => {
                          event.stopPropagation()
                          handlers.onOpen(row)
                        }}
                      >
                        {label}
                      </button>
                    ) : (
                      <p title={row.path} className="truncate text-sm text-foreground">
                        {label}
                      </p>
                    )}
                    {row.kind === "file" && row.nameHidden && (
                      <p className="truncate font-mono text-sm text-muted-foreground">{row.name}</p>
                    )}
                    {row.kind === "file" && (
                      <p className="truncate text-xs tabular-nums text-muted-foreground sm:hidden">
                        {formatSize(row.size)} · {expiryLabel}
                      </p>
                    )}
                  </div>
                  {row.kind === "file" && row.encrypted && (
                    <LockIcon aria-label={t("drive.encrypted")} className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </div>
              </TableCell>
              <TableCell className="hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
                {row.kind === "file" ? formatSize(row.size) : "—"}
              </TableCell>
              <TableCell className="hidden text-xs tabular-nums text-muted-foreground md:table-cell">
                {formatDriveTime(row.modifiedAt, locale, now)}
              </TableCell>
              <TableCell className="hidden text-xs tabular-nums sm:table-cell">
                <span
                  title={expiry?.title}
                  className={expiry?.soon ? "text-warning" : "text-muted-foreground"}
                >
                  {expiryLabel}
                </span>
              </TableCell>
              <TableCell onClick={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-end gap-0.5">
                  {actions.download && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("drive.downloadName", { name: label })}
                      onClick={() => handlers.onDownload(row)}
                    >
                      <DownloadIcon className="size-4" />
                    </Button>
                  )}
                  <RowMenu row={row} label={label} handlers={handlers} />
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
