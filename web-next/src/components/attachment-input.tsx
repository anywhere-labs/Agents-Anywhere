"use client"

import { useRef, useState, useCallback, useEffect } from "react"
import { FileText, ImageIcon, Paperclip, X } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

const MAX_ATTACHMENT_FILES = 5
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface AttachedFile {
  id: string
  name: string
  type: "image" | "file"
  size: number
  file: File
  preview?: string // data URL for images
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
}

type AttachmentPreviewListProps = {
  attachments: AttachedFile[]
  onRemove: (id: string) => void
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
      preview,
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

function mergeFiles(previous: AttachedFile[], incoming: AttachedFile[]): AttachedFile[] {
  const next = [...previous]
  for (const file of incoming) {
    if (next.length >= MAX_ATTACHMENT_FILES) {
      revokePreview(file)
      continue
    }
    if (next.some((item) => sameFile(item, file))) {
      revokePreview(file)
      continue
    }
    next.push(file)
  }
  return next
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const attachmentsRef = useRef<AttachedFile[]>([])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const clear = useCallback(() => {
    setAttachments((prev) => {
      revokePreviews(prev)
      return []
    })
  }, [])

  const add = useCallback((files: AttachedFile[]) => {
    setAttachments((prev) => mergeFiles(prev, files))
  }, [])

  const remove = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((file) => file.id === id)
      if (target) revokePreview(target)
      return prev.filter((file) => file.id !== id)
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

  return { attachments, isDragging, add, remove, clear, onDragEnter, onDragLeave, onDragOver, onDrop }
}

export function AttachmentButton({
  attachments,
  onAttach,
  isDragging,
  className,
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
        disabled={attachments.length >= MAX_ATTACHMENT_FILES}
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
      {attachments.map((file) => (
        <Attachment key={file.id} state="idle" size="sm" className="w-56">
          <AttachmentMedia variant={file.type === "image" && file.preview ? "image" : "icon"}>
            {file.type === "image" ? (
              file.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={file.preview} alt="" />
              ) : (
                <ImageIcon />
              )
            ) : (
              <FileText />
            )}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{file.name}</AttachmentTitle>
            <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
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
      ))}
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
