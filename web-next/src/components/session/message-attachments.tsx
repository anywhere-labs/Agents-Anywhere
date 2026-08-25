"use client"

import { useEffect, useRef, useState } from "react"
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { ReconcileAttachment } from "@/features/dashboard/attachments"
import { dashboardApi } from "@/features/dashboard/api"
import type { SessionView } from "@/features/dashboard/types"
import { apiPath } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

type MessageAttachmentsProps = {
  token: string
  session: SessionView
  attachments: ReconcileAttachment[]
  align?: "left" | "right"
}

export function MessageAttachments({
  token,
  session,
  attachments,
  align = "left",
}: MessageAttachmentsProps) {
  const t = useTranslations("dashboard.new")
  if (attachments.length === 0) return null

  return (
    <AttachmentGroup
      aria-label={t("attach")}
      role="group"
      tabIndex={0}
      className={cn("w-full", align === "right" && "[&>[data-slot=attachment]:first-child]:ms-auto")}
    >
      {attachments.map((attachment) => (
        <MessageAttachmentItem
          key={attachment.fileId}
          token={token}
          session={session}
          attachment={attachment}
        />
      ))}
    </AttachmentGroup>
  )
}

function MessageAttachmentItem({
  token,
  session,
  attachment,
}: {
  token: string
  session: SessionView
  attachment: ReconcileAttachment
}) {
  const name = attachment.name || attachment.fileId
  const mediaType = attachment.mediaType || ""
  const sessionAttachmentUrl = attachmentOpenUrl(session.id, attachment.fileId, token)
  const presetUrl = attachment.openUrl || attachment.downloadUrl
  const shouldReadFromDevice = Boolean(attachment.path && !attachment.optimistic && !presetUrl)
  const deviceFile = useDeviceAttachmentFile({
    token,
    connectorId: session.connectorId,
    root: attachment.root || session.cwd || ".",
    path: shouldReadFromDevice ? attachment.path : undefined,
    fallbackName: name,
  })
  const openUrl = presetUrl || deviceFile.objectUrl || sessionAttachmentUrl
  const resolvedName = deviceFile.name || name
  const resolvedMediaType = deviceFile.mediaType || mediaType
  const resolvedSize = deviceFile.size ?? attachment.size
  const isImage = isImageAttachment(attachment)
  const [previewOpen, setPreviewOpen] = useState(false)

  if (shouldReadFromDevice && deviceFile.status === "loading") {
    return (
      <LoadingAttachment
        name={name}
        mediaType={mediaType}
        size={attachment.size}
        orientation={isImage ? "vertical" : "horizontal"}
      />
    )
  }

  if (shouldReadFromDevice && deviceFile.status === "error") {
    return (
      <FileAttachment
        attachment={attachment}
        name={name}
        mediaType={mediaType}
        state="error"
        statusText={deviceFile.error}
      />
    )
  }

  if (attachment.optimistic) {
    if (isImage && attachment.previewUrl) {
      return (
        <ImageAttachment
          name={resolvedName}
          mediaType={resolvedMediaType}
          size={attachment.size}
          src={attachment.previewUrl}
          previewOpen={previewOpen}
          setPreviewOpen={setPreviewOpen}
          state="uploading"
        />
      )
    }
    return (
      <FileAttachment
        attachment={attachment}
        name={resolvedName}
        mediaType={resolvedMediaType}
        state="uploading"
      />
    )
  }

  if (isImage) {
    return (
      <ImageAttachment
        name={resolvedName}
        mediaType={resolvedMediaType}
        size={resolvedSize}
        src={openUrl}
        previewOpen={previewOpen}
        setPreviewOpen={setPreviewOpen}
      />
    )
  }

  return (
    <FileAttachment
      attachment={attachment}
      name={resolvedName}
      mediaType={resolvedMediaType}
      openUrl={openUrl}
      size={resolvedSize}
    />
  )
}

type DeviceAttachmentFileState =
  | { status: "idle"; objectUrl: null; name?: undefined; size?: undefined; mediaType?: undefined; error?: undefined }
  | { status: "loading"; objectUrl: null; name?: undefined; size?: undefined; mediaType?: undefined; error?: undefined }
  | { status: "ready"; objectUrl: string; name: string; size: number; mediaType: string; error?: undefined }
  | { status: "error"; objectUrl: null; name?: undefined; size?: undefined; mediaType?: undefined; error: string }

