"use client"

// A conversation (client-experience-proposal §2.4). Thread in the middle (Effi Cloud's turn rendering, approvals inline
// under the tool call as in Claude Code Desktop / Codex / Cursor), queued messages above the input, the composer at the
// bottom — centred under a greeting while the conversation is empty, as in ChatGPT / Claude.ai — and the side panel
// (files, changes, terminal, plan) beside the thread on wide screens, over it on medium ones and in a bottom sheet on
// phones. Files dropped anywhere on the conversation are attached.
// Behaviour follows AA v2 web-next mapped to aa.v3.Sessions: watch (snapshot then live), send with
// delivery auto / queue / steer, answer, set_config, stop, rename, fork, compact, delete, unqueue, steer_queued.
import { useParams, useRouter } from "next/navigation"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { LoaderCircleIcon, LockIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { ConfirmDialog } from "@/components/console/confirm-dialog"
import { ApprovalDock } from "@/components/conversation/approval-dock"
import { DropOverlay, useDraftAttachments, useDropZone, useTransferPorts } from "@/components/conversation/attachments"
import { Composer, type ComposerCommand, type Delivery } from "@/components/conversation/composer"
import { ContextMeter } from "@/components/conversation/context-meter"
import { ConversationHeader } from "@/components/conversation/conversation-header"
import { ThreadEnvContext, type ThreadEnv } from "@/components/conversation/env"
import { QueueRows } from "@/components/conversation/queue-rows"
import { SidePanel, type PanelTab } from "@/components/conversation/side-panel"
import { Thread, type ThreadItem } from "@/components/conversation/thread"
import { ScrollRootContext, useWindowTrimmer } from "@/components/conversation/virtual"
import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { PairDeviceDialog } from "@/components/workbench/pair-device-dialog"
import { WorkbenchShell } from "@/components/workbench/workbench-shell"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMediaQuery } from "@/hooks/use-media-query"
import { loadDeviceImage, sentPreview } from "@/lib/attachments/previews"
import { PairingError } from "@/lib/mesh/pairing"
import { useWorkbench } from "@/lib/state/workbench-context"
import { TimelineStore } from "@/lib/timeline/store"
import type { FilePart, ImagePart, QueuedMessage } from "@/lib/types/v3"
import { useDevice, useDriveQuota } from "@/lib/workbench/device-info"
import { toggleIn, useLocalPrefs } from "@/lib/workbench/local-prefs"
import { cn } from "@/lib/utils"
import { agentLabel, sessionHref, sessionKey, tildePath } from "@/lib/workbench/tree"

