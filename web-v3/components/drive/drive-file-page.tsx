"use client"

// One drive file's page (the drive's `?file=<id>`): its name, download and preview (the preview opens in a window),
// the other actions behind ⋯, and its details: size, type, modified, expiry, encryption and its `drive:/…` reference.

import { CopyIcon, DownloadIcon, EyeIcon } from "lucide-react"

import { DetailList, type DetailItem } from "@/components/console/detail-list"
import { RowIcon, RowMenu, driveRowLabel, type DriveRowHandlers } from "@/components/drive/drive-entry-list"
import { drivePreviewKind, drivePreviewLimit } from "@/components/drive/drive-preview"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { driveExpiry, formatDriveTime, type DriveRow } from "@/lib/drive/entries"
import { formatSize } from "@/lib/workbench/time"
import { cn } from "@/lib/utils"

type FileRow = Extract<DriveRow, { kind: "file" }>

export function DriveFilePage({
  row,
  now,
  handlers,
  onPreview,
}: {
  row: FileRow
  /** When the file was loaded; the expiry reads relative to it. */
  now: number
  handlers: DriveRowHandlers
  onPreview: () => void
}) {
  const { t, locale } = useI18n()
  const label = driveRowLabel(row, t)
  const kind = drivePreviewKind(row)
  const canPreview = kind !== null && kind !== "encrypted" && kind !== "tooLarge"
  const expiry = driveExpiry(row.expiresAt, locale, now)
  const why =
    kind === "encrypted"
      ? t("drive.previewEncrypted")
      : kind === "tooLarge"
        ? t("drive.previewTooLarge", { limit: formatSize(drivePreviewLimit(row)) })
        : kind === null
          ? t("drive.previewNone")
          : null

  const items: DetailItem[] = [
    { key: "size", label: t("drive.fileSize"), value: formatSize(row.size) },
    ...(row.file.mime_type ? [{ key: "type", label: t("drive.fileType"), value: row.file.mime_type }] : []),
    { key: "modified", label: t("drive.fileModified"), value: formatDriveTime(row.modifiedAt, locale, now) },
    {
      key: "expires",
      label: t("drive.fileExpires"),
      value: (
        <span className={cn(expiry.soon && "text-destructive")}>
          {expiry.expired ? t("drive.expired") : `${expiry.label} · ${expiry.title}`}
        </span>
      ),
    },
    ...(row.encrypted ? [{ key: "e2ee", label: t("drive.encrypted"), value: t("drive.fileEncryptedValue") }] : []),
    {
      key: "ref",
      label: t("drive.fileRef"),
      description: t("drive.fileRefHint"),
      value: (
        <span className="flex max-w-full items-center gap-1 sm:max-w-80">
          <code className="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground" title={row.ref}>
            {row.ref}
          </code>
          <Button variant="ghost" size="icon-xs" aria-label={t("drive.copyRef")} onClick={() => handlers.onCopyRef(row)}>
            <CopyIcon className="size-3.5" />
          </Button>
        </span>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6 pt-4">
      <div className="flex flex-col gap-4 border-b border-border pb-6">
        <div className="flex min-w-0 items-center gap-3">
          <RowIcon row={row} />
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" title={row.path}>
            {label}
          </h2>
          <RowMenu row={row} label={label} handlers={handlers} />
        </div>
        {row.nameHidden && <p className="-mt-2 truncate font-mono text-xs text-muted-foreground">{row.name}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => handlers.onDownload(row)}>
            <DownloadIcon className="size-4" />
            {t("drive.download")}
          </Button>
          <Button variant="outline" size="sm" disabled={!canPreview} onClick={onPreview}>
            <EyeIcon className="size-4" />
            {t("drive.preview")}
          </Button>
        </div>
        {why && <p className="text-xs text-muted-foreground">{why}</p>}
      </div>
      <DetailList items={items} />
    </div>
  )
}
