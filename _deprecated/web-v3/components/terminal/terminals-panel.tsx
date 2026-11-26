"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PlusIcon, RefreshCwIcon, TerminalIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { TerminalView } from "@/components/terminal/terminal-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { clientLabel } from "@/lib/terminal/label"
import { createMeshTerminalTransport } from "@/lib/terminal/mesh-transport"
import type { DeviceRecord, TerminalInfo } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

/** Terminals tab of the device page: list, create / close, and the attached xterm.js view. */
export function TerminalsPanel({
  tunnelManager,
  device,
  defaultCwd,
  openNew = false,
  onNewOpened,
}: {
  tunnelManager: DeviceTunnelManager | null
  /** Must be referentially stable across presence heartbeats (see the device page). */
  device: TunnelDevice | null
  defaultCwd?: string
  /** Open a new terminal right away (to paste a command into), once; `onNewOpened` takes the wish back. */
  openNew?: boolean
  onNewOpened?: () => void
}) {
  const { t } = useI18n()
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // The terminal this page just created attaches with mode=control; any other attach starts as a viewer.
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [label] = useState(() => (typeof navigator === "undefined" ? "Web" : clientLabel(navigator.userAgent)))

  const online = device?.presence === "online"

  const load = useCallback(async () => {
    if (!tunnelManager || !device || device.presence === "offline") return
    try {
      const res = await tunnelManager.listTerminals(device)
      setTerminals(res.terminals)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [device, tunnelManager])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active && online) void load()
    })
    return () => {
      active = false
    }
  }, [load, online])

  // Controllers, viewers and exits change while the list is open: refresh it every 10 s while the page is visible
  // (quietly; a failed poll keeps the last list).
  useEffect(() => {
    if (!online || !tunnelManager || !device) return
    const poll = () => {
      if (document.visibilityState !== "visible") return
      void tunnelManager
        .listTerminals(device)
        .then((res) => setTerminals(res.terminals))
        .catch(() => undefined)
    }
    const timer = window.setInterval(poll, 10_000)
    document.addEventListener("visibilitychange", poll)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [device, online, tunnelManager])

  // The attached view's live control frames are the truth for its own row; a new generation (someone claimed or
  // released) also refreshes the whole list, since viewer counts and other rows may have moved with it.
  const lastGeneration = useRef(new Map<string, number>())
  const handleControl = useCallback(
    (id: string, control: { controller: TerminalInfo["controller"]; generation: number }) => {
      setTerminals((prev) =>
        prev.map((term) =>
          term.id === id ? { ...term, controller: control.controller, generation: control.generation } : term
        )
      )
      const seen = lastGeneration.current.get(id)
      lastGeneration.current.set(id, control.generation)
      if (seen !== undefined && seen !== control.generation) void load()
    },
    [load]
  )

  const transport = useMemo(
    () => (tunnelManager && device ? createMeshTerminalTransport(tunnelManager, device) : null),
    [device, tunnelManager]
  )

  const handleCreate = async () => {
    if (!tunnelManager || !device) return
    try {
      const created = await tunnelManager.createTerminal(device, defaultCwd ? { cwd: defaultCwd } : undefined)
      setCreatedId(created.id)
      setActiveId(created.id)
      setTerminals((prev) => [...prev.filter((term) => term.id !== created.id), created])
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const openedNew = useRef(false)
  useEffect(() => {
    if (!openNew || !online || openedNew.current) return
    openedNew.current = true
    queueMicrotask(() => {
      onNewOpened?.()
      void handleCreate()
    })
  })
  useEffect(() => {
    if (!openNew) openedNew.current = false
  }, [openNew])

  const handleClose = async (id: string) => {
    if (!tunnelManager || !device) return
    try {
      await tunnelManager.closeTerminal(device, id)
      if (activeId === id) setActiveId(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const select = (id: string) => {
    if (id !== createdId) setCreatedId(null)
    setActiveId(id)
  }

  const active = terminals.find((term) => term.id === activeId) ?? null

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("devices.tabTerminals")}</p>
        <div className="flex items-center gap-1.5">
          <Button size="icon-sm" variant="ghost" aria-label={t("terminal.refresh")} onClick={() => void load()}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button size="sm" disabled={!online} onClick={() => void handleCreate()}>
            <PlusIcon className="size-3.5" />
            {t("devices.createTerminal")}
          </Button>
        </div>
      </div>

      {terminals.length === 0 ? (
        <div className="rounded-card bg-card p-10 text-center">
          <TerminalIcon className="mx-auto size-7 stroke-[1.5] text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t("devices.noTerminals")}</p>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-2 rounded-card bg-card p-4">
            {terminals.map((term) => (
              <div
                key={term.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-xl bg-background px-3 py-2",
                  term.id === activeId && "bg-surface-raised"
                )}
              >
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => select(term.id)}>
                  <p className="truncate font-mono text-xs font-medium text-foreground">
                    {term.shell} · {term.id.slice(0, 8)}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{term.cwd}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {!term.running && <Badge variant="secondary">{t("terminal.exitedBadge")}</Badge>}
                    {term.mode !== "pty" && <Badge variant="warning">{term.mode}</Badge>}
                    {term.controller && (
                      <span className="truncate">{t("terminal.controlledBy", { name: term.controller.label })}</span>
                    )}
                    {term.viewers > 0 && (
                      <span className="tabular-nums">{t("terminal.viewers", { count: term.viewers })}</span>
                    )}
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("terminal.closeTerminal")}
                  onClick={() => void handleClose(term.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="min-w-0 rounded-card bg-card p-3 lg:col-span-2">
            {active && transport ? (
              <TerminalView
                key={active.id}
                info={active}
                transport={transport}
                initialMode={active.id === createdId ? "control" : "view"}
                label={label}
                onControl={(control) => handleControl(active.id, control)}
              />
            ) : (
              <p className="py-16 text-center text-sm text-muted-foreground">{t("terminal.selectToAttach")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