const WebThreadItem: ThreadItem = ({ id, anchor, children }) => (
  <MessageScrollerItem data-turn-id={id} scrollAnchor={anchor}>
    {children}
  </MessageScrollerItem>
)

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default function SessionWorkspacePage() {
  const params = useParams<{ deviceId: string; sessionId: string }>()
  const router = useRouter()
  const { t, locale } = useI18n()
  const { activeAccount, clientIdentity, sessions, refreshSessions } = useWorkbench()

  const deviceId = decodeURIComponent(params.deviceId ?? "")
  const sessionId = decodeURIComponent(params.sessionId ?? "")
  const { device, tunnelDevice, trust, encrypted, info, tunnelManager } = useDevice(deviceId)
  const quota = useDriveQuota()
  const [prefs, setPrefs] = useLocalPrefs(activeAccount?.accountId)

  const summary = useMemo(
    () => sessions.find((s) => s.device_id === deviceId && s.id === sessionId) ?? null,
    [sessions, deviceId, sessionId]
  )

  const [store] = useState(() => new TimelineStore())
  const timeline = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [connectError, setConnectError] = useState<{ code: string; message: string } | null>(null)
  const [connecting, setConnecting] = useState(true)
  const [retryNonce, setRetryNonce] = useState(0)
  const [pairOpen, setPairOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [openFile, setOpenFile] = useState<{ path: string; nonce: number } | null>(null)
  const [inject, setInject] = useState<{ text: string; nonce: number } | null>(null)
  // Rewinding drops a message and everything after it (and the agent's context): asked first. With `content`, the
  // prompt is sent again (regenerate).
  const [rewindTarget, setRewindTarget] = useState<{ id: string; content?: string } | null>(null)

  const getScrollRoot = useCallback(() => viewportRef.current, [])
  useWindowTrimmer(store, getScrollRoot)

  // Live watch over the device tunnel (normal or Noise_IK E2EE). A dropped stream is watched again with backoff (the
  // protocol is snapshot-then-replace, so a re-watch is the whole reconnect); pairing problems stop it.
  // A new conversation starts empty; the device going offline or coming back keeps what is shown (a re-watch is
  // snapshot-then-replace anyway).
  useEffect(() => {
    store.reset()
  }, [sessionId, store])

  useEffect(() => {
    const abort = new AbortController()
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
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
          // Pairing problems need the reader; a failed handshake (the device restarting, a network blip) is retried.
          if (err instanceof PairingError && err.code !== "e2e_handshake_failed") {
            setConnectError({ code: err.code, message: err.message })
            return
          }
          setConnectError(
            err instanceof PairingError
              ? { code: err.code, message: err.message }
              : { code: "watch_error", message: errorText(err) }
          )
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
    const s = store.get()
    if (!tunnelManager || !tunnelDevice || s.loadingOlder || !s.has_more) return
    store.setLoadingOlder(true)
    try {
      const page = await tunnelManager.listMessages(tunnelDevice, {
        id: sessionId,
        before_seq: s.messages[0]?.seq,
        limit: 100,
      })
      store.prependOlder(page.messages, page.has_more)
    } catch (err) {
      store.setLoadingOlder(false)
      toast.error(errorText(err))
    }
  }, [sessionId, store, tunnelDevice, tunnelManager])

  // Older pages load as the reader nears the top (v2: within 96 px).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      if (el.scrollTop < 96) void loadOlder()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [loadOlder, connecting])

  const session = timeline.session
  const control = timeline.control
  const agentId = session?.agent || summary?.agent || ""
  const agentName = agentLabel(agentId, info.status?.runtimes)
  const cwd = session?.cwd || summary?.cwd
  const title = session?.title || summary?.title || t("wb.untitled")
  const running = control?.state === "running"
  const offline = device?.presence === "offline"
  const readOnly = !device || offline || Boolean(connectError)
  const pinned = Boolean(summary?.pinned) || prefs.pins.includes(`${deviceId}:${sessionId}`)

  // The sidebar's list is a fan-out snapshot: when this conversation's state or title changes, refresh it so its
  // running / waiting marks and title follow (the Connector's watch_list stream is not wired to the Web yet).
  const liveState = control?.state
  const liveTitle = session?.title
  useEffect(() => {
    if (!liveState) return
    const timer = window.setTimeout(() => void refreshSessions(), 600)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveState, liveTitle, control?.pending.length])

  // ── Attachments ──
  const ports = useTransferPorts(tunnelManager, tunnelDevice)
  const drafts = useDraftAttachments({
    ports,
    sessionId,
    encrypted,
    rpcMaxBytes: info.settings?.max_rpc_file_bytes,
    quota,
  })

  // ── Sending ──
  const handleSubmit = useCallback(
    async (text: string, delivery: Delivery): Promise<boolean> => {
      if (!tunnelManager || !tunnelDevice || !activeAccount) return false
      const refs = drafts.items.map((d) => d.ref).filter((r): r is NonNullable<typeof r> => Boolean(r))
      if (refs.length !== drafts.items.length) {
        toast.error(drafts.busy ? t("attach.busy") : t("attach.blocked"))
        return false
      }
      const clientMsgId = `msg_${crypto.randomUUID()}`
      const sentIds = drafts.items.map((d) => d.id)
      const parts: (ImagePart | FilePart | { type: "text"; text: string })[] = [
        ...refs.map((a) =>
          a.mime.startsWith("image/") ? ({ type: "image", ...a } as const) : ({ type: "file", ...a } as const)
        ),
        ...(text ? [{ type: "text" as const, text }] : []),
      ]
      store.addOutgoing({
        id: clientMsgId,
        seq: Number.MAX_SAFE_INTEGER,
        done: true,
        role: "user",
        client_msg_id: clientMsgId,
        // As the Connector will record it, so the thread knows it is the reader's own.
        author: `user:${activeAccount.user.id}`,
        created_at: new Date().toISOString(),
        parts,
      })
      try {
        await tunnelManager.sendMessage(tunnelDevice, {
          id: sessionId,
          client_msg_id: clientMsgId,
          content: text || undefined,
          delivery,
          attachments: refs.length ? refs : undefined,
        })
        drafts.clear(sentIds)
        return true
      } catch (err) {
        store.removeOutgoing(clientMsgId)
        toast.error(errorText(err))
        return false
      }
    },
    [activeAccount, drafts, sessionId, store, t, tunnelDevice, tunnelManager]
  )

  const call = useCallback(
    async <T,>(task: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      try {
        const res = await task()
        if (ok) toast.success(ok)
        return res
      } catch (err) {
        toast.error(errorText(err))
        return undefined
      }
    },
    []
  )

  const handleStop = useCallback(() => {
    if (!tunnelManager || !tunnelDevice) return
    void call(() => tunnelManager.stopSession(tunnelDevice, sessionId))
  }, [call, sessionId, tunnelDevice, tunnelManager])

  const runRewind = useCallback(
    (target: { id: string; content?: string }) => {
      if (!tunnelManager || !tunnelDevice) return
      void call(() => tunnelManager.rewindSession(tunnelDevice, sessionId, target.id, target.content))
    },
    [call, sessionId, tunnelDevice, tunnelManager]
  )

  const handleConfig = useCallback(
    (configId: string, value: string) => {
      if (!tunnelManager || !tunnelDevice) return
      void call(async () => {
        const updated = await tunnelManager.setSessionConfig(tunnelDevice, sessionId, configId, value)
        store.apply({ type: "session", session: updated })
        // Remembered for the next conversation with this agent on this device (v2: per device + agent).
        const key = `${deviceId}:${updated.agent}`
        setPrefs((p) => ({ configByAgent: { ...p.configByAgent, [key]: { ...(p.configByAgent[key] ?? {}), [configId]: value } } }))
      })
    },
    [call, deviceId, sessionId, setPrefs, store, tunnelDevice, tunnelManager]
  )

  const rename = useCallback(
    async (next: string) => {
      if (!tunnelManager || !tunnelDevice) return
      const updated = await call(() => tunnelManager.renameSession(tunnelDevice, sessionId, next))
      if (updated) {
        store.apply({ type: "session", session: updated })
        void refreshSessions()
      }
    },
    [call, refreshSessions, sessionId, store, tunnelDevice, tunnelManager]
  )

  const lastAssistantId = useMemo(() => {
    for (let i = timeline.messages.length - 1; i >= 0; i--) {
      if (timeline.messages[i].role === "assistant") return timeline.messages[i].id
    }
    return null
  }, [timeline.messages])

  const forkAt = useCallback(
    (messageId: string) => {
      if (!tunnelManager || !tunnelDevice) return
      void call(async () => {
        const forked = await tunnelManager.forkSession(tunnelDevice, sessionId, messageId)
        toast.success(t("conv.forked"))
        void refreshSessions()
        router.push(sessionHref(deviceId, forked.id))
      })
    },
    [call, deviceId, refreshSessions, router, sessionId, t, tunnelDevice, tunnelManager]
  )

  const compact = useCallback(
    (instructions?: string) => {
      if (!tunnelManager || !tunnelDevice) return
      void call(() => tunnelManager.compactSession(tunnelDevice, sessionId, instructions), t("conv.compactStarted"))
    },
    [call, sessionId, t, tunnelDevice, tunnelManager]
  )
  const canCompact = Boolean(control?.capabilities?.compact)

  const handleDelete = async () => {
    if (!tunnelManager || !tunnelDevice) return
    setDeleting(true)
    try {
      await tunnelManager.deleteSession(tunnelDevice, sessionId)
      toast.success(t("conv.deleted"))
      setDeleteOpen(false)
      void refreshSessions()
      router.replace("/")
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ session, control, messages: timeline.messages }, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${(title || sessionId).replace(/[\\/:*?"<>|]+/g, "_")}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast.success(t("common.copied")))
        .catch(() => toast.error(t("common.copyFailed")))
    },
    [t]
  )

  // ── Side panel ──
  const wide = useMediaQuery("(min-width: 1280px)")
  const isMobile = useIsMobile()
  // Wide screens remember whether the panel is open; on phones it is a sheet opened on demand only.
  const [sheetOpen, setSheetOpen] = useState(false)
  const panelOpen = isMobile ? sheetOpen : prefs.panel.open
  const panelTab = (prefs.panel.tab as PanelTab) || "files"
  const setPanel = useCallback(
    (open: boolean, tab?: PanelTab) => {
      if (isMobile) {
        setSheetOpen(open)
        if (tab) setPrefs((p) => ({ panel: { open: p.panel.open, tab } }))
        return
      }
      setPrefs((p) => ({ panel: { open, tab: tab ?? p.panel.tab } }))
    },
    [isMobile, setPrefs]
  )

  const myName = activeAccount?.user.display_name ?? ""
  const myId = activeAccount?.user.id
  const myPub = clientIdentity?.publicKey
  const pairedClientLabel = t("conv.pairedClient")
  const threadEnv = useMemo<ThreadEnv>(
    () => ({
      me: myName,
      whoIs: (author) => {
        if (myId && author.includes(`user:${myId}`)) return null
        if (author.startsWith("e2e:")) return myPub && author.includes(myPub) ? null : pairedClientLabel
        return author
      },
      approvals: "inline",
      reduceMotion: false,
      imageSrc: (path) => sentPreview(path) ?? "",
      loadImage:
        tunnelManager && tunnelDevice
          ? (path, mime) => loadDeviceImage(tunnelManager, tunnelDevice, path, mime)
          : undefined,
      answer: (requestId, optionId) => {
        if (!tunnelManager || !tunnelDevice) return
        void call(() =>
          tunnelManager.answerApproval(tunnelDevice, { id: sessionId, request_id: requestId, option_id: optionId })
        )
      },
      open: (target) => {
        let path: string
        if (target.kind === "url") {
          // Web links open in a new tab; a path the agent linked (absolute, ~/…, relative to the conversation's
          // directory, or file://) opens in the side panel (client-experience-proposal §3.3).
          const url = target.url
          if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("file:")) {
            window.open(url, "_blank", "noopener,noreferrer")
            return
          }
          let local = url.replace(/^file:\/\//, "")
          try {
            local = decodeURIComponent(local)
          } catch {
            // A literal "%" in the path: keep it as written.
          }
          local = local.split("#")[0]
          path = local.startsWith("/") || local.startsWith("~") || !cwd ? local : `${cwd}/${local.replace(/^\.\//, "")}`
        } else {
          path = target.path
        }
        setOpenFile((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }))
        setPanel(true, "files")
      },
      copy,
      rewind: (messageId) => setRewindTarget({ id: messageId }),
      regenerate: (messageId) => {
        const s = store.get()
        const index = s.messages.findIndex((m) => m.id === messageId)
        const message = s.messages[index]
        if (!message || message.role !== "user") return
        const content = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
        if (!content.trim()) return
        // The agent restarts without the earlier turns: say so first when there are any.
        if (index > 0 || s.has_more) setRewindTarget({ id: messageId, content })
        else runRewind({ id: messageId, content })
      },
      fork: forkAt,
    }),
    [call, copy, cwd, forkAt, myId, myName, myPub, pairedClientLabel, runRewind, sessionId, setPanel, store, tunnelDevice, tunnelManager]
  )

  const commands = useMemo<ComposerCommand[]>(() => {
    const list: ComposerCommand[] = []
    if (canCompact) list.push({ name: "compact", description: t("composer.cmdCompact"), run: (arg) => compact(arg || undefined) })
    list.push({
      name: "rename",
      description: t("composer.cmdRename"),
      run: async (arg) => {
        if (arg) await rename(arg)
      },
    })
    if (lastAssistantId) list.push({ name: "fork", description: t("composer.cmdFork"), run: () => forkAt(lastAssistantId) })
    if (running) list.push({ name: "stop", description: t("composer.cmdStop"), run: handleStop })
    return list
  }, [canCompact, compact, forkAt, handleStop, lastAssistantId, rename, running, t])

  const queued = control?.queued ?? []
  const pending = control?.pending ?? []
  const queueActions = {
    onSteer: (q: QueuedMessage) =>
      tunnelManager && tunnelDevice && void call(() => tunnelManager.steerQueued(tunnelDevice, sessionId, q.client_msg_id)),
    onRemove: (q: QueuedMessage) =>
      tunnelManager && tunnelDevice && void call(() => tunnelManager.cancelQueued(tunnelDevice, sessionId, q.client_msg_id)),
    onEdit: (q: QueuedMessage) => {
      if (!tunnelManager || !tunnelDevice) return
      void call(async () => {
        await tunnelManager.cancelQueued(tunnelDevice, sessionId, q.client_msg_id)
        setInject((prev) => ({ text: q.content, nonce: (prev?.nonce ?? 0) + 1 }))
        // Its files are already on the device: they come back as ready chips.
        if (q.attachments?.length) drafts.restore(q.attachments.map(({ path, name, mime, size }) => ({ path, name, mime, size })))
      })
    },
  }

  const placeholder = offline
    ? t("composer.placeholderOffline")
    : running
      ? t("composer.placeholderRunning")
      : t("composer.placeholder", { agent: agentName || "Agent" })

  const panel = (
    <SidePanel
      tunnelManager={tunnelManager}
      device={tunnelDevice}
      sessionId={sessionId}
      cwd={cwd}
      messages={timeline.messages}
      control={control}
      tab={panelTab}
      onTab={(tab) => setPanel(true, tab)}
      onClose={() => setPanel(false)}
      openFile={openFile}
      className="h-full"
    />
  )

  const noMessages = timeline.messages.length === 0 && timeline.outgoing.length === 0
  // Nothing said yet: the greeting and the composer sit in the middle; the first message moves the composer down.
  const centered = !connecting && noMessages && !offline && !connectError && !timeline.has_more
  const drop = useDropZone((files) => drafts.add(files), !readOnly)

  return (
    <WorkbenchShell hideMobileBar>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" {...drop.handlers}>
          <DropOverlay show={drop.over} />
          <ConversationHeader
            title={title}
            deviceId={deviceId}
            deviceName={device?.name}
            agentName={agentId ? agentName : undefined}
            cwd={cwd}
            state={control?.state ?? summary?.state}
            encrypted={encrypted}
            paired={Boolean(trust)}
            pinned={pinned}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanel(!panelOpen)}
            canCompact={canCompact}
            pendingCount={pending.length}
            readOnly={readOnly}
            actions={{
              rename,
              togglePin: () => setPrefs((p) => ({ pins: toggleIn(p.pins, sessionKey({ device_id: deviceId, id: sessionId })) })),
              fork: lastAssistantId ? () => forkAt(lastAssistantId) : undefined,
              compact: () => compact(),
              details: () => setDetailsOpen(true),
              copyId: () => copy(sessionId),
              exportJson,
              remove: () => setDeleteOpen(true),
            }}
          />

          {offline && !noMessages && (
            <div className="mx-auto w-full max-w-3xl shrink-0 px-4">
              <p className="rounded-full bg-card px-4 py-2 text-xs text-muted-foreground">{t("conv.offlineReadOnly")}</p>
            </div>
          )}

          {connectError?.code === "e2e_not_paired" ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="w-full max-w-md space-y-4 rounded-card bg-card p-6 text-center">
                <LockIcon className="mx-auto size-8 text-warning" />
                <div className="space-y-1.5">
                  <h2 className="font-heading text-lg font-semibold text-foreground">{t("devices.unpaired")}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t("devices.unpairedHint")}</p>
                </div>
                <Button onClick={() => setPairOpen(true)}>{t("devices.pair")}</Button>
              </div>
            </div>
          ) : connectError && timeline.messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="w-full max-w-md space-y-4 rounded-card bg-card p-6 text-center">
                <p className="text-sm font-medium text-foreground">
                  {connectError.code === "e2e_required_locally" ? t("devices.locallyLockedError") : connectError.message}
                </p>
                <Button variant="outline" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
                  <RefreshCwIcon className="size-3.5" />
                  {t("common.refresh")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {centered ? (
                <div key="greeting" className="flex min-h-0 flex-1 flex-col items-center justify-end px-6 pb-8 text-center">
                  <p className="font-heading text-2xl font-semibold tracking-tight text-foreground">{t("conv.emptyTitle")}</p>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    {t("conv.emptyHint", {
                      agent: agentName || "Agent",
                      cwd: cwd ? tildePath(cwd) : "~",
                      device: device?.name ?? deviceId,
                    })}
                  </p>
                </div>
              ) : (
              <ScrollRootContext.Provider key="thread" value={getScrollRoot}>
                <ThreadEnvContext.Provider value={threadEnv}>
                  <MessageScroller className="min-h-0 flex-1">
                    <MessageScrollerViewport ref={viewportRef} className="px-4 pt-4 pb-6 sm:px-6">
                      <MessageScrollerContent className="mx-auto w-full max-w-3xl pb-6">
                        {timeline.loadingOlder && (
                          <div className="flex justify-center py-2">
                            <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
                          </div>
                        )}
                        {connecting && noMessages ? (
                          <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                            <LoaderCircleIcon className="size-4 animate-spin" />
                            <span>{t("common.loading")}</span>
                          </div>
                        ) : noMessages ? (
                          <p className="py-24 text-center text-sm text-muted-foreground">
                            {offline ? t("conv.offlineEmpty") : t("common.loading")}
                          </p>
                        ) : (
                          <Thread state={timeline} Item={WebThreadItem} showQueued={false} />
                        )}
                      </MessageScrollerContent>
                    </MessageScrollerViewport>
                    <MessageScrollerButton direction="end" />
                  </MessageScroller>
                </ThreadEnvContext.Provider>
              </ScrollRootContext.Provider>
              )}

              <div key="composer" className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
                <div className="mx-auto w-full max-w-3xl">
                  {connectError && (
                    <div className="mb-2 flex items-center gap-2 rounded-full bg-surface-raised py-1 pr-1 pl-3.5 text-xs">
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {connectError.code === "e2e_required_locally"
                          ? t("devices.locallyLockedError")
                          : t("conv.connectionLost", { error: connectError.message })}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 rounded-full px-2.5 text-xs"
                        onClick={() => setRetryNonce((n) => n + 1)}
                      >
                        <RefreshCwIcon className="size-3.5" />
                        {t("common.refresh")}
                      </Button>
                    </div>
                  )}
                  <ApprovalDock
                    pending={pending}
                    messages={timeline.messages}
                    agent={agentName || "Agent"}
                    disabled={readOnly}
                    onAnswer={async (requestId, optionId) => {
                      if (!tunnelManager || !tunnelDevice) return
                      await call(() =>
                        tunnelManager.answerApproval(tunnelDevice, {
                          id: sessionId,
                          request_id: requestId,
                          option_id: optionId,
                        })
                      )
                    }}
                  />
                  <Composer
                    agent={agentName || "Agent"}
                    config={session?.config ?? []}
                    configLoading={!session}
                    onConfig={handleConfig}
                    running={running}
                    steer={control?.steer ?? "interrupt"}
                    disabled={readOnly}
                    placeholder={placeholder}
                    drafts={drafts}
                    draftKey={`${deviceId}:${sessionId}`}
                    inject={inject}
                    commands={commands}
                    context={<ContextMeter usage={control?.usage} />}
                    above={
                      <QueueRows
                        queued={queued}
                        canSteer={(control?.steer ?? "interrupt") !== "none"}
                        disabled={readOnly}
                        {...queueActions}
                      />
                    }
                    onSubmit={handleSubmit}
                    onStop={handleStop}
                    autoFocus={centered}
                  />
                </div>
              </div>
              {centered && <div key="below" aria-hidden className={cn("min-h-0 flex-[1.3]")} />}
            </>
          )}
        </div>

        {/* Side panel: beside the thread ≥ 1280, over it on medium screens, a bottom sheet on phones. */}
        {panelOpen && wide && <div className="w-[min(30rem,40vw)] shrink-0 border-l border-border">{panel}</div>}
        {panelOpen && !wide && !isMobile && (
          <div className="absolute inset-y-0 right-0 z-20 w-[min(28rem,88%)] border-l border-border bg-background shadow-xl animate-in fade-in slide-in-from-right-4 duration-200 motion-reduce:animate-none">
            {panel}
          </div>
        )}
      </div>

      {isMobile && (
        <Sheet open={panelOpen} onOpenChange={(open) => setPanel(open)}>
          <SheetContent side="bottom" showCloseButton={false} className="data-[side=bottom]:h-[85svh] rounded-t-card p-0">
            <SheetTitle className="sr-only">{t("conv.togglePanel")}</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>
      )}

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("conv.details")}</DialogTitle>
          </DialogHeader>
          <dl className="divide-y divide-border text-sm">
            {[
              [t("conv.id"), sessionId, true],
              [t("newConv.device"), device?.name ?? deviceId, false],
              [t("newConv.agent"), agentName, false],
              [t("conv.directory"), cwd ? tildePath(cwd) : "—", true],
              [t("conv.branch"), session?.branch ?? "—", true],
              [t("conv.state"), control?.state ?? summary?.state ?? "—", false],
              [t("conv.messages"), String(session?.message_count ?? timeline.messages.length), false],
              [
                t("conv.created"),
                session?.created_at ? new Date(session.created_at).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US") : "—",
                false,
              ],
            ].map(([label, value, mono]) => (
              <div key={String(label)} className="flex items-start justify-between gap-4 py-2.5">
                <dt className="shrink-0 text-muted-foreground">{label}</dt>
                <dd className={mono ? "min-w-0 font-mono text-xs break-all text-foreground" : "text-right text-foreground"}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("conv.deleteTitle", { title })}
        description={t("conv.deleteDesc")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={deleting}
        onConfirm={() => void handleDelete()}
      />

      <ConfirmDialog
        open={rewindTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRewindTarget(null)
        }}
        title={rewindTarget?.content ? t("conv.regenerateTitle") : t("conv.rewindTitle")}
        description={rewindTarget?.content ? t("conv.regenerateDesc") : t("conv.rewindDesc")}
        confirmLabel={rewindTarget?.content ? t("conv.regenerate") : t("conv.rewind")}
        cancelLabel={t("common.cancel")}
        destructive={!rewindTarget?.content}
        onConfirm={() => {
          const target = rewindTarget
          setRewindTarget(null)
          if (target) runRewind(target)
        }}
      />

      <PairDeviceDialog
        open={pairOpen}
        onOpenChange={(open) => {
          setPairOpen(open)
          if (!open) setRetryNonce((n) => n + 1)
        }}
        deviceNameHint={device?.name}
      />
    </WorkbenchShell>
  )
}
