"use client"

import * as React from "react"
import { Plus, SquareTerminal, X } from "lucide-react"
import { useTranslations } from "next-intl"

import "./runtime-panel.css"
import { ChevronExternal } from "./runtime-icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { dashboardApi } from "@/features/dashboard/api"
import type { TerminalView } from "@/features/dashboard/types"
import { cn } from "@/lib/utils"

type TerminalPanelBodyProps = {
  token?: string | null
  connectorId?: string | null
  root?: string | null
  onClose?: () => void
  onPopOut?: () => void
}

export function TerminalPanelBody({ token, connectorId, root, onClose, onPopOut }: TerminalPanelBodyProps) {
  const t = useTranslations("dashboard.panels.terminal")
  const effectiveRoot = root?.trim() || "."
  const [terms, setTerms] = React.useState<TerminalView[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameText, setRenameText] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const termsRef = React.useRef<TerminalView[]>([])
  const renameTimerRef = React.useRef<number | null>(null)
  const generationRef = React.useRef(0)

  const canConnect = Boolean(token && connectorId)

  React.useEffect(() => {
    termsRef.current = terms
  }, [terms])

  React.useEffect(() => {
    return () => {
      if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current)
    }
  }, [])

  React.useEffect(() => {
    generationRef.current += 1
    setTerms([])
    setActiveId(null)
    setRenamingId(null)
    setRenameText("")
    setError(null)
    setBusy(false)
  }, [connectorId, effectiveRoot])

  React.useEffect(() => {
    if (!token || !connectorId) return
    const generation = generationRef.current
    let cancelled = false
    ;(async () => {
      try {
        const listed = await dashboardApi.connectorTerminalListV2(token, connectorId)
        if (cancelled || generation !== generationRef.current) return
        if (listed.result.terminals.length > 0) {
          setTerms(listed.result.terminals)
          setActiveId(listed.result.terminals[0]?.terminalId ?? null)
          return
        }
        const created = await dashboardApi.connectorTerminalCreateV2(token, connectorId, effectiveRoot, {
          cols: 80,
          rows: 24,
          label: t("title"),
        })
        if (cancelled || generation !== generationRef.current) return
        setTerms([created.result])
        setActiveId(created.result.terminalId)
      } catch (err) {
        if (!cancelled && generation === generationRef.current) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connectorId, effectiveRoot, token])

  const addTerminal = React.useCallback(async () => {
    if (!token || !connectorId) return
    setBusy(true)
    setError(null)
    try {
      const response = await dashboardApi.connectorTerminalCreateV2(token, connectorId, effectiveRoot, {
        cols: 80,
        rows: 24,
        label: `${t("title")} ${termsRef.current.length + 1}`,
      })
      setTerms((prev) => [...prev, response.result])
      setActiveId(response.result.terminalId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [connectorId, effectiveRoot, t, token])

  const cancelScheduledRename = React.useCallback(() => {
    if (renameTimerRef.current === null) return
    window.clearTimeout(renameTimerRef.current)
    renameTimerRef.current = null
  }, [])

  const scheduleRename = React.useCallback((terminal: TerminalView) => {
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current)
    renameTimerRef.current = window.setTimeout(() => {
      setRenamingId(terminal.terminalId)
      setRenameText(terminal.label)
      renameTimerRef.current = null
    }, 180)
  }, [])

  const closeTerminal = React.useCallback(
    async (terminalId: string) => {
      if (!token || !connectorId) return
      cancelScheduledRename()
      try {
        await dashboardApi.connectorTerminalCloseV2(token, connectorId, terminalId)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      setTerms((prev) => {
        const next = prev.filter((term) => term.terminalId !== terminalId)
        if (activeId === terminalId) setActiveId(next[0]?.terminalId ?? null)
        return next
      })
    },
    [activeId, cancelScheduledRename, connectorId, token],
  )

  const renameTerminal = React.useCallback(
    async (terminalId: string, label: string) => {
      if (!token || !connectorId) return
      const nextLabel = label.trim()
      setRenamingId(null)
      if (!nextLabel) return
      setTerms((prev) => prev.map((term) => (term.terminalId === terminalId ? { ...term, label: nextLabel } : term)))
      try {
        const response = await dashboardApi.connectorTerminalRenameV2(token, connectorId, terminalId, nextLabel)
        setTerms((prev) =>
          prev.map((term) => (term.terminalId === terminalId ? { ...term, ...response.result } : term)),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [connectorId, token],
  )

  const handleTerminalError = React.useCallback((message: string) => {
    setError(message)
  }, [])

  return (
    <Card size="sm" className="aa-rt-pane aa-term">
      <CardHeader className="aa-rt-hd">
        <CardTitle className="aa-rt-title">
          <SquareTerminal className="size-3.5" />
          {t("title")}
        </CardTitle>
        <ScrollArea
          className="aa-term-tabs-scroll"
          contentWide
          viewportProps={{
            role: "tablist",
            onWheel: (event) => {
              const scroll = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
              if (!scroll) return
              event.currentTarget.scrollLeft += scroll
              event.preventDefault()
            },
          }}
        >
          <div className="aa-term-tabs">
            {terms.map((term) =>
              renamingId === term.terminalId ? (
                <input
                  key={term.terminalId}
                  className="aa-term-tab active"
                  value={renameText}
                  autoFocus
                  onChange={(event) => setRenameText(event.target.value)}
                  onBlur={() => void renameTerminal(term.terminalId, renameText || term.label)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void renameTerminal(term.terminalId, renameText || term.label)
                    if (event.key === "Escape") setRenamingId(null)
                  }}
                  style={{ width: 120, padding: "0 8px" }}
                />
              ) : (
                <button
                  key={term.terminalId}
                  role="tab"
                  type="button"
                  className={cn(
                    "aa-term-tab",
                    activeId === term.terminalId && "active",
                    term.status === "exited" && "exited",
                  )}
                  onClick={(event) => {
                    if (event.detail >= 3) {
                      cancelScheduledRename()
                      void closeTerminal(term.terminalId)
                      return
                    }
                    setActiveId(term.terminalId)
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    void closeTerminal(term.terminalId)
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault()
                  }}
                  onDoubleClick={() => scheduleRename(term)}
                  title={`${term.label} · ${t("pid")} ${term.pid ?? "?"}${
                    term.status === "exited" ? ` (${t("exitCode", { code: term.exitCode ?? "?" })})` : ""
                  }`}
                >
                  <span className="dot" />
                  <span className="label">{term.label}</span>
                  <span
                    className="close"
                    onClick={(event) => {
                      event.stopPropagation()
                      void closeTerminal(term.terminalId)
                    }}
                    aria-label={t("closeTerminal", { label: term.label })}
                  >
                    <X className="size-3" />
                  </span>
                </button>
              ),
            )}
            <button
              className="aa-term-add"
              type="button"
              onClick={addTerminal}
              disabled={!canConnect || busy}
              title={t("newTerminal")}
              aria-label={t("newTerminal")}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        <Separator orientation="vertical" className="aa-rt-sep" />
        <div className="aa-rt-acts">
          {onPopOut ? (
            <Button
              className="aa-rt-iconbtn"
              variant="ghost"
              size="icon-sm"
              type="button"
              title={t("openWindow")}
              aria-label={t("openWindow")}
              onClick={onPopOut}
            >
              <ChevronExternal />
            </Button>
          ) : null}
          {onClose ? (
            <Button
              className="aa-rt-iconbtn"
              variant="ghost"
              size="icon-sm"
              type="button"
              title={t("close")}
              aria-label={t("close")}
              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="aa-rt-content">
        <div className="aa-term-host">
          {error ? <div className="aa-term-status text-destructive">{error}</div> : null}
          {!canConnect ? <div className="aa-term-status">{t("noConnector")}</div> : null}
          {terms.map((term) => (
            <div
              key={`${connectorId}:${term.terminalId}`}
              className={cn("aa-term-host-layer", activeId === term.terminalId && "active")}
            >
              {token && connectorId ? (
                <XtermHost
                  token={token}
                  connectorId={connectorId}
                  terminal={term}
                  active={activeId === term.terminalId}
                  onError={handleTerminalError}
                />
              ) : null}
            </div>
          ))}
          {terms.length === 0 && canConnect && !error ? <div className="aa-term-status">{t("noTerminal")}</div> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function XtermHost({
  token,
  connectorId,
  terminal,
  active,
  onError,
}: {
  token: string
  connectorId: string
  terminal: TerminalView
  active: boolean
  onError: (message: string) => void
}) {
  const t = useTranslations("dashboard.panels.terminal")
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = React.useState<"connecting" | "open" | "exited">("connecting")

  React.useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return

    let term: import("@xterm/xterm").Terminal | null = null
    let fit: import("@xterm/addon-fit").FitAddon | null = null
    let socket: WebSocket | null = null
    let resizeObserver: ResizeObserver | null = null
    let lastSeenSeq = 0
    let lastSentSize: { cols: number; rows: number } | null = null
    let resizeFrame: number | null = null
    let exitPrinted = false

    const sendResize = () => {
      if (!term) return
      const cols = term.cols
      const rows = term.rows
      if (lastSentSize?.cols === cols && lastSentSize.rows === rows) return
      lastSentSize = { cols, rows }
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }))
      }
    }

    const printExit = (exitCode: number | null | undefined) => {
      if (!term || exitPrinted) return
      exitPrinted = true
      setStatus("exited")
      term.writeln("")
      term.writeln(
        `\x1b[2m[${
          exitCode != null ? t("processExitedWithCode", { code: exitCode }) : t("processExited")
        }]\x1b[0m`,
      )
    }

    ;(async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ])
      await import("@xterm/xterm/css/xterm.css")
      if (cancelled) return
      term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: 12.5,
        fontFamily: '"Menlo", "JetBrains Mono", "SF Mono", monospace',
        theme: {
          background: "#000000",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          selectionBackground: "rgba(255,255,255,0.15)",
        },
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.open(host)
      fit.fit()
      term.focus()

      term.onData((data) => {
        if (socket?.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: "input", data: utf8ToBase64(data) }))
      })

      resizeObserver = new ResizeObserver(() => {
        if (!fit || !term) return
        if (resizeFrame != null) cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null
          if (!fit || !term) return
          try {
            fit.fit()
          } catch {
            return
          }
          sendResize()
        })
      })
      resizeObserver.observe(host)

      socket = new WebSocket(connectorTerminalStreamUrl(connectorId, terminal.terminalId, token))
      socket.onopen = () => {
        if (cancelled) return
        setStatus("open")
        sendResize()
      }
      socket.onmessage = (event) => {
        if (cancelled || !term) return
        let message: unknown
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (!isTerminalStreamMessage(message)) return
        if (message.type === "replay") {
          lastSeenSeq = message.seq
          term.reset()
          term.write(base64ToBytes(message.data))
        } else if (message.type === "output") {
          if (message.seq <= lastSeenSeq) return
          lastSeenSeq = message.seq
          term.write(base64ToBytes(message.data))
        } else if (message.type === "exit") {
          printExit(message.exitCode)
        } else if (message.type === "error") {
          onError(message.message)
        }
      }
      socket.onerror = () => {
        if (!cancelled) onError(t("websocketError"))
      }
      socket.onclose = () => {
        if (!cancelled && !exitPrinted) setStatus("connecting")
      }
    })().catch((err) => {
      if (!cancelled) onError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      cancelled = true
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      socket?.close()
      term?.dispose()
    }
  }, [connectorId, onError, t, terminal.terminalId, token])

  React.useEffect(() => {
    if (!active) return
    const host = hostRef.current
    const helper = host?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
    helper?.focus()
  }, [active])

  return (
    <>
      <div
        ref={hostRef}
        onClick={() => {
          const helper = hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
          helper?.focus()
        }}
        style={{ position: "absolute", inset: 0 }}
      />
      {status !== "open" ? (
        <div className="aa-term-status">
          {status === "connecting" ? t("connecting") : null}
          {status === "exited" ? t("exited") : null}
        </div>
      ) : null}
    </>
  )
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0)
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

type TerminalStreamMessage =
  | { type: "replay"; data: string; seq: number }
  | { type: "output"; data: string; seq: number }
  | { type: "exit"; exitCode?: number | null }
  | { type: "error"; message: string }
  | { type: "pong" }

function isTerminalStreamMessage(value: unknown): value is TerminalStreamMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Record<string, unknown>
  if (message.type === "replay" || message.type === "output") {
    return typeof message.data === "string" && typeof message.seq === "number"
  }
  if (message.type === "exit") return true
  if (message.type === "error") return typeof message.message === "string"
  if (message.type === "pong") return true
  return false
}

function connectorTerminalStreamUrl(connectorId: string, terminalId: string, token: string): string {
  const apiBase = process.env.NEXT_PUBLIC_AGENTS_ANYWHERE_API?.replace(/\/$/, "") || ""
  const path = `/connectors/${encodeURIComponent(connectorId)}/terminals-v2/${encodeURIComponent(terminalId)}/stream`
  const url = new URL(path, apiBase || window.location.origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", token)
  url.searchParams.set("fromSeq", "0")
  return url.toString()
}
