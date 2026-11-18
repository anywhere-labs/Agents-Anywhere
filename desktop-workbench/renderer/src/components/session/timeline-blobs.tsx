"use client"

// Content a v3 device kept out of a timeline item (`blobRefs`): one row per stored field, loaded on demand through
// the session's blob route. Text shows in full, images inline, anything else downloads.

import * as React from "react"
import { FileText, ImageIcon, Loader2, Package } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { dashboardApi } from "@/features/dashboard/api"
import {
  BLOB_READ_MAX_BYTES,
  SessionBlobError,
  blobKind,
  blobText,
  formatBlobBytes,
  timelineBlobRefs,
  type SessionBlobContent,
  type TimelineBlobKind,
  type TimelineBlobRef,
} from "@/features/dashboard/session-blobs"
import type { TimelineItem } from "@/features/dashboard/types"
import { ApiError } from "@/lib/api/errors"
import { copyText } from "@/lib/clipboard"
import { downloadBlob } from "@/lib/download"

type BlobState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "text"; text: string }
  | { status: "image"; url: string }
  | { status: "error"; message: string }

export function hasTimelineBlobs(item: TimelineItem): boolean {
  return timelineBlobRefs(item).length > 0
}

export function TimelineBlobs({
  token,
  sessionId,
  item,
}: {
  token: string
  sessionId: string
  item: TimelineItem
}) {
  const refs = timelineBlobRefs(item)
  if (refs.length === 0 || !token) return null
  return (
    <div className="mt-2 flex min-w-0 max-w-full flex-col gap-2" data-testid="timeline-blobs">
      {refs.map((ref) => (
        <TimelineBlobRow key={`${ref.path}:${ref.blobId}`} token={token} sessionId={sessionId} blobRef={ref} />
      ))}
    </div>
  )
}

function TimelineBlobRow({ token, sessionId, blobRef }: { token: string; sessionId: string; blobRef: TimelineBlobRef }) {
  const t = useTranslations("dashboard.session")
  const tCommon = useTranslations("common")
  const kind = blobKind(blobRef)
  const [state, setState] = React.useState<BlobState>({ status: "idle" })
  const urlRef = React.useRef<string | null>(null)

  React.useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  const errorText = React.useCallback((error: unknown): string => {
    if (error instanceof SessionBlobError && error.code === "blob_too_large") return t("blobTooLarge")
    if (error instanceof ApiError && error.code === "blob_not_found") return t("blobNotFound")
    if (error instanceof ApiError && error.code === "connector_offline") return t("blobDeviceOffline")
    return t("blobLoadFailed")
  }, [t])

  const load = React.useCallback(async () => {
    setState({ status: "loading" })
    let content: SessionBlobContent
    try {
      content = await dashboardApi.sessionBlob(token, sessionId, blobRef.blobId, { maxBytes: BLOB_READ_MAX_BYTES })
    } catch (error) {
      setState({ status: "error", message: errorText(error) })
      return
    }
    const mediaType = blobRef.mediaType || content.mediaType
    if (kind === "text") {
      setState({ status: "text", text: blobText(content) })
      return
    }
    const blob = new Blob([content.bytes], { type: mediaType })
    if (kind === "image") {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(blob)
      setState({ status: "image", url: urlRef.current })
      return
    }
    downloadBlob(blob, blobFileName(blobRef, mediaType))
    setState({ status: "idle" })
  }, [blobRef, errorText, kind, sessionId, token])

  const copy = async (text: string) => {
    try {
      await copyText(text)
      toast.success(tCommon("copied"))
    } catch {
      toast.error(tCommon("copyFailed"))
    }
  }

  const label = `${t(blobLabelKey(kind, blobRef.mediaType))} · ${formatBlobBytes(blobRef.bytes)}`
  const open = state.status === "text" || state.status === "image"
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <BlobIcon kind={kind} />
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={t("blobStoredOnDevice")}>
          {label}
        </span>
        {state.status === "text" ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => void copy(state.text)}>
            {tCommon("copy")}
          </Button>
        ) : null}
        {open ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setState({ status: "idle" })}>
            {t("blobCollapse")}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={state.status === "loading"} onClick={() => void load()}>
            {state.status === "loading" ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {t(kind === "text" ? "blobShowText" : kind === "image" ? "blobShowImage" : "blobDownload")}
          </Button>
        )}
      </div>
      {state.status === "error" ? <p className="text-destructive">{state.message}</p> : null}
      {state.status === "text" ? (
        <pre className="max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
          {state.text}
        </pre>
      ) : null}
      {state.status === "image" ? (
        <a href={state.url} target="_blank" rel="noreferrer" className="block w-fit max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.url} alt={label} className="block h-auto max-h-[360px] max-w-full rounded-md object-contain" />
        </a>
      ) : null}
    </div>
  )
}

function BlobIcon({ kind }: { kind: TimelineBlobKind }) {
  const className = "size-4 shrink-0 text-muted-foreground"
  if (kind === "text") return <FileText className={className} />
  if (kind === "image") return <ImageIcon className={className} />
  return <Package className={className} />
}

function blobLabelKey(kind: TimelineBlobKind, mediaType: string | null): "blobKindText" | "blobKindImage" | "blobKindAudio" | "blobKindFile" {
  if (kind === "text" || (mediaType ?? "").startsWith("text/")) return "blobKindText"
  if ((mediaType ?? "").startsWith("image/")) return "blobKindImage"
  if ((mediaType ?? "").startsWith("audio/")) return "blobKindAudio"
  return "blobKindFile"
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
  "application/json": "json",
}

function blobFileName(ref: TimelineBlobRef, mediaType: string): string {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
  const extension = base.startsWith("text/") ? "txt" : EXTENSIONS[base] ?? "bin"
  return `${ref.blobId.slice(0, 17)}.${extension}`
}
