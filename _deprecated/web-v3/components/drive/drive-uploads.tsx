"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, CircleAlertIcon, FileIcon, XIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { TransferError } from "@/lib/attachments/transfer"
import { uploadToDrive } from "@/lib/drive/upload"
import type { MessageKey } from "@/lib/i18n"
import type { DriveFileView } from "@/lib/types/v3"
import { formatSize } from "@/lib/workbench/time"

export type DriveUploadStatus = "queued" | "uploading" | "done" | "failed" | "cancelled"

export interface DriveUploadItem {
  id: string
  name: string
  folder: string
  size: number
  sent: number
  status: DriveUploadStatus
  error?: string
}

interface Job {
  id: string
  file: File
  folder: string
}

let nextUploadId = 0

const STATUS_LABEL: Record<Exclude<DriveUploadStatus, "uploading">, MessageKey> = {
  queued: "drive.uploadQueued",
  done: "drive.uploadDone",
  cancelled: "drive.uploadCancelled",
  failed: "drive.uploadFailed",
}

/** Uploads into drive folders, one at a time, with progress and cancel. */
export function useDriveUploads({
  serverUrl,
  getToken,
  onUploaded,
  describeError,
}: {
  serverUrl: string | null
  getToken: () => Promise<string>
  onUploaded: (file: DriveFileView) => void
  describeError: (err: unknown) => string
}) {
  const [items, setItems] = useState<DriveUploadItem[]>([])
  const queue = useRef<Job[]>([])
  const controllers = useRef(new Map<string, AbortController>())
  const running = useRef(false)
  const latest = useRef({ serverUrl, getToken, onUploaded, describeError })
  useEffect(() => {
    latest.current = { serverUrl, getToken, onUploaded, describeError }
  })

  const update = useCallback((id: string, patch: Partial<DriveUploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const pump = useCallback(async () => {
    if (running.current) return
    running.current = true
    try {
      for (let job = queue.current.shift(); job; job = queue.current.shift()) {
        const { serverUrl: url, getToken: token } = latest.current
        if (!url) {
          update(job.id, { status: "failed", error: latest.current.describeError(new Error("not signed in")) })
          continue
        }
        const controller = new AbortController()
        controllers.current.set(job.id, controller)
        update(job.id, { status: "uploading", sent: 0 })
        const id = job.id
        try {
          const done = await uploadToDrive(job.file, {
            serverUrl: url,
            getToken: token,
            folder: job.folder,
            signal: controller.signal,
            onProgress: (sent) => update(id, { sent }),
          })
          update(id, { status: "done", sent: job.file.size, name: done.name })
          latest.current.onUploaded(done)
        } catch (err) {
          const aborted =
            controller.signal.aborted || (err instanceof TransferError && err.code === "aborted")
          update(id, aborted ? { status: "cancelled" } : { status: "failed", error: latest.current.describeError(err) })
        } finally {
          controllers.current.delete(id)
        }
      }
    } finally {
      running.current = false
    }
  }, [update])

  const enqueue = useCallback(
    (files: readonly File[], folder: string) => {
      if (!files.length) return
      const jobs = files.map((file) => ({ id: `upl_${++nextUploadId}`, file, folder }))
      queue.current.push(...jobs)
      setItems((prev) => [
        ...prev,
        ...jobs.map((job) => ({
          id: job.id,
          name: job.file.name,
          folder,
          size: job.file.size,
          sent: 0,
          status: "queued" as const,
        })),
      ])
      void pump()
    },
    [pump]
  )

  const cancel = useCallback(
    (id: string) => {
      const controller = controllers.current.get(id)
      if (controller) {
        controller.abort()
        return
      }
      queue.current = queue.current.filter((job) => job.id !== id)
      update(id, { status: "cancelled" })
    },
    [update]
  )

  const dismissFinished = useCallback(() => {
    setItems((prev) => prev.filter((item) => item.status === "queued" || item.status === "uploading"))
  }, [])

  /** Bytes queued or uploading: counted against the remaining quota before more files are queued. */
  const pendingBytes = useMemo(
    () =>
      items
        .filter((item) => item.status === "queued" || item.status === "uploading")
        .reduce((sum, item) => sum + item.size, 0),
    [items]
  )

  return { items, enqueue, cancel, dismissFinished, pendingBytes }
}

/** Progress of this page's uploads. */
export function DriveUploadList({
  items,
  onCancel,
  onDismiss,
}: {
  items: readonly DriveUploadItem[]
  onCancel: (id: string) => void
  onDismiss: () => void
}) {
  const { t } = useI18n()
  if (!items.length) return null
  const active = items.some((item) => item.status === "queued" || item.status === "uploading")
  return (
    <section aria-label={t("drive.uploadsTitle")} className="rounded-card bg-card p-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">{t("drive.uploadsTitle")}</h2>
        {!active && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t("drive.uploadsClear")}
          </Button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-border">
        {items.map((item) => {
          const percent = item.size > 0 ? Math.min(100, Math.round((item.sent / item.size) * 100)) : 0
          return (
            <li key={item.id} className="flex items-center gap-3 py-2.5">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm">{item.name}</span>
                  {item.status === "uploading" ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatSize(item.sent)} / {formatSize(item.size)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-sm text-muted-foreground">{t(STATUS_LABEL[item.status])}</span>
                  )}
                </div>
                {item.status === "uploading" && <Progress value={percent} className="mt-2" />}
                {item.status === "failed" && item.error && (
                  <p className="mt-0.5 truncate text-sm text-destructive" title={item.error}>
                    {item.error}
                  </p>
                )}
              </div>
              {item.status === "queued" || item.status === "uploading" ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("drive.uploadCancel", { name: item.name })}
                  onClick={() => onCancel(item.id)}
                >
                  <XIcon />
                </Button>
              ) : item.status === "done" ? (
                <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
              ) : item.status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
