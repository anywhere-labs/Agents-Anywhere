"use client"

import * as React from "react"
import { Plus, SquareTerminal, X } from "lucide-react"
import { useTranslations } from "next-intl"

import "./runtime-panel.css"
import { ChevronExternal } from "./runtime-icons"
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

function makeTerminalGroupId() {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `termgrp_${random}`
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
  const terminalGroupIdRef = React.useRef(makeTerminalGroupId())
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
    terminalGroupIdRef.current = makeTerminalGroupId()
  }, [connectorId, effectiveRoot])

  React.useEffect(() => {
    if (!token || !connectorId) return
    const generation = generationRef.current
    let cancelled = false
    ;(async () => {
      try {
        const created = await dashboardApi.connectorTerminalCreate(token, connectorId, effectiveRoot, {
          cols: 80,
          rows: 24,
          label: t("title"),
          ephemeralGroupId: terminalGroupIdRef.current,
        })
        if (cancelled || generation !== generationRef.current) return
        setTerms([created.terminal])
        setActiveId(created.terminal.terminalId)
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
      const response = await dashboardApi.connectorTerminalCreate(token, connectorId, effectiveRoot, {
        cols: 80,
        rows: 24,
        label: `${t("title")} ${termsRef.current.length + 1}`,
        ephemeralGroupId: terminalGroupIdRef.current,
      })
      setTerms((prev) => [...prev, response.terminal])
      setActiveId(response.terminal.terminalId)
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
        await dashboardApi.connectorTerminalClose(token, connectorId, terminalId)
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
        const response = await dashboardApi.connectorTerminalRename(token, connectorId, terminalId, nextLabel)
        setTerms((prev) =>
          prev.map((term) => (term.terminalId === terminalId ? { ...term, ...response.terminal } : term)),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [connectorId, token],
  )

  const removeTerminal = React.useCallback((terminalId: string) => {
    setTerms((prev) => {
      const next = prev.filter((item) => item.terminalId !== terminalId)
      setActiveId((current) => (current === terminalId ? next[0]?.terminalId ?? null : current))
      return next
    })
  }, [])

  const handleTerminalError = React.useCallback((message: string) => {
    setError(message)
  }, [])

  return (
    <div className="aa-rt-pane aa-term">
      <div className="aa-rt-hd">
        <div className="aa-rt-title">
          <SquareTerminal className="size-3.5" />
          {t("title")}
        </div>
        <div
          className="aa-term-tabs"
          role="tablist"
          onWheel={(event) => {
            const scroll = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
            if (!scroll) return
            event.currentTarget.scrollLeft += scroll
            event.preventDefault()
          }}
        >
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
        <span className="aa-rt-sep" />
        <div className="aa-rt-acts">
          {onPopOut ? (
            <button className="aa-rt-iconbtn" type="button" title={t("openWindow")} onClick={onPopOut}>
              <ChevronExternal />
            </button>
          ) : null}
          {onClose ? (
            <button className="aa-rt-iconbtn" type="button" title={t("close")} onClick={onClose}>
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>
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
                onClosed={removeTerminal}
              />
            ) : null}
          </div>
        ))}
        {terms.length === 0 && canConnect && !error ? <div className="aa-term-status">{t("noTerminal")}</div> : null}
      </div>
    </div>
  )
}

function XtermHost({
  token,
  connectorId,
  terminal,
  active,
  onError,
  onClosed,
}: {
  token: string
  connectorId: string
  terminal: TerminalView
  active: boolean
  onError: (message: string) => void
  onClosed: (terminalId: string) => void
}) {
  const t = useTranslations("dashboard.panels.terminal")
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = React.useState<"connecting" | "open" | "closed" | "exited">("connecting")

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
    let pendingInput = ""
    let resizeFrame: number | null = null
    let finished = false

    const sendResize = () => {
      if (!term || !socket || socket.readyState !== WebSocket.OPEN) return
      const cols = term.cols
      const rows = term.rows
      if (lastSentSize?.cols === cols && lastSentSize.rows === rows) return
      lastSentSize = { cols, rows }
      socket.send(JSON.stringify({ type: "resize", cols, rows }))
      void dashboardApi.connectorTerminalResize(token, connectorId, terminal.terminalId, cols, rows).catch(() => undefined)
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
          background: "#1d2028",
          foreground: "#d8d8dd",
          cursor: "#f4f4f5",
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
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data: utf8ToBase64(data) }))
          return
        }
        pendingInput += data
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

      const protocol = window.location.protocol === "https:" ? "wss" : "ws"
      const url = `${protocol}://${window.location.host}/connectors/${encodeURIComponent(
        connectorId,
      )}/terminals/${encodeURIComponent(terminal.terminalId)}/stream?fromSeq=0&token=${encodeURIComponent(token)}`
      socket = new WebSocket(url)
      socket.addEventListener("open", () => {
        if (cancelled) return
        setStatus("open")
        sendResize()
        if (pendingInput && socket) {
          socket.send(JSON.stringify({ type: "input", data: utf8ToBase64(pendingInput) }))
          pendingInput = ""
        }
      })
      socket.addEventListener("message", (event) => {
        if (!term) return
        try {
          const frame = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data))
          if (frame.type === "replay" || frame.type === "output") {
            if (typeof frame.seq === "number" && frame.seq <= lastSeenSeq) return
            if (typeof frame.seq === "number") lastSeenSeq = frame.seq
            term.write(base64ToBytes(frame.data))
          } else if (frame.type === "exit") {
            setStatus("exited")
            term.writeln("")
            term.writeln(
              `\x1b[2m[${
                frame.exitCode != null ? t("processExitedWithCode", { code: frame.exitCode }) : t("processExited")
              }]\x1b[0m`,
            )
          } else if (frame.type === "error") {
            onError(`${frame.code}: ${frame.message}`)
          }
        } catch {
          // Ignore malformed frames from a closing socket.
        }
      })
      socket.addEventListener("close", () => {
        if (cancelled) return
        setStatus((current) => (current === "exited" ? "exited" : "closed"))
        if (finished) return
        finished = true
        onClosed(terminal.terminalId)
      })
      socket.addEventListener("error", () => {
        if (cancelled) return
        onError(t("websocketError"))
        if (finished) return
        finished = true
        onClosed(terminal.terminalId)
      })
    })().catch((err) => {
      if (!cancelled) onError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      cancelled = true
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
      term?.dispose()
    }
  }, [connectorId, onClosed, onError, t, terminal.terminalId, token])

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
          {status === "closed" ? t("disconnected") : null}
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
