"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  type OpenSessionFilePreview,
  useSessionFilePreviewOpener,
} from "@/components/session/session-file-preview-context"
import {
  attachmentIsImage,
  attachmentShouldReadFromDevice,
  type ReconcileAttachment,
} from "@/features/dashboard/attachments"
import { dashboardApi } from "@/features/dashboard/api"
import type { SessionView } from "@/features/dashboard/types"
import { apiPath } from "@/lib/api"
import { openNativeFilePreviewWindow } from "@/lib/file-preview-window"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

type MessageAttachmentsProps = {
  token: string
  session: SessionView
  attachments: ReconcileAttachment[]
  align?: "left" | "right"
  attachmentUrl?: (fileId: string) => string
}

type PreviewImage = {
  id: string
  name: string
  src: string
  downloadUrl?: string
}

export function MessageAttachments({
  token,
  session,
  attachments,
  align = "left",
  attachmentUrl,
}: MessageAttachmentsProps) {
  const t = useTranslations("dashboard.new")
  const openFilePreview = useSessionFilePreviewOpener()
  const [previewImages, setPreviewImages] = useState<Record<string, PreviewImage>>({})
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null)

  const registerPreviewImage = useCallback((image: PreviewImage) => {
    setPreviewImages((current) => {
      const existing = current[image.id]
      if (
        existing?.name === image.name
        && existing.src === image.src
        && existing.downloadUrl === image.downloadUrl
      ) return current
      return { ...current, [image.id]: image }
    })
  }, [])

  const openPreview = useCallback((image: PreviewImage) => {
    registerPreviewImage(image)
    setActivePreviewId(image.id)
  }, [registerPreviewImage])

  if (attachments.length === 0) return null

  const orderedPreviewImages = attachments.flatMap((attachment) => {
    const image = previewImages[attachment.fileId]
    return image ? [image] : []
  })

  return (
    <>
      <AttachmentGroup
        aria-label={t("attach")}
        role="group"
        tabIndex={0}
        className={cn(
          "w-full flex-col items-start gap-2 overflow-visible py-0",
          align === "right" && "items-end",
        )}
      >
        {attachments.map((attachment) => (
          <MessageAttachmentItem
            key={attachment.fileId}
            token={token}
            session={session}
            attachment={attachment}
            attachmentUrl={attachmentUrl}
            openFilePreview={openFilePreview}
            onImageReady={registerPreviewImage}
            onPreview={openPreview}
          />
        ))}
      </AttachmentGroup>
      <ImageLightbox
        images={orderedPreviewImages}
        activeId={activePreviewId}
        onActiveIdChange={setActivePreviewId}
      />
    </>
  )
}

