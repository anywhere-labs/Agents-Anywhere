"use client"

import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  ArrowLeftIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LoaderCircleIcon,
  LockIcon,
  RefreshCwIcon,
  SendIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Composer, type DraftAttachment } from "@/components/conversation/composer"
import { ContextMeter } from "@/components/conversation/context-meter"
import { ThreadEnvContext, type ThreadEnv } from "@/components/conversation/env"
import { Thread, type ThreadItem } from "@/components/conversation/thread"
import { ScrollRootContext, useWindowTrimmer } from "@/components/conversation/virtual"
import { useI18n } from "@/components/i18n-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { E2eeLockBadge } from "@/components/workbench/e2ee-lock-badge"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import {
  completeDriveUpload,
  createDriveUpload,
} from "@/lib/api/control-http"
import { sha256Hex } from "@/lib/assistant/crypto"
import { PairingError } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import { TimelineStore } from "@/lib/timeline/store"
import type { SessionState } from "@/lib/types/v3"

const DIRECT_TUNNEL_LIMIT_BYTES = 8 * 1024 * 1024

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      const idx = result.indexOf(",")
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

const WebThreadItem: ThreadItem = ({ id, anchor, children }) => (
  <MessageScrollerItem data-turn-id={id} scrollAnchor={anchor}>
    {children}
  </MessageScrollerItem>
)

function stateBadgeLabel(
  state: SessionState | undefined,
  t: ReturnType<typeof useI18n>["t"]
): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  switch (state) {
    case "running":
      return { label: t("sessions.stateRunning"), variant: "default" }
    case "waiting":
      return { label: t("sessions.stateWaiting"), variant: "outline" }
    case "error":
      return { label: t("sessions.stateError"), variant: "destructive" }
    case "disconnected":
      return { label: t("sessions.stateDisconnected"), variant: "secondary" }
    default:
      return { label: t("sessions.stateIdle"), variant: "secondary" }
  }
}

