"use client"

import { useState } from "react"
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { ReconcileAttachment } from "@/features/dashboard/attachments"
import { apiPath } from "@/lib/api"
import { cn } from "@/lib/utils"

type MessageAttachmentsProps = {
  token: string
  sessionId: string
  attachments: ReconcileAttachment[]
  align?: "left" | "right"
}

export function MessageAttachments({
  token,
  sessionId,
  attachments,
  align = "left",
}: MessageAttachmentsProps) {
  if (attachments.length === 0) return null
  return (
    <div className={cn("flex flex-col gap-2", align === "right" && "items-end")}>
      {attachments.map((attachment) => (
        <MessageAttachmentItem
          key={attachment.fileId}
          token={token}
          sessionId={sessionId}
          attachment={attachment}
          align={align}
        />
      ))}
    </div>
  )
}

function MessageAttachmentItem({
  token,
  sessionId,
  attachment,
  align,
}: {
  token: string
  sessionId: string
  attachment: ReconcileAttachment
  align: "left" | "right"
}) {
  const name = attachment.name || attachment.fileId
  const mediaType = attachment.mediaType || ""
  const openUrl = attachmentOpenUrl(sessionId, attachment.fileId, token)
  const isImage = isImageAttachment(attachment)
  const [previewOpen, setPreviewOpen] = useState(false)
  if (attachment.optimistic) {
    return <AttachmentFileCard attachment={attachment} name={name} mediaType={mediaType} align={align} pending />
  }
  if (isImage) {
    return (
      <>
        <button
          type="button"
          aria-label={`Preview ${name}`}
          onClick={() => setPreviewOpen(true)}
          className={cn(
            "block max-w-full overflow-hidden rounded-lg bg-muted/30 text-left shadow-sm ring-1 ring-border/60 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "w-[min(360px,100%)]",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={openUrl}
            alt={name}
            className="max-h-72 w-full object-contain"
            loading="lazy"
          />
        </button>
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent
            showCloseButton
            className="flex h-[min(92vh,900px)] w-[min(96vw,1200px)] max-w-none items-center justify-center overflow-hidden rounded-lg bg-black p-0"
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={openUrl} alt={name} className="max-h-full max-w-full object-contain" />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <AttachmentFileCard
      attachment={attachment}
      name={name}
      mediaType={mediaType}
      align={align}
      openUrl={openUrl}
    />
  )
}

function AttachmentFileCard({
  attachment,
  name,
  mediaType,
  align,
  openUrl,
  pending = false,
}: {
  attachment: ReconcileAttachment
  name: string
  mediaType: string
  align: "left" | "right"
  openUrl?: string
  pending?: boolean
}) {
  const details = [mediaType || "file", formatBytes(attachment.size)].filter(Boolean).join(" - ")

  return (
    <div
      className={cn(
        "max-w-full overflow-hidden rounded-lg border border-border/80 bg-background/80 text-foreground shadow-sm",
        "w-[min(420px,100%)]",
        align === "right" && "bg-background/70",
        pending && "opacity-80",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{name}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {pending ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" />
                <span>{[details, "Pending"].filter(Boolean).join(" - ")}</span>
              </span>
            ) : (
              details
            )}
          </div>
        </div>
        {pending ? (
          <>
            <Button variant="ghost" size="icon-sm" className="shrink-0" disabled aria-label={`Open ${name}`}>
              <ExternalLink className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" className="shrink-0" disabled aria-label={`Download ${name}`}>
              <Download className="size-3.5" />
            </Button>
          </>
        ) : openUrl ? (
          <>
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <a href={openUrl} target="_blank" rel="noreferrer" aria-label={`Open ${name}`}>
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <a href={openUrl} download={name} aria-label={`Download ${name}`}>
                <Download className="size-3.5" />
              </a>
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
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

function formatBytes(size: number | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size)) return null
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}
