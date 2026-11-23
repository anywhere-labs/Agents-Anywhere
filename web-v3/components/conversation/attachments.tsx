"use client"

// The composer's attachments (client-experience-proposal §3): picked, pasted or dropped files become chips above the
// input. Limits are checked right away (device RPC cap, drive max file size and remaining quota). In an existing
// conversation each file starts uploading as soon as it is added; on the new-conversation page they wait until the
// conversation exists (`upload(sessionId)`). Chips show a thumbnail or icon, name, progress or size, and why one
// cannot go.
import { useCallback, useEffect, useRef, useState } from "react"
import type * as React from "react"
import { CircleAlertIcon, FileTextIcon, LoaderCircleIcon, UploadIcon, XIcon } from "lucide-react"

import { useI18n } from "@/components/i18n-provider"
import { useWorkbench } from "@/lib/state/workbench-context"
import { completeDriveUpload, createDriveUpload, deleteDriveFile } from "@/lib/api/control-http"
import { rememberPreview, sentPreview } from "@/lib/attachments/previews"
import {
  MAX_ATTACHMENTS,
  planTransfer,
  rpcCap,
  TransferError,
  transferAttachment,
  type AttachmentRef,
  type TransferPorts,
  type TransferRoute,
} from "@/lib/attachments/transfer"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import type { DeviceRecord, DriveQuotaView } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/workbench/time"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

export interface Draft {
  id: string
  file: File
  image: boolean
  preview?: string
  route: TransferRoute
  status: "waiting" | "reading" | "uploading" | "saving" | "ready" | "error"
  sent: number
  error?: string
  ref?: AttachmentRef
}

export interface DraftAttachments {
  items: Draft[]
  add: (files: File[]) => void
  remove: (id: string) => void
  /** Drop these chips (the ones just sent), or all of them. Chips added while a send was in flight stay. */
  clear: (ids?: string[]) => void
  /** Put back attachments already saved on the device (editing a queued message): ready chips, nothing re-sent. */
  restore: (refs: AttachmentRef[]) => void
  /** Upload whatever has not gone yet; null when one could not (its chip says why). */
  upload: (sessionId: string) => Promise<AttachmentRef[] | null>
  blocked: boolean
  busy: boolean
}

/** Tunnel + control-plane calls the transfer needs, for one device. */
export function useTransferPorts(
  manager: DeviceTunnelManager | null,
  device: TunnelDevice | null
): TransferPorts | null {
  const { activeAccount, getFreshAccessToken } = useWorkbench()
  const serverUrl = activeAccount?.serverUrl
  if (!manager || !device || !serverUrl) return null
  return {
    saveAttachment: (payload) => manager.saveAttachment(device, payload),
    fetchDriveFile: (payload) => manager.fetchDriveFile(device, payload),
    createUpload: async (payload) => createDriveUpload(serverUrl, await getFreshAccessToken(), payload),
    completeUpload: async (fileId, etag) => completeDriveUpload(serverUrl, await getFreshAccessToken(), fileId, etag),
    deleteUpload: async (fileId) => deleteDriveFile(serverUrl, await getFreshAccessToken(), fileId),
  }
}

