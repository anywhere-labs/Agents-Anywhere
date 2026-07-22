"use client"

import { useState } from "react"
import { Download, ExternalLink, FileText } from "lucide-react"

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
import { apiPath } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

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
          sessionId={sessionId}
          attachment={attachment}
        />
      ))}
    </AttachmentGroup>
  )
}

function MessageAttachmentItem({
  token,
  sessionId,
  attachment,
}: {
  token: string
  sessionId: string
  attachment: ReconcileAttachment
}) {
  const name = attachment.name || attachment.fileId
  const mediaType = attachment.mediaType || ""
  const openUrl = attachmentOpenUrl(sessionId, attachment.fileId, token)
  const isImage = isImageAttachment(attachment)
  const [previewOpen, setPreviewOpen] = useState(false)

  if (attachment.optimistic) {
    return (
      <FileAttachment
        attachment={attachment}
        name={name}
        mediaType={mediaType}
        state="uploading"
      />
    )
  }

  if (isImage) {
    return (
      <>
        <Attachment
          orientation="vertical"
          className="w-[min(320px,85vw)] has-data-[slot=attachment-content]:w-[min(320px,85vw)]"
        >
          <AttachmentMedia variant="image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={openUrl} alt={name} loading="lazy" />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{name}</AttachmentTitle>
            <AttachmentDescription>{attachmentDetails(mediaType, attachment.size)}</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label={`Preview ${name}`} onClick={() => setPreviewOpen(true)}>
              <ExternalLink />
            </AttachmentAction>
            <AttachmentAction asChild aria-label={`Download ${name}`}>
              <a href={openUrl} download={name}>
                <Download />
              </a>
            </AttachmentAction>
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
            <img src={openUrl} alt={name} className="max-h-full max-w-full object-contain" />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <FileAttachment
      attachment={attachment}
      name={name}
      mediaType={mediaType}
      openUrl={openUrl}
    />
  )
}

function FileAttachment({
  attachment,
  name,
  mediaType,
  openUrl,
  state = "done",
}: {
  attachment: ReconcileAttachment
  name: string
  mediaType: string
  openUrl?: string
  state?: "uploading" | "done"
}) {
  const pending = state === "uploading"
  const details = attachmentDetails(mediaType, attachment.size)

  return (
    <Attachment state={state} className="w-[min(420px,85vw)]">
      <AttachmentMedia>
        <FileText />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {[details, pending ? "Pending" : null].filter(Boolean).join(" · ")}
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

function formatBytes(size: number | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size)) return null
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}
