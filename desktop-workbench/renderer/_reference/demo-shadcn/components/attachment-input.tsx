"use client"

import { useRef, useState, useCallback, useEffect } from "react"
import { Paperclip, X, FileText, ImageIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface AttachedFile {
  id: string
  name: string
  type: "image" | "file"
  size: number
  preview?: string // data URL for images
}

interface AttachmentInputProps {
  attachments: AttachedFile[]
  onAttach: (files: AttachedFile[]) => void
  onRemove: (id: string) => void
  isDragging: boolean
}

function processFiles(fileList: FileList | File[]): AttachedFile[] {
  return Array.from(fileList).map((f) => {
    const isImage = f.type.startsWith("image/")
    const entry: AttachedFile = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      type: isImage ? "image" : "file",
      size: f.size,
    }
    if (isImage) {
      // We don't await in a sync map, so the preview is set separately
      const reader = new FileReader()
      reader.onload = (e) => {
        entry.preview = e.target?.result as string
      }
      reader.readAsDataURL(f)
    }
    return entry
  })
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const add = useCallback((files: AttachedFile[]) => {
    setAttachments((prev) => [...prev, ...files])
  }, [])

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((f) => f.id !== id))
  }, [])

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

  return { attachments, isDragging, add, remove, onDragEnter, onDragLeave, onDragOver, onDrop }
}

// The chip list + paperclip button rendered inside the composer toolbar
export function AttachmentBar({
  attachments,
  onAttach,
  onRemove,
  isDragging,
}: AttachmentInputProps) {
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
        aria-label="添加附件"
        className={cn("text-muted-foreground", isDragging && "text-primary")}
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip className="size-4" />
      </Button>

      {attachments.map((file) => (
        <div
          key={file.id}
          className="flex max-w-[160px] items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
        >
          {file.type === "image" ? (
            <ImageIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{file.name}</span>
          <button
            type="button"
            aria-label={`移除 ${file.name}`}
            onClick={() => onRemove(file.id)}
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </>
  )
}

// Full-window drop overlay
export function DragOverlay({ isDragging }: { isDragging: boolean }) {
  if (!isDragging) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />
      <div className="relative flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary px-16 py-12 text-center">
        <Paperclip className="size-10 text-primary" />
        <p className="text-lg font-medium">拖拽文件到此处</p>
        <p className="text-sm text-muted-foreground">支持任意文件类型</p>
      </div>
    </div>
  )
}