export default function SessionWorkspacePage() {
  const params = useParams<{ deviceId: string; sessionId: string }>()
  const router = useRouter()
  const { t } = useI18n()
  const {
    activeAccount,
    devices,
    deviceTrusts,
    sessions,
    tunnelManager,
    getFreshAccessToken,
  } = useWorkbench()

  const deviceId = decodeURIComponent(params.deviceId ?? "")
  const sessionId = decodeURIComponent(params.sessionId ?? "")

  const device = useMemo(
    () => devices.find((d) => d.id === deviceId) ?? null,
    [devices, deviceId]
  )
  // What the tunnel needs, as a value that only changes when one of these does: the device record itself is
  // replaced on every presence heartbeat (~20 s), which must not restart the watch.
  const tunnelDevice = useMemo(
    () => (device ? { id: device.id, mode_hint: device.mode_hint, presence: device.presence } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device?.id, device?.mode_hint, device?.presence]
  )
  const summary = useMemo(
    () => sessions.find((s) => s.device_id === deviceId && s.id === sessionId) ?? null,
    [sessions, deviceId, sessionId]
  )
  const trust = deviceTrusts[deviceId]
  const isEncrypted = device?.mode_hint === "encrypted" || Boolean(trust)

  const [store] = useState(() => new TimelineStore())
  const timeline = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [previewMap, setPreviewMap] = useState<Record<string, string>>({})
  const [connectError, setConnectError] = useState<{ code: string; message: string } | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [retryNonce, setRetryNonce] = useState(0)
  const [pairOpen, setPairOpen] = useState(false)

  const getScrollRoot = useCallback(() => viewportRef.current, [])
  useWindowTrimmer(store, getScrollRoot)

  // Live watch stream over MeshCall device tunnel (normal or Noise_IK E2EE). A dropped or ended stream is
  // watched again with backoff (the protocol is snapshot-then-replace, so a re-watch is all a reconnect needs);
  // pairing problems stop it, since only the user can fix those.
  useEffect(() => {
    const abort = new AbortController()
    store.reset()
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        abort.signal.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    ;(async () => {
      await Promise.resolve()
      if (abort.signal.aborted) return
      setConnectError(null)
      if (!tunnelManager || !tunnelDevice || tunnelDevice.presence === "offline") {
        setConnecting(false)
        return
      }
      setConnecting(true)
      let attempt = 0
      while (!abort.signal.aborted) {
        try {
          for await (const ev of tunnelManager.watchSession(tunnelDevice, sessionId, abort.signal)) {
            if (abort.signal.aborted) break
            attempt = 0
            setConnecting(false)
            setConnectError(null)
            store.apply(ev)
          }
        } catch (err) {
          if (abort.signal.aborted) return
          setConnecting(false)
          if (err instanceof PairingError) {
            setConnectError({ code: err.code, message: err.message })
            return
          }
          setConnectError({
            code: "watch_error",
            message: err instanceof Error ? err.message : String(err),
          })
        }
        if (abort.signal.aborted) return
        attempt++
        await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) * (0.5 + Math.random() * 0.5))
      }
    })()

    return () => {
      abort.abort()
    }
  }, [retryNonce, sessionId, store, tunnelDevice, tunnelManager])

  const loadOlder = useCallback(async () => {
    if (!tunnelManager || !device || timeline.loadingOlder || !timeline.has_more) return
    const oldestSeq = timeline.messages[0]?.seq
    store.setLoadingOlder(true)
    try {
      const page = await tunnelManager.listMessages(device, {
        id: sessionId,
        before_seq: oldestSeq,
        limit: 80,
      })
      store.prependOlder(page.messages, page.has_more)
    } catch (err) {
      store.setLoadingOlder(false)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [device, sessionId, store, timeline.has_more, timeline.loadingOlder, timeline.messages, tunnelManager])

  const handleSend = useCallback(
    async (text: string, drafts: DraftAttachment[]) => {
      if (!tunnelManager || !device || !activeAccount) return
      const clientMsgId = `msg_${crypto.randomUUID()}`

      const uploadedAttachments: { path: string; name: string; mime: string; size: number }[] = []
      try {
        for (const draft of drafts) {
          if (draft.file.size <= DIRECT_TUNNEL_LIMIT_BYTES) {
            const base64 = await fileToBase64(draft.file)
            const saved = await tunnelManager.saveAttachment(device, {
              name: draft.file.name,
              base64,
              mime: draft.file.type || "application/octet-stream",
            })
            if (draft.preview) {
              const previewUrl = draft.preview
              setPreviewMap((prev) => ({ ...prev, [saved.path]: previewUrl }))
            }
            uploadedAttachments.push({
              path: saved.path,
              name: saved.name,
              mime: saved.mime,
              size: saved.size,
            })
          } else {
            // Large file (> 8 MiB): route via Cloud Drive presigned S3 upload
            const raw = new Uint8Array(await draft.file.arrayBuffer())
            const digest = await sha256Hex(raw)
            const token = await getFreshAccessToken()
            const created = await createDriveUpload(activeAccount.serverUrl, token, {
              purpose: "transfer",
              size_bytes: raw.byteLength,
              sha256: digest,
              filename: draft.file.name,
              mime_type: draft.file.type || "application/octet-stream",
              encryption_mode: "none",
            })
            const putRes = await fetch(created.upload.url, {
              method: created.upload.method,
              headers: created.upload.headers,
              body: raw,
            })
            if (!putRes.ok) {
              throw new Error(`Cloud Drive upload failed (${putRes.status})`)
            }
            const completed = await completeDriveUpload(
              activeAccount.serverUrl,
              token,
              created.file.id,
              putRes.headers.get("etag")
            )
            const path = `drive://${completed.id}/${encodeURIComponent(draft.file.name)}`
            if (draft.preview) {
              const previewUrl = draft.preview
              setPreviewMap((prev) => ({ ...prev, [path]: previewUrl }))
            }
            uploadedAttachments.push({
              path,
              name: draft.file.name,
              mime: draft.file.type || "application/octet-stream",
              size: raw.byteLength,
            })
          }
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
        return
      }

      const parts = [
        ...uploadedAttachments.map((a) =>
          a.mime.startsWith("image/")
            ? ({ type: "image", ...a } as const)
            : ({ type: "file", ...a } as const)
        ),
        ...(text ? [{ type: "text", text } as const] : []),
      ]

      store.addOutgoing({
        id: clientMsgId,
        seq: Number.MAX_SAFE_INTEGER,
        done: true,
        role: "user",
        client_msg_id: clientMsgId,
        author: activeAccount.user.display_name,
        created_at: new Date().toISOString(),
        parts,
      })

      try {
        await tunnelManager.sendMessage(device, {
          id: sessionId,
          client_msg_id: clientMsgId,
          content: text || undefined,
          delivery: "auto",
          attachments: uploadedAttachments.length ? uploadedAttachments : undefined,
        })
      } catch (err) {
        store.removeOutgoing(clientMsgId)
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [activeAccount, device, getFreshAccessToken, sessionId, store, tunnelManager]
  )

  const handleStop = useCallback(async () => {
    if (!tunnelManager || !device) return
    try {
      await tunnelManager.stopSession(device, sessionId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [device, sessionId, tunnelManager])

  const handleConfig = useCallback(
    async (configId: string, value: string) => {
      if (!tunnelManager || !device) return
      try {
        await tunnelManager.setSessionConfig(device, sessionId, configId, value)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [device, sessionId, tunnelManager]
  )

  const threadEnv = useMemo<ThreadEnv>(
    () => ({
      me: activeAccount?.user.display_name ?? "",
      approvals: "inline",
      reduceMotion: false,
      imageSrc: (path) => previewMap[path] ?? "",
      answer: (requestId, optionId) => {
        if (!tunnelManager || !device) return
        void tunnelManager
          .answerApproval(device, { id: sessionId, request_id: requestId, option_id: optionId })
          .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      },
      open: (target) => {
        if (target.kind === "url") {
          window.open(target.url, "_blank", "noopener,noreferrer")
        } else {
          router.push(
            `/devices/${encodeURIComponent(deviceId)}?tab=files&path=${encodeURIComponent(target.path)}`
          )
        }
      },
      copy: (text) => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => toast.success(t("common.copied")))
          .catch(() => toast.error(t("common.copyFailed")))
      },
      rewind: (messageId) => {
        if (!tunnelManager || !device) return
        void tunnelManager
          .rewindSession(device, sessionId, messageId)
          .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      },
      fork: (messageId) => {
        if (!tunnelManager || !device) return
        void tunnelManager
          .forkSession(device, sessionId, messageId)
          .then((forked) => {
            router.push(
              `/sessions/${encodeURIComponent(deviceId)}/${encodeURIComponent(forked.id)}`
            )
          })
          .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      },
    }),
    [activeAccount?.user.display_name, device, deviceId, previewMap, router, sessionId, t, tunnelManager]
  )

  const sessionInfo = timeline.session
  const displayTitle = sessionInfo?.title || summary?.title || sessionId
  const displayAgent = sessionInfo?.agent || summary?.agent
  const displayBranch = sessionInfo?.branch
  const displayCwd = sessionInfo?.cwd || summary?.cwd
  const control = timeline.control
  const stateBadge = stateBadgeLabel(control?.state ?? summary?.state, t)
  const running = control?.state === "running"
  const queued = control?.queued ?? []
  const isOffline = device?.presence === "offline"

  return (
    <WorkbenchShell>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Session Header */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              render={<Link href="/" />}
              aria-label={t("common.back")}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate font-heading text-base font-semibold tracking-tight text-foreground">
                  {displayTitle}
                </h1>
                <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
                {isEncrypted && <E2eeLockBadge paired={Boolean(trust)} compact />}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {device && (
                  <Link
                    href={`/devices/${encodeURIComponent(device.id)}`}
                    className="hover:text-foreground transition-colors"
                  >
                    {device.name}
                  </Link>
                )}
                {displayAgent && <span>· {displayAgent}</span>}
                {displayBranch && (
                  <span className="inline-flex items-center gap-1 font-mono">
                    · <GitBranchIcon className="size-3" />
                    {displayBranch}
                  </span>
                )}
                {displayCwd && (
                  <span className="hidden truncate font-mono sm:inline max-w-xs">
                    · {displayCwd}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ContextMeter usage={control?.usage} />
            {device && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link href={`/devices/${encodeURIComponent(device.id)}?tab=files`} />}
                >
                  <FolderGit2Icon className="size-3.5" />
                  <span className="hidden sm:inline">{t("devices.tabFiles")}</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link href={`/devices/${encodeURIComponent(device.id)}?tab=terminals`} />}
                >
                  <TerminalIcon className="size-3.5" />
                  <span className="hidden sm:inline">{t("devices.tabTerminals")}</span>
                </Button>
              </>
            )}
          </div>
        </header>

        {/* Offline / Error / Unpaired States */}
        {isOffline && (
          <div className="shrink-0 border-b border-border bg-card px-5 py-2.5 text-xs text-muted-foreground">
            {t("sessions.staleCache")}
          </div>
        )}

        {connectError?.code === "e2e_not_paired" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-md space-y-4 rounded-card bg-card p-6 text-center">
              <LockIcon className="mx-auto size-8 text-warning" />
              <div className="space-y-1.5">
                <h2 className="font-heading text-lg font-semibold text-foreground">
                  {t("devices.unpaired")}
                </h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("devices.unpairedHint")}
                </p>
              </div>
              <Button onClick={() => setPairOpen(true)}>{t("devices.pair")}</Button>
            </div>
          </div>
        ) : connectError ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-md space-y-4 rounded-card bg-card p-6 text-center">
              <p className="text-sm font-medium text-foreground">
                {connectError.code === "e2e_required_locally"
                  ? t("devices.locallyLockedError")
                  : connectError.message}
              </p>
              <Button variant="outline" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
                <RefreshCwIcon className="size-3.5" />
                {t("common.refresh")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ScrollRootContext.Provider value={getScrollRoot}>
              <ThreadEnvContext.Provider value={threadEnv}>
                <MessageScroller className="flex-1">
                  <MessageScrollerViewport ref={viewportRef} className="px-4 py-6 sm:px-6">
                    <MessageScrollerContent className="mx-auto w-full max-w-3xl pb-8">
                      {timeline.has_more && (
                        <div className="flex justify-center">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={timeline.loadingOlder}
                            onClick={() => void loadOlder()}
                          >
                            {timeline.loadingOlder && (
                              <LoaderCircleIcon className="size-3.5 animate-spin" />
                            )}
                            {t("sessions.loadOlder")}
                          </Button>
                        </div>
                      )}

                      {connecting && timeline.messages.length === 0 ? (
                        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                          <LoaderCircleIcon className="size-4 animate-spin" />
                          <span>{t("common.loading")}</span>
                        </div>
                      ) : (
                        <Thread state={timeline} Item={WebThreadItem} showQueued={false} />
                      )}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton direction="end" />
                </MessageScroller>
              </ThreadEnvContext.Provider>
            </ScrollRootContext.Provider>

            {/* Queued Messages Strip + Composer */}
            <div className="shrink-0 border-t border-border bg-background px-4 py-3 sm:px-6">
              <div className="mx-auto w-full max-w-3xl space-y-2.5">
                {queued.length > 0 && (
                  <div className="space-y-1.5 rounded-xl bg-card p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("sessions.queuedCount", { count: queued.length })}
                    </p>
                    <div className="space-y-1.5">
                      {queued.map((q) => (
                        <div
                          key={q.client_msg_id}
                          className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-1.5 text-xs"
                        >
                          <span className="truncate text-foreground">{q.content}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {device && tunnelManager && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label="Steer now"
                                  onClick={() =>
                                    void tunnelManager
                                      .steerQueued(device, sessionId, q.client_msg_id)
                                      .catch((err) =>
                                        toast.error(
                                          err instanceof Error ? err.message : String(err)
                                        )
                                      )
                                  }
                                >
                                  <SendIcon className="size-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={t("common.cancel")}
                                  onClick={() =>
                                    void tunnelManager
                                      .cancelQueued(device, sessionId, q.client_msg_id)
                                      .catch((err) =>
                                        toast.error(
                                          err instanceof Error ? err.message : String(err)
                                        )
                                      )
                                  }
                                >
                                  <XIcon className="size-3" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <Composer
                  config={sessionInfo?.config ?? []}
                  running={running}
                  disabled={!device || isOffline}
                  onSend={(text, drafts) => void handleSend(text, drafts)}
                  onStop={() => void handleStop()}
                  onConfig={(id, value) => void handleConfig(id, value)}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open)
          if (!open) setRetryNonce((n) => n + 1)
        }}
        deviceNameHint={device?.name}
        deviceId={device?.id}
      />
    </WorkbenchShell>
  )
}