export function useDraftAttachments(opts: {
  ports: TransferPorts | null
  /** Upload on add when the conversation exists. */
  sessionId?: string
  encrypted: boolean
  rpcMaxBytes?: number | null
  quota?: DriveQuotaView | null
}): DraftAttachments {
  const { t } = useI18n()
  const [items, setItems] = useState<Draft[]>([])
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const live = useRef(new Map<string, Promise<AttachmentRef | null>>())
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const limitText = formatSize(rpcCap({ rpcMaxBytes: opts.rpcMaxBytes, quota: opts.quota }))

  const set = useCallback((id: string, patch: Partial<Draft>) => {
    setItems((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }, [])

  const uploadOne = useCallback(
    (d: Draft, sessionId: string): Promise<AttachmentRef | null> => {
      const running = live.current.get(d.id)
      if (running) return running
      if (d.ref) return Promise.resolve(d.ref)
      if (d.route.kind === "reject") return Promise.resolve(null)
      const route = d.route
      const job = (async () => {
        const { ports, encrypted } = optsRef.current
        if (!ports) {
          set(d.id, { status: "error", error: t("composer.placeholderOffline") })
          return null
        }
        set(d.id, { status: "reading", sent: 0, error: undefined })
        try {
          const ref = await transferAttachment(d.file, {
            route,
            sessionId,
            encrypted,
            ports,
            onProgress: (p) => set(d.id, { status: p.phase, sent: p.sent }),
          })
          if (d.preview) rememberPreview(ref.path, d.preview)
          set(d.id, { status: "ready", sent: d.file.size, ref })
          return ref
        } catch (err) {
          const message =
            err instanceof TransferError && err.code === "unimplemented"
              ? t("attach.unimplemented", { limit: limitText })
              : t("attach.failed", { error: err instanceof Error ? err.message : String(err) })
          set(d.id, { status: "error", error: message })
          return null
        } finally {
          live.current.delete(d.id)
        }
      })()
      live.current.set(d.id, job)
      return job
    },
    [limitText, set, t]
  )

  const add = useCallback(
    (files: File[]) => {
      const { rpcMaxBytes, quota, sessionId } = optsRef.current
      const room = MAX_ATTACHMENTS - itemsRef.current.filter((x) => x.status !== "error").length
      const added: Draft[] = files.map((file, i) => {
        const image = file.type.startsWith("image/")
        const id = Math.random().toString(36).slice(2, 10)
        const preview = image ? URL.createObjectURL(file) : undefined
        const route = planTransfer(file.size, { rpcMaxBytes, quota })
        const base = { id, file, image, preview, route, sent: 0 }
        if (i >= room) {
          return { ...base, route: { kind: "reject", reason: "empty" } as TransferRoute, status: "error", error: t("attach.tooMany", { count: MAX_ATTACHMENTS }) }
        }
        if (route.kind === "reject") {
          const limit = route.limit != null ? formatSize(route.limit) : ""
          const error =
            route.reason === "empty"
              ? t("attach.empty")
              : route.reason === "drive_disabled"
                ? t("attach.driveDisabled", { limit })
                : route.reason === "too_large"
                  ? t("attach.tooLarge", { size: formatSize(file.size), limit })
                  : t("attach.quota", { limit })
          return { ...base, status: "error", error }
        }
        return { ...base, status: "waiting" }
      })
      setItems((all) => [...all, ...added])
      itemsRef.current = [...itemsRef.current, ...added]
      if (sessionId) for (const d of added) if (d.status === "waiting") void uploadOne(d, sessionId)
    },
    [t, uploadOne]
  )

  const remove = useCallback((id: string) => {
    const d = itemsRef.current.find((x) => x.id === id)
    if (d?.preview && !d.ref) URL.revokeObjectURL(d.preview)
    setItems((all) => all.filter((x) => x.id !== id))
    itemsRef.current = itemsRef.current.filter((x) => x.id !== id)
  }, [])

  const clear = useCallback((ids?: string[]) => {
    const drop = ids ? new Set(ids) : null
    setItems((all) => (drop ? all.filter((x) => !drop.has(x.id)) : []))
    itemsRef.current = drop ? itemsRef.current.filter((x) => !drop.has(x.id)) : []
  }, [])

  const restore = useCallback((refs: AttachmentRef[]) => {
    const back: Draft[] = refs.map((ref) => ({
      id: Math.random().toString(36).slice(2, 10),
      file: new File([], ref.name, { type: ref.mime }),
      image: ref.mime.startsWith("image/"),
      preview: ref.mime.startsWith("image/") ? (sentPreview(ref.path) ?? undefined) : undefined,
      route: { kind: "rpc" },
      status: "ready",
      sent: ref.size,
      ref,
    }))
    setItems((all) => [...all, ...back])
    itemsRef.current = [...itemsRef.current, ...back]
  }, [])

  const upload = useCallback(
    async (sessionId: string): Promise<AttachmentRef[] | null> => {
      const all = itemsRef.current
      if (all.some((x) => x.status === "error")) return null
      const refs = await Promise.all(all.map((d) => uploadOne(d, sessionId)))
      // A chip removed while its file was still going is not attached.
      const still = new Set(itemsRef.current.map((x) => x.id))
      const kept = refs.filter((_, i) => still.has(all[i].id))
      return kept.every(Boolean) ? (kept as AttachmentRef[]) : null
    },
    [uploadOne]
  )

  return {
    items,
    add,
    remove,
    clear,
    restore,
    upload,
    blocked: items.some((x) => x.status === "error"),
    busy: items.some((x) => x.status === "reading" || x.status === "uploading" || x.status === "saving"),
  }
}

/** The chips above the input. */
export function DraftChips({ drafts }: { drafts: DraftAttachments }) {
  const { t } = useI18n()
  if (!drafts.items.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-2">
      {drafts.items.map((d) => {
        const size = d.ref?.size ?? d.file.size
        const pct = size ? Math.min(100, Math.round((d.sent / size) * 100)) : 100
        const working = d.status === "reading" || d.status === "uploading" || d.status === "saving"
        const sub =
          d.status === "error"
            ? d.error
            : d.status === "reading"
              ? t("attach.reading")
              : d.status === "uploading"
                ? t("attach.uploading", { percent: pct })
                : d.status === "saving"
                  ? t("attach.saving")
                  : d.route.kind === "drive"
                    ? t("attach.viaDrive", { size: formatSize(size) })
                    : formatSize(size)
        return (
          <div
            key={d.id}
            title={d.status === "error" ? d.error : d.file.name}
            data-state={d.status}
            className={cn(
              "relative flex h-11 max-w-72 min-w-0 items-center gap-2 overflow-hidden rounded-xl bg-card py-1.5 pr-1 pl-1.5",
              d.status === "error" && "bg-destructive/10"
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-raised text-muted-foreground">
              {d.status === "error" ? (
                <CircleAlertIcon className="size-4 text-destructive" />
              ) : d.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={d.preview} alt="" className="size-full object-cover" />
              ) : working ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <FileTextIcon className="size-4" />
              )}
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-xs text-foreground">{d.file.name}</span>
              <span
                className={cn(
                  "truncate text-[11px] tabular-nums",
                  d.status === "error" ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {sub}
              </span>
            </span>
            <button
              type="button"
              aria-label={t("attach.remove", { name: d.file.name })}
              className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              onClick={() => drafts.remove(d.id)}
            >
              <XIcon className="size-3.5" />
            </button>
            {d.status === "uploading" && (
              <span
                className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/60 transition-[width]"
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Files dropped anywhere on a page (ChatGPT, Claude.ai): `handlers` go on the area, `over` drives the overlay. A drop
 * the composer already took (it calls preventDefault) is not added twice.
 */
export function useDropZone(onFiles: (files: File[]) => void, enabled: boolean) {
  const [over, setOver] = useState(false)
  const handlers = {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!enabled || !e.dataTransfer.types.includes("Files")) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
      if (!over) setOver(true)
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null
      if (next && e.currentTarget.contains(next)) return
      setOver(false)
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      setOver(false)
      if (e.defaultPrevented || !enabled || !e.dataTransfer.files.length) return
      e.preventDefault()
      onFiles([...e.dataTransfer.files])
    },
  }
  return { over: over && enabled, handlers }
}

/** "Drop files to attach" over the page while files are dragged across it. */
export function DropOverlay({ show }: { show: boolean }) {
  const { t } = useI18n()
  if (!show) return null
  return (
    <div className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-card bg-background/85 ring-2 ring-ring/30 backdrop-blur-sm ring-inset">
      <UploadIcon className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{t("attach.dropTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("attach.dropHint")}</p>
    </div>
  )
}