function useDeviceAttachmentFile({
  token,
  connectorId,
  root,
  path,
  fallbackName,
}: {
  token: string
  connectorId: string
  root: string
  path?: string
  fallbackName: string
}): DeviceAttachmentFileState {
  const objectUrlRef = useRef<string | null>(null)
  const [state, setState] = useState<DeviceAttachmentFileState>({ status: "idle", objectUrl: null })

  useEffect(() => {
    if (!path) {
      setState({ status: "idle", objectUrl: null })
      return
    }
    const devicePath = path
    let cancelled = false
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setState({ status: "loading", objectUrl: null })

    async function load() {
      try {
        const response = await dashboardApi.connectorFsRead(token, connectorId, root, devicePath)
        const file = response.result
        const blob = await dashboardApi.downloadBlob(token, file.downloadUrl)
        if (cancelled) return
        const mediaType = concreteMediaType(file.mediaType || blob.type, file.name || fallbackName)
        const objectUrl = URL.createObjectURL(new Blob([blob], { type: mediaType || "application/octet-stream" }))
        objectUrlRef.current = objectUrl
        setState({
          status: "ready",
          objectUrl,
          name: file.name || fallbackName,
          size: file.size,
          mediaType,
        })
      } catch (error) {
        if (cancelled) return
        setState({
          status: "error",
          objectUrl: null,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void load()
    return () => {
      cancelled = true
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [connectorId, fallbackName, root, path, token])

  return state
}

function ImageAttachment({
  name,
  mediaType,
  size,
  src,
  previewOpen,
  setPreviewOpen,
  state = "done",
}: {
  name: string
  mediaType: string
  size: number | undefined
  src: string
  previewOpen: boolean
  setPreviewOpen: (open: boolean) => void
  state?: "uploading" | "done"
}) {
  return (
    <>
      <Attachment
        orientation="vertical"
        state={state}
        className="w-[min(320px,85vw)] has-data-[slot=attachment-content]:w-[min(320px,85vw)]"
      >
        <AttachmentMedia variant="image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={name} loading="lazy" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{name}</AttachmentTitle>
          <AttachmentDescription>{attachmentDetails(mediaType, size)}</AttachmentDescription>
        </AttachmentContent>
        <AttachmentActions>
          <AttachmentAction aria-label={`Preview ${name}`} onClick={() => setPreviewOpen(true)}>
            <ExternalLink />
          </AttachmentAction>
          {state === "done" ? (
            <AttachmentAction asChild aria-label={`Download ${name}`}>
              <a href={src} download={name}>
                <Download />
              </a>
            </AttachmentAction>
          ) : null}
        </AttachmentActions>
        <AttachmentTrigger aria-label={`Preview ${name}`} onClick={() => setPreviewOpen(true)} />
      </Attachment>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[min(92vh,900px)] w-[min(96vw,1200px)] max-w-none items-center justify-center overflow-hidden rounded-lg bg-black p-0"
        >
          <DialogTitle className="sr-only">{name}</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  )
}

function LoadingAttachment({
  name,
  mediaType,
  size,
  orientation,
}: {
  name: string
  mediaType: string
  size: number | undefined
  orientation: "horizontal" | "vertical"
}) {
  return (
    <Attachment
      orientation={orientation}
      state="processing"
      className={cn(
        orientation === "vertical"
          ? "w-[min(320px,85vw)] has-data-[slot=attachment-content]:w-[min(320px,85vw)]"
          : "w-[min(420px,85vw)]",
      )}
    >
      <AttachmentMedia variant={orientation === "vertical" ? "image" : "icon"}>
        <Loader2 className="animate-spin" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>{[attachmentDetails(mediaType, size), "Loading"].filter(Boolean).join(" · ")}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )
}

function FileAttachment({
  attachment,
  name,
  mediaType,
  openUrl,
  size,
  state = "done",
  statusText,
}: {
  attachment: ReconcileAttachment
  name: string
  mediaType: string
  openUrl?: string
  size?: number
  state?: "uploading" | "error" | "done"
  statusText?: string
}) {
  const pending = state === "uploading"
  const details = attachmentDetails(mediaType, size ?? attachment.size)

  return (
    <Attachment state={state} className="w-[min(420px,85vw)]">
      <AttachmentMedia>
        <FileText />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {[details, pending ? "Pending" : null, statusText].filter(Boolean).join(" · ")}
        </AttachmentDescription>
      </AttachmentContent>
      {openUrl ? (
        <>
          <AttachmentActions>
            <AttachmentAction asChild aria-label={`Open ${name}`}>
              <a href={openUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
              </a>
            </AttachmentAction>
            <AttachmentAction asChild aria-label={`Download ${name}`}>
              <a href={openUrl} download={name}>
                <Download />
              </a>
            </AttachmentAction>
          </AttachmentActions>
          <AttachmentTrigger asChild>
            <a href={openUrl} target="_blank" rel="noreferrer" aria-label={`Open ${name}`} />
          </AttachmentTrigger>
        </>
      ) : null}
    </Attachment>
  )
}

function attachmentDetails(mediaType: string, size: number | undefined): string {
  return [mediaType || "file", formatBytes(size)].filter(Boolean).join(" · ")
}

function attachmentOpenUrl(sessionId: string, fileId: string, token: string): string {
  return `${apiPath(`/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(fileId)}/open`)}?token=${encodeURIComponent(token)}`
}

function isImageAttachment(attachment: ReconcileAttachment): boolean {
  const mediaType = attachment.mediaType?.toLowerCase() ?? ""
  if (mediaType.startsWith("image/")) return true
  const name = attachment.name?.toLowerCase() ?? ""
  return /\.(png|apng|jpe?g|gif|webp|avif|svg)$/.test(name)
}

function mediaTypeForName(name: string): string {
  const lower = name.toLowerCase()
  if (/\.(png|apng)$/.test(lower)) return "image/png"
  if (/\.jpe?g$/.test(lower)) return "image/jpeg"
  if (/\.gif$/.test(lower)) return "image/gif"
  if (/\.webp$/.test(lower)) return "image/webp"
  if (/\.avif$/.test(lower)) return "image/avif"
  if (/\.svg$/.test(lower)) return "image/svg+xml"
  return "application/octet-stream"
}

function concreteMediaType(mediaType: string | undefined, name: string): string {
  if (mediaType && !mediaType.endsWith("/*")) return mediaType
  return mediaTypeForName(name)
}

function formatBytes(size: number | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size)) return null
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}