function MessageAttachmentItem({
  token,
  session,
  attachment,
  attachmentUrl,
  openFilePreview,
  onImageReady,
  onPreview,
}: {
  token: string
  session: SessionView
  attachment: ReconcileAttachment
  attachmentUrl?: (fileId: string) => string
  openFilePreview: OpenSessionFilePreview | null
  onImageReady: (image: PreviewImage) => void
  onPreview: (image: PreviewImage) => void
}) {
  const name = attachment.name || attachment.fileId
  const mediaType = attachment.mediaType || ""
  const sessionAttachmentUrl = attachmentUrl?.(attachment.fileId)
    ?? attachmentOpenUrl(session.id, attachment.fileId, token)
  const presetUrl = attachment.openUrl || attachment.downloadUrl
  const persistentAttachment = Boolean(attachmentUrl || attachment.fileId.startsWith("file_"))
  const shouldReadFromDevice = attachmentShouldReadFromDevice(attachment, Boolean(attachmentUrl))
  const deviceFile = useDeviceAttachmentFile({
    token,
    connectorId: session.connectorId,
    root: attachment.root || session.cwd || ".",
    path: shouldReadFromDevice ? attachment.path : undefined,
    fallbackName: name,
  })
  const sourceUrl = persistentAttachment ? sessionAttachmentUrl : presetUrl || sessionAttachmentUrl
  const openUrl = deviceFile.objectUrl || sourceUrl
  const resolvedName = deviceFile.name || name
  const resolvedMediaType = deviceFile.mediaType || mediaType
  const resolvedSize = deviceFile.size ?? attachment.size
  const isImage = attachmentIsImage(resolvedName, resolvedMediaType)
  const previewTarget = attachment.path || openUrl
    ? {
        source: "attachment" as const,
        name: resolvedName,
        path: attachment.path || resolvedName,
        root: attachment.root || session.cwd || ".",
        ...(!shouldReadFromDevice && sourceUrl ? { sourceUrl } : {}),
        ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
        ...(typeof resolvedSize === "number" ? { size: resolvedSize } : {}),
      }
    : null
  const openAttachmentPreview = previewTarget
    ? () => {
        if (openFilePreview) {
          openFilePreview(previewTarget)
          return
        }
        openNativeFilePreviewWindow({
          token,
          connectorId: session.connectorId,
          root: previewTarget.root,
          file: previewTarget,
        })
      }
    : null

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
          id={attachment.fileId}
          name={resolvedName}
          src={openUrl}
          previewUrl={attachment.previewUrl}
          onImageReady={onImageReady}
          onPreview={onPreview}
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
        id={attachment.fileId}
        name={resolvedName}
        src={openUrl}
        previewUrl={attachment.previewUrl}
        onImageReady={onImageReady}
        onPreview={onPreview}
      />
    )
  }

  return (
    <FileAttachment
      attachment={attachment}
      name={resolvedName}
      mediaType={resolvedMediaType}
      onOpen={openAttachmentPreview ?? undefined}
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
  id,
  name,
  src,
  previewUrl,
  onImageReady,
  onPreview,
}: {
  id: string
  name: string
  src: string
  previewUrl?: string
  onImageReady: (image: PreviewImage) => void
  onPreview: (image: PreviewImage) => void
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(previewUrl ?? null)
  const [loading, setLoading] = useState(!previewUrl)

  useEffect(() => {
    if (!src) {
      setLoading(false)
      return
    }
    if (src === displayedSrc) {
      setLoading(false)
      return
    }
    let cancelled = false
    const image = new Image()
    setLoading(!displayedSrc)
    image.onload = () => {
      if (cancelled) return
      setDisplayedSrc(src)
      setLoading(false)
    }
    image.onerror = () => {
      if (!cancelled) setLoading(false)
    }
    image.src = src
    return () => {
      cancelled = true
    }
  }, [displayedSrc, previewUrl, src])

  useEffect(() => {
    if (!displayedSrc) return
    onImageReady({ id, name, src: displayedSrc, downloadUrl: src || displayedSrc })
  }, [displayedSrc, id, name, onImageReady, src])

  if (!displayedSrc) {
    return (
      <div
        role="status"
        aria-label={`Loading ${name}`}
        className={cn(
          "h-40 w-[min(360px,75vw)] overflow-hidden rounded-lg bg-muted/40",
          loading && "aa-attachment-shimmer",
        )}
      />
    )
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Preview ${name}`}
        onClick={() => onPreview({ id, name, src: displayedSrc, downloadUrl: src || displayedSrc })}
        className="block w-fit max-w-[min(360px,75vw)] rounded-lg p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={displayedSrc}
          alt={name}
          loading="lazy"
          className="block h-auto max-h-[360px] max-w-full rounded-lg object-contain"
        />
      </button>
    </>
  )
}

const MIN_PREVIEW_ZOOM = 0.5
const MAX_PREVIEW_ZOOM = 4
const PREVIEW_ZOOM_STEP = 0.25

function ImageLightbox({
  images,
  activeId,
  onActiveIdChange,
}: {
  images: PreviewImage[]
  activeId: string | null
  onActiveIdChange: (id: string | null) => void
}) {
  const t = useTranslations("dashboard.new.imagePreview")
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const activeIndex = images.findIndex((image) => image.id === activeId)
  const activeImage = activeIndex >= 0 ? images[activeIndex] : null
  const open = Boolean(activeImage)

  const resetView = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setDragging(false)
    dragRef.current = null
  }, [])

  useEffect(() => {
    resetView()
    setLoading(true)
    setLoadFailed(false)
  }, [activeId, reloadKey, resetView])

  const selectImage = useCallback((index: number) => {
    const image = images[index]
    if (image) onActiveIdChange(image.id)
  }, [images, onActiveIdChange])

  const updateZoom = useCallback((nextZoom: number) => {
    const clamped = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, nextZoom))
    setZoom(clamped)
    if (clamped <= 1) setOffset({ x: 0, y: 0 })
  }, [])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    }
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    })
  }

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  if (!activeImage) return null

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onActiveIdChange(null) }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && activeIndex > 0) selectImage(activeIndex - 1)
          if (event.key === "ArrowRight" && activeIndex < images.length - 1) selectImage(activeIndex + 1)
        }}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-black/80 p-0 text-white shadow-none ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{activeImage.name}</DialogTitle>

        <div className="absolute top-5 right-5 z-30 flex items-center gap-3">
          <Button
            variant="ghost"
            aria-label={t("download")}
            className="size-12 rounded-full bg-neutral-800/95 p-0 text-white/80 shadow-lg hover:bg-neutral-700 hover:text-white"
            asChild
          >
            <a href={activeImage.downloadUrl || activeImage.src} download={activeImage.name}>
              <Download className="size-5" />
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label={t("close")}
            onClick={() => onActiveIdChange(null)}
            className="size-12 rounded-full bg-neutral-800/95 p-0 text-white/80 shadow-lg hover:bg-neutral-700 hover:text-white"
          >
            <X className="size-5" />
          </Button>
        </div>

        <div
          className={cn(
            "relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden",
            zoom > 1 && (dragging ? "cursor-grabbing" : "cursor-grab"),
          )}
          onDoubleClick={() => zoom === 1 ? updateZoom(2) : resetView()}
          onWheel={(event) => {
            event.preventDefault()
            updateZoom(zoom + (event.deltaY < 0 ? PREVIEW_ZOOM_STEP : -PREVIEW_ZOOM_STEP))
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        >
          {loading && !loadFailed ? (
            <div className="aa-attachment-shimmer h-[min(58vh,560px)] w-[min(72vw,760px)] rounded-lg bg-white/8" />
          ) : null}
          {loadFailed ? (
            <div className="flex flex-col items-center gap-3 text-sm text-white/70">
              <p>{t("loadFailed")}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setReloadKey((current) => current + 1)
                  setLoadFailed(false)
                  setLoading(true)
                }}
              >
                <RotateCcw data-icon="inline-start" />
                {t("retry")}
              </Button>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${activeImage.id}:${reloadKey}`}
              src={activeImage.src}
              alt={activeImage.name}
              draggable={false}
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false)
                setLoadFailed(true)
              }}
              className={cn(
                "absolute max-h-[calc(100dvh-6rem)] max-w-[calc(100vw-4rem)] object-contain",
                loading ? "opacity-0" : "opacity-100",
                !dragging && "transition-[transform,opacity] duration-150",
              )}
              style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }}
            />
          )}
        </div>

        {images.length > 1 ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={t("previous")}
              disabled={activeIndex <= 0}
              onClick={() => selectImage(activeIndex - 1)}
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/55 text-white/80 backdrop-blur-md hover:bg-white/15 hover:text-white disabled:opacity-20"
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={t("next")}
              disabled={activeIndex >= images.length - 1}
              onClick={() => selectImage(activeIndex + 1)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/55 text-white/80 backdrop-blur-md hover:bg-white/15 hover:text-white disabled:opacity-20"
            >
              <ChevronRight />
            </Button>
            <div className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 text-xs text-white/55">
              {t("counter", { current: activeIndex + 1, total: images.length })}
            </div>
          </>
        ) : null}

        <div className="absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-800/95 p-1 shadow-xl">
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={t("zoomOut")}
            disabled={zoom <= MIN_PREVIEW_ZOOM}
            onClick={() => updateZoom(zoom - PREVIEW_ZOOM_STEP)}
            className="rounded-full text-white/80 hover:bg-neutral-700 hover:text-white"
          >
            <Minus />
          </Button>
          <button
            type="button"
            onClick={resetView}
            className="h-9 min-w-16 px-2 text-sm font-medium text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            aria-label={t("resetZoom")}
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={t("zoomIn")}
            disabled={zoom >= MAX_PREVIEW_ZOOM}
            onClick={() => updateZoom(zoom + PREVIEW_ZOOM_STEP)}
            className="rounded-full text-white/80 hover:bg-neutral-700 hover:text-white"
          >
            <Plus />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
      size={orientation === "horizontal" ? "sm" : "default"}
      className={cn(
        orientation === "vertical"
          ? "aa-attachment-shimmer h-40 w-[min(360px,75vw)] items-center justify-center rounded-lg border-0 bg-muted/40 has-data-[slot=attachment-content]:hidden"
          : "w-[min(320px,75vw)]",
      )}
    >
      {orientation === "horizontal" ? (
        <AttachmentMedia variant="icon"><Loader2 className="animate-spin" /></AttachmentMedia>
      ) : null}
      {orientation === "horizontal" ? (
        <AttachmentContent>
          <AttachmentTitle>{name}</AttachmentTitle>
          <AttachmentDescription>{[attachmentDetails(mediaType, size), "Loading"].filter(Boolean).join(" · ")}</AttachmentDescription>
        </AttachmentContent>
      ) : null}
    </Attachment>
  )
}

function FileAttachment({
  attachment,
  name,
  mediaType,
  onOpen,
  size,
  state = "done",
  statusText,
}: {
  attachment: ReconcileAttachment
  name: string
  mediaType: string
  onOpen?: () => void
  size?: number
  state?: "uploading" | "error" | "done"
  statusText?: string
}) {
  const pending = state === "uploading"
  const details = attachmentDetails(mediaType, size ?? attachment.size)

  return (
    <Attachment state={state} size="sm" className="w-[min(320px,75vw)] rounded-lg border-border/70 bg-transparent">
      <AttachmentMedia className="bg-transparent text-muted-foreground">
        {state === "uploading" ? <Loader2 className="animate-spin" /> : <FileText />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {[details, pending ? "Pending" : null, statusText].filter(Boolean).join(" · ")}
        </AttachmentDescription>
      </AttachmentContent>
      {onOpen ? (
        <>
          <AttachmentActions>
            <AttachmentAction aria-label={`Open ${name}`} onClick={onOpen}>
              <ExternalLink />
            </AttachmentAction>
          </AttachmentActions>
          <AttachmentTrigger aria-label={`Open ${name}`} onClick={onOpen} />
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
