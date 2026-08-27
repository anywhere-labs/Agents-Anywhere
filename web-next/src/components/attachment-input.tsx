"use client"

import { useRef, useState, useCallback, useEffect } from "react"
import { CircleAlert, FileText, ImageIcon, Loader2, Paperclip, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { dashboardApi } from "@/features/dashboard/api"
import type { UploadedAttachment } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

const MAX_ATTACHMENT_FILES = 5
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
type AttachmentUploadStatus = "local" | "uploading" | "uploaded" | "failed"

export interface AttachedFile {
  id: string
  name: string
  type: "image" | "file"
  size: number
  file: File
  mediaType: string
  preview?: string
  uploadStatus: AttachmentUploadStatus
  uploaded?: UploadedAttachment
  uploadError?: string
}

interface AttachmentInputProps {
  attachments: AttachedFile[]
  onAttach: (files: AttachedFile[]) => void
  onRemove: (id: string) => void
  isDragging: boolean
}

type AttachmentButtonProps = {
  attachments: AttachedFile[]
  onAttach: (files: AttachedFile[]) => void
  isDragging: boolean
  className?: string
  disabled?: boolean
}

type AttachmentPreviewListProps = {
  attachments: AttachedFile[]
  onRemove: (id: string) => void
}

type UseAttachmentsOptions = {
  sessionId?: string
  token?: string
}

type ClearAttachmentsOptions = {
  revokePreviews?: boolean
}

function processFiles(fileList: FileList | File[]): AttachedFile[] {
  return Array.from(fileList).slice(0, MAX_ATTACHMENT_FILES).flatMap((file) => {
    if (file.size > MAX_ATTACHMENT_BYTES) return []
    const isImage = file.type.startsWith("image/")
    const preview = isImage ? URL.createObjectURL(file) : undefined
    return [{
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      type: isImage ? "image" : "file",
      size: file.size,
      file,
      mediaType: file.type || "application/octet-stream",
      preview,
      uploadStatus: "local",
    }]
  })
}

function revokePreview(file: AttachedFile) {
  if (file.preview) URL.revokeObjectURL(file.preview)
}

function revokePreviews(files: AttachedFile[]) {
  files.forEach(revokePreview)
}

function sameFile(a: AttachedFile, b: AttachedFile): boolean {
  return a.name === b.name && a.size === b.size && a.file.lastModified === b.file.lastModified
}

function mergeFiles(
  previous: AttachedFile[],
  incoming: AttachedFile[],
  uploadImmediately: boolean,
): { next: AttachedFile[]; accepted: AttachedFile[] } {
  const next = [...previous]
  const accepted: AttachedFile[] = []
  for (const file of incoming) {
    if (next.length >= MAX_ATTACHMENT_FILES) {
      revokePreview(file)
      continue
    }
    if (next.some((item) => sameFile(item, file))) {
      revokePreview(file)
      continue
    }
    const acceptedFile = {
      ...file,
      uploadStatus: uploadImmediately ? "uploading" as const : file.uploadStatus,
    }
    next.push(acceptedFile)
    accepted.push(acceptedFile)
  }
  return { next, accepted }
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

export function useAttachments(options: UseAttachmentsOptions = {}) {
  const { sessionId, token } = options
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const attachmentsRef = useRef<AttachedFile[]>([])
  const sessionIdRef = useRef(sessionId)

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const clear = useCallback((options: ClearAttachmentsOptions = {}) => {
    const revoke = options.revokePreviews ?? true
    setAttachments((prev) => {
      if (revoke) revokePreviews(prev)
      attachmentsRef.current = []
      return []
    })
  }, [])

  useEffect(() => {
    if (sessionIdRef.current === sessionId) return
    sessionIdRef.current = sessionId
    clear()
  }, [clear, sessionId])

  const upload = useCallback((attachment: AttachedFile) => {
    if (!sessionId || !token) return
    void dashboardApi.uploadSessionAttachments(token, sessionId, [attachment.file])
      .then((response) => {
        const uploaded = response.attachments[0]
        if (!uploaded) throw new Error("Attachment upload failed")
        setAttachments((prev) => {
          const next = prev.map((item) =>
            item.id === attachment.id
              ? { ...item, uploadStatus: "uploaded" as const, uploaded, uploadError: undefined }
              : item,
          )
          attachmentsRef.current = next
          return next
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Upload failed"
        setAttachments((prev) => {
          const next = prev.map((item) =>
            item.id === attachment.id
              ? { ...item, uploadStatus: "failed" as const, uploaded: undefined, uploadError: message }
              : item,
          )
          attachmentsRef.current = next
          return next
        })
      })
  }, [sessionId, token])

  const add = useCallback((files: AttachedFile[]) => {
    const uploadImmediately = Boolean(sessionId && token)
    const result = mergeFiles(attachmentsRef.current, files, uploadImmediately)
    attachmentsRef.current = result.next
    setAttachments(result.next)
    if (uploadImmediately) result.accepted.forEach(upload)
  }, [sessionId, token, upload])

  const remove = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((file) => file.id === id)
      if (target) revokePreview(target)
      const next = prev.filter((file) => file.id !== id)
      attachmentsRef.current = next
      return next
    })
  }, [])

  useEffect(() => () => revokePreviews(attachmentsRef.current), [])

  // Global paste handler
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      const items = Array.from(e.clipboardData.items)
      const files = items
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter(Boolean) as File[]
      if (files.length) {
        e.preventDefault()
        add(processFiles(files))
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [add])

  // Drag over entire window
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current++
    if (e.dataTransfer.items.length > 0) setIsDragging(true)
  }, [])

  const onDragLeave = useCallback(() => {
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragging(false)
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragCounter.current = 0
      setIsDragging(false)
      if (e.dataTransfer.files.length) {
        add(processFiles(e.dataTransfer.files))
      }
    },
    [add],
  )

  const uploadsPending = attachments.some((file) => file.uploadStatus === "uploading")
  const uploadFailed = attachments.some((file) => file.uploadStatus === "failed")
  const allUploaded = attachments.every((file) => file.uploadStatus === "uploaded")

  return {
    attachments,
    isDragging,
    uploadsPending,
    uploadFailed,
    allUploaded,
    add,
    remove,
    clear,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  }
}

