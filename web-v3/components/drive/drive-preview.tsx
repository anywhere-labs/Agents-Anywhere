"use client"

// A drive file's preview (in a dialog over the list): its name and actions, its details (size, modified, expiry, reference),
// and a preview read straight from object storage through a presigned link. Images and PDFs show inline, text and
// code highlighted, Markdown rendered (with a source toggle); encrypted files (the server holds ciphertext only),
// large files and other kinds get a download instead.

import { useEffect, useMemo, useState } from "react"
import { DownloadIcon, FileIcon, LoaderCircleIcon, LockIcon } from "lucide-react"

import { RowIcon, RowMenu, driveRowLabel, type DriveRowHandlers } from "@/components/drive/drive-entry-list"
import { driveErrorMessage } from "@/components/drive/drive-labels"
import { Markdown } from "@/components/conversation/markdown"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { HighlightedText, IMAGE_EXT, MD_EXT, PDF_EXT, languageForPath } from "@/components/workbench/file-browser"
import { fetchDriveDownloadUrl } from "@/lib/api/control-http"
import { driveExpiry, formatDriveTime, type DriveRow } from "@/lib/drive/entries"
import { useWorkbench } from "@/lib/state/workbench-context"
import { formatSize } from "@/lib/workbench/time"
import { cn } from "@/lib/utils"

type FileRow = Extract<DriveRow, { kind: "file" }>
type PreviewKind = "image" | "pdf" | "markdown" | "text"

const BINARY_MAX = 20 * 1024 * 1024
const TEXT_MAX = 1024 * 1024
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml))/

/** How a file of this name and type would be shown, whatever its size. */
function previewKindOf(row: FileRow): PreviewKind | null {
  const mime = row.file.mime_type ?? ""
  const name = row.name
  return mime.startsWith("image/") || IMAGE_EXT.test(name)
      ? "image"
      : mime === "application/pdf" || PDF_EXT.test(name)
        ? "pdf"
        : MD_EXT.test(name)
          ? "markdown"
          : TEXT_MIME.test(mime) || languageForPath(name) !== "text" || /\.(txt|log|csv|tsv)$/i.test(name)
            ? "text"
            : null
}

const previewLimit = (kind: PreviewKind) => (kind === "image" || kind === "pdf" ? BINARY_MAX : TEXT_MAX)

/** The largest file of this kind that is previewed. */
export const drivePreviewLimit = (row: FileRow) => previewLimit(previewKindOf(row) ?? "text")

/** How the file can be previewed, or why not. */
export function drivePreviewKind(row: FileRow): PreviewKind | "encrypted" | "tooLarge" | null {
  if (row.encrypted) return "encrypted"
  const kind = previewKindOf(row)
  if (!kind) return null
  return row.size > previewLimit(kind) ? "tooLarge" : kind
}

type Loaded = { id: string; blob?: Blob; text?: string; error?: string }

// file id + modified time → fetched content (a few recent ones), so going back to a file shows it at once.
const cache = new Map<string, Loaded>()
function remember(key: string, value: Loaded) {
  cache.set(key, value)
  if (cache.size > 12) cache.delete(cache.keys().next().value!)
}