export function AttachmentButton({
  attachments,
  onAttach,
  isDragging,
  className,
  disabled = false,
}: AttachmentButtonProps) {
  const t = useTranslations("dashboard.new")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      onAttach(processFiles(e.target.files))
      e.target.value = ""
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInput}
        accept="*/*"
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("attach")}
        className={cn("text-muted-foreground", isDragging && "text-primary", className)}
        disabled={disabled || attachments.length >= MAX_ATTACHMENT_FILES}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip className="size-4" />
      </Button>
    </>
  )
}

export function AttachmentPreviewList({ attachments, onRemove }: AttachmentPreviewListProps) {
  const t = useTranslations("dashboard.new")
  if (attachments.length === 0) return null
  return (
    <AttachmentGroup aria-label={t("attach")} role="group" tabIndex={0}>
      {attachments.map((file) => {
        const uploading = file.uploadStatus === "uploading"
        const failed = file.uploadStatus === "failed"
        return (
          <Attachment
            key={file.id}
            state={uploading ? "uploading" : failed ? "error" : "idle"}
            size="sm"
            className="w-56"
            title={file.uploadError || file.name}
          >
            <AttachmentMedia variant={file.type === "image" && file.preview ? "image" : "icon"}>
              {file.type === "image" ? (
                file.preview ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={file.preview} alt="" />
                    {uploading || failed ? (
                      <span className="absolute inset-0 flex items-center justify-center bg-background/55">
                        {uploading ? <Loader2 className="animate-spin" /> : <CircleAlert />}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <ImageIcon />
                )
              ) : uploading ? (
                <Loader2 className="animate-spin" />
              ) : failed ? (
                <CircleAlert />
              ) : (
                <FileText />
              )}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{file.name}</AttachmentTitle>
              <AttachmentDescription>
                {[formatBytes(file.size), failed ? file.uploadError : null].filter(Boolean).join(" · ")}
              </AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction
                aria-label={t("removeAttachmentNamed", { name: file.name })}
                onClick={() => onRemove(file.id)}
              >
                <X />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        )
      })}
    </AttachmentGroup>
  )
}

// The legacy combined component is kept for compatibility. Prefer composing
// AttachmentPreviewList above the textarea and AttachmentButton in the toolbar.
export function AttachmentBar(props: AttachmentInputProps) {
  return (
    <>
      <AttachmentButton
        attachments={props.attachments}
        onAttach={props.onAttach}
        isDragging={props.isDragging}
      />
      <AttachmentPreviewList attachments={props.attachments} onRemove={props.onRemove} />
    </>
  )
}

// Full-window drop overlay
export function DragOverlay({ isDragging }: { isDragging: boolean }) {
  const t = useTranslations("dashboard.new")
  if (!isDragging) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />
      <div className="relative flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-16 py-12 text-center">
        <Paperclip className="size-10 text-primary" />
        <p className="text-lg font-medium">{t("dropTitle")}</p>
        <p className="text-sm text-muted-foreground">{t("dropDescription")}</p>
      </div>
    </div>
  )
}