export function DrivePreview({
  row,
  now,
  handlers,
  trailing,
  className,
}: {
  row: FileRow
  /** When the listing was loaded; the expiry reads relative to it. */
  now: number
  handlers: DriveRowHandlers
  /** After the actions (a close button). */
  trailing?: React.ReactNode
  className?: string
}) {
  const { t, locale } = useI18n()
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const serverUrl = activeAccount?.serverUrl ?? null
  const kind = drivePreviewKind(row)
  const fetchable = kind === "image" || kind === "pdf" || kind === "markdown" || kind === "text"
  const key = `${row.id}:${row.modifiedAt}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    if (!fetchable || !serverUrl) return
    const cached = cache.get(key)
    let alive = true
    queueMicrotask(() => {
      if (alive) setLoaded(cached ?? null)
    })
    if (cached && !cached.error) return
    void (async () => {
      try {
        const res = await fetchDriveDownloadUrl(serverUrl, await getFreshAccessToken(), row.id)
        const response = await fetch(res.download.url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const value: Loaded =
          kind === "image" || kind === "pdf"
            ? { id: key, blob: await response.blob() }
            : { id: key, text: await response.text() }
        remember(key, value)
        if (alive) setLoaded(value)
      } catch (err) {
        if (alive) setLoaded({ id: key, error: driveErrorMessage(err, t, row.name) })
      }
    })()
    return () => {
      alive = false
    }
  }, [fetchable, getFreshAccessToken, key, kind, row.id, row.name, serverUrl, t])

  const shown = loaded?.id === key ? loaded : null
  const blobUrl = useMemo(() => {
    if (!shown?.blob) return null
    const type = kind === "pdf" ? "application/pdf" : row.file.mime_type || shown.blob.type
    return URL.createObjectURL(new Blob([shown.blob], { type }))
  }, [kind, row.file.mime_type, shown])
  useEffect(
    () => () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    },
    [blobUrl]
  )

  const label = driveRowLabel(row, t)
  const expiry = driveExpiry(row.expiresAt, locale, now)
  const download = (
    <Button variant="outline" size="sm" onClick={() => handlers.onDownload(row)}>
      <DownloadIcon className="size-3.5" />
      {t("drive.download")}
    </Button>
  )
  const noPreview = (text: string) => (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-background px-6 py-12 text-center">
      {kind === "encrypted" ? (
        <LockIcon className="size-6 text-muted-foreground" />
      ) : (
        <FileIcon className="size-6 text-muted-foreground" />
      )}
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      {download}
    </div>
  )

  let body: React.ReactNode
  if (kind === "encrypted") body = noPreview(t("drive.previewEncrypted"))
  else if (kind === "tooLarge")
    body = noPreview(t("drive.previewTooLarge", { limit: formatSize(drivePreviewLimit(row)) }))
  else if (kind === null) body = noPreview(t("drive.previewNone"))
  else if (shown?.error) body = noPreview(t("drive.previewFailed", { error: shown.error }))
  else if (!shown)
    body = (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    )
  else if (kind === "image" && blobUrl)
    // eslint-disable-next-line @next/next/no-img-element
    body = <img src={blobUrl} alt={label} className="mx-auto max-h-full max-w-full rounded-2xl object-contain" />
  else if (kind === "pdf" && blobUrl)
    body = <iframe src={blobUrl} title={label} className="h-full min-h-[60vh] w-full rounded-2xl bg-background" />
  else if (kind === "markdown" && !showSource)
    body = (
      <div className="rounded-2xl bg-background px-5 py-4 text-sm">
        <Markdown>{shown.text ?? ""}</Markdown>
      </div>
    )
  else if (languageForPath(row.name) === "text")
    // Plain text (notes, transcripts, logs) wraps; code keeps its lines.
    body = (
      <pre className="rounded-2xl bg-background px-4 py-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {shown.text}
      </pre>
    )
  else body = <HighlightedText text={shown.text ?? ""} path={row.name} />

  const meta = [
    formatSize(row.size),
    formatDriveTime(row.modifiedAt, locale, now),
    expiry.expired ? t("drive.expired") : t("drive.expiresIn", { when: expiry.label }),
  ]

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <RowIcon row={row} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={row.path}>
          {label}
        </h2>
        {kind === "markdown" && shown?.text !== undefined && (
          <Button variant="ghost" size="xs" onClick={() => setShowSource((v) => !v)}>
            {showSource ? t("panel.rendered") : t("panel.source")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("drive.downloadName", { name: label })}
          onClick={() => handlers.onDownload(row)}
        >
          <DownloadIcon className="size-3.5" />
        </Button>
        <RowMenu row={row} label={label} handlers={handlers} />
        {trailing}
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums">
        {meta.map((part, index) => (
          <span key={index} className={cn(index === 2 && expiry.soon && "text-destructive")} title={index === 2 ? expiry.title : undefined}>
            {index > 0 && <span className="mr-1.5">·</span>}
            {part}
          </span>
        ))}
        {row.encrypted && (
          <span className="flex items-center gap-1">
            <span className="mr-0.5">·</span>
            <LockIcon className="size-3" />
            {t("drive.encrypted")}
          </span>
        )}
      </p>
      {row.nameHidden && <p className="truncate font-mono text-xs text-muted-foreground">{row.name}</p>}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  )
}
