"use client"

import "@xterm/xterm/css/xterm.css"

import type { FitAddon } from "@xterm/addon-fit"
import type { ITheme, Terminal } from "@xterm/xterm"
import { CopyIcon, LoaderCircleIcon, MonitorSmartphoneIcon, RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { TerminalExtraKeys } from "@/components/terminal/extra-keys"
import { Button } from "@/components/ui/button"
import { applyCtrl, keySequence, type ExtraKey, type KeyModifiers } from "@/lib/terminal/keys"
import {
  canType,
  controlledElsewhere,
  TerminalSession,
  type TerminalSessionState,
  type TerminalTransport,
} from "@/lib/terminal/session"
import {
  bindTouch,
  createWheelEvent,
  fitFontSize,
  pinchFontSize,
  pointToCell,
  selectionSpan,
  wordRange,
  type Point,
  type ScreenGeometry,
} from "@/lib/terminal/touch"
import type { TerminalInfo } from "@/lib/types/v3"
import { cn } from "@/lib/utils"

const MONO_FONT =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace'
const DESKTOP_FONT = 13
const TOUCH_FONT = 12
const MIN_VIEWER_FONT = 7
/** Keystrokes within this window of a keyboard / IME / paste event count as typing (may auto-claim). */
const TYPING_WINDOW_MS = 120

/** Holds the session created inside the effect so React can subscribe without setState-in-effect. */
class SessionSlot {
  session: TerminalSession | null = null
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null

  set(session: TerminalSession | null): void {
    this.unsubscribe?.()
    this.session = session
    this.unsubscribe = session ? session.subscribe(() => this.emit()) : null
    this.emit()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): TerminalSessionState | null => this.session?.getState() ?? null

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

const getServerState = () => null

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches
}

/** Resolve the Anywhere UI tokens to concrete colors for xterm.js (it cannot read CSS variables). */
function readTheme(host: HTMLElement): ITheme {
  const probe = document.createElement("span")
  probe.style.display = "none"
  host.appendChild(probe)
  const resolve = (value: string) => {
    probe.style.color = value
    return getComputedStyle(probe).color
  }
  const theme: ITheme = {
    background: resolve("var(--background)"),
    foreground: resolve("var(--foreground)"),
    cursor: resolve("var(--foreground)"),
    cursorAccent: resolve("var(--background)"),
    selectionBackground: resolve("color-mix(in oklab, var(--foreground) 28%, transparent)"),
    scrollbarSliderBackground: resolve("color-mix(in oklab, var(--foreground) 16%, transparent)"),
    scrollbarSliderHoverBackground: resolve("color-mix(in oklab, var(--foreground) 26%, transparent)"),
    scrollbarSliderActiveBackground: resolve("color-mix(in oklab, var(--foreground) 34%, transparent)"),
  }
  probe.remove()
  return theme
}

function isTypingKey(ev: KeyboardEvent): boolean {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(ev.key)) return false
  // Copy shortcuts must keep working for viewers.
  if ((ev.metaKey || ev.ctrlKey) && ["c", "C", "a", "A"].includes(ev.key)) return false
  return true
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export interface TerminalViewProps {
  info: TerminalInfo
  transport: TerminalTransport
  /** "control" when this client just created the terminal. */
  initialMode: "view" | "control"
  label: string
  className?: string
  /** Drive the view from outside (the mobile render bundle: native's extra-keys bar over the bridge). */
  handle?: Ref<TerminalViewHandle>
  /** Show the on-screen extra-keys row on touch screens (default). Off where native draws its own bar. */
  extraKeys?: boolean
  /** Fill the parent's height instead of the fixed terminal height (the mobile bundle's full-screen terminal). */
  fill?: boolean
  /**
   * Live `control` frames for this terminal (controller, generation): the list beside the view fetched its rows
   * once, so it updates the attached row from here instead of showing a stale "controlled by".
   */
  onControl?: (control: { controller: TerminalInfo["controller"]; generation: number; you: boolean }) => void
  /** Its program has ended. */
  onExit?: (exit: { code: number | null; signal: string | null }) => void
}

export interface TerminalViewHandle {
  /** An extra key, as the on-screen row sends it (applies, then clears, the latched Ctrl). */
  key(key: ExtraKey, mods?: KeyModifiers): void
  /** Bytes typed by the user (auto-claims like the keyboard). */
  type(data: string): void
  toggleCtrl(): void
}

export function TerminalView({
  info,
  transport,
  initialMode,
  label,
  className,
  handle,
  extraKeys = true,
  fill = false,
  onControl,
  onExit,
}: TerminalViewProps) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const termElRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** Re-measure; `explicit` lifts a keep-size lock (the "fit to my window" button). */
  const relayoutRef = useRef<((explicit?: boolean) => void) | null>(null)
  // The list refreshes TerminalInfo after every resize; only the first size seeds the instance.
  const initialSizeRef = useRef({ cols: info.cols, rows: info.rows })
  const [slot] = useState(() => new SessionSlot())
  const state = useSyncExternalStore(slot.subscribe, slot.getState, getServerState)
  const onControlRef = useRef(onControl)
  useEffect(() => {
    onControlRef.current = onControl
  }, [onControl])
  // Report control changes once the attach is live (before that the state is the empty initial one).
  const controller = state?.controller ?? null
  const controllerKey = controller ? `${controller.client_id}:${controller.connected ? 1 : 0}` : "none"
  const live = state?.status === "live"
  const generation = state?.generation ?? 0
  const you = state?.you ?? false
  useEffect(() => {
    if (!live) return
    onControlRef.current?.({ controller, generation, you })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controllerKey, generation, you, live])
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])
  const exit = state?.status === "exited" ? state.exit : null
  useEffect(() => {
    if (exit) onExitRef.current?.(exit)
  }, [exit])
  const coarse = useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia("(pointer: coarse)")
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    isCoarsePointer,
    () => false
  )
  const [ctrlActive, setCtrlActive] = useState(false)
  const ctrlRef = useRef(false)
  const [copyAt, setCopyAt] = useState<Point | null>(null)
  const [copied, setCopied] = useState(false)
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const setCtrl = useCallback((value: boolean) => {
    ctrlRef.current = value
    setCtrlActive(value)
  }, [])

  const flashCopied = useCallback(() => {
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [])

  // ── xterm.js + session lifecycle ──
  useEffect(() => {
    const host = hostRef.current
    const termEl = termElRef.current
    if (!host || !termEl) return
    let disposed = false
    const cleanups: (() => void)[] = []
    const touch = isCoarsePointer()
    let baseFont = touch ? TOUCH_FONT : DESKTOP_FONT

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ])
      if (disposed) return

      const term = new Terminal({
        fontFamily: MONO_FONT,
        fontSize: baseFont,
        cols: Math.max(2, initialSizeRef.current.cols),
        rows: Math.max(1, initialSizeRef.current.rows),
        scrollback: 5000,
        cursorBlink: true,
        disableStdin: true,
        allowProposedApi: false,
        macOptionIsMeta: true,
        theme: readTheme(host),
      })
      const fit: FitAddon = new FitAddon()
      term.loadAddon(fit)
      term.open(termEl)
      termRef.current = term
      cleanups.push(() => {
        termRef.current = null
        term.dispose()
      })
      // xterm.js already sets these; keep them explicit for the mobile WebView (doc §5).
      const textarea = term.textarea
      textarea?.setAttribute("autocorrect", "off")
      textarea?.setAttribute("autocapitalize", "off")
      textarea?.setAttribute("autocomplete", "off")
      textarea?.setAttribute("spellcheck", "false")

      const screenEl = () => (term.element?.querySelector(".xterm-screen") as HTMLElement | null) ?? term.element ?? null
      const measureCell = () => {
        const screen = screenEl()
        if (!screen || term.cols < 1 || term.rows < 1) return null
        const w = screen.offsetWidth / term.cols
        const h = screen.offsetHeight / term.rows
        return w > 0 && h > 0 ? { w, h } : null
      }
      const geometry = (): ScreenGeometry | null => {
        const screen = screenEl()
        if (!screen) return null
        const rect = screen.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, cols: term.cols, rows: term.rows }
      }

      // ── Session ──
      const session = new TerminalSession({
        terminalId: info.id,
        transport,
        label,
        initialMode,
        owner: info.owner,
        keepSizeOnAutoClaim: false,
        renderer: {
          reset(data, cols, rows) {
            term.reset()
            term.resize(cols, rows)
            term.write(data)
          },
          write(data) {
            term.write(data)
          },
          resize(cols, rows) {
            term.resize(cols, rows)
            scheduleLayout()
          },
        },
      })
      cleanups.push(() => session.dispose())

      // ── Layout: controller fills the window, viewers render at the controller's size ──
      const viewerLayout = () => {
        const s = session.getState()
        return !(s.you && !s.sizeLocked)
      }
      const localSize = (): { cols: number; rows: number } | null => {
        const font = term.options.fontSize ?? baseFont
        if (!viewerLayout() && font === baseFont) {
          const proposed = fit.proposeDimensions()
          if (proposed && Number.isFinite(proposed.cols) && Number.isFinite(proposed.rows)) {
            return { cols: proposed.cols, rows: proposed.rows }
          }
        }
        const cell = measureCell()
        if (!cell) return null
        const k = baseFont / font
        return {
          cols: Math.max(2, Math.floor((host.clientWidth - 14) / (cell.w * k))),
          rows: Math.max(1, Math.floor(host.clientHeight / (cell.h * k))),
        }
      }
      let layoutFrame = 0
      let explicitPending = false
      let fontPasses = 0
      const applyLayout = () => {
        layoutFrame = 0
        if (disposed) return
        const s = session.getState()
        const viewer = viewerLayout()
        termEl.dataset.layout = viewer ? "viewer" : "controller"
        let font = baseFont
        if (viewer && s.renderCols > 0) {
          const cell = measureCell()
          const current = term.options.fontSize ?? baseFont
          if (cell) font = fitFontSize(host.clientWidth - 8, s.renderCols, cell.w / current, baseFont, MIN_VIEWER_FONT)
        }
        if (term.options.fontSize !== font && fontPasses < 3) {
          // Cell metrics change with the font: measure again next frame (bounded, rounding can flip-flop).
          fontPasses++
          term.options.fontSize = font
          scheduleLayout(explicitPending)
          return
        }
        fontPasses = 0
        const size = localSize()
        if (size) session.localResize(size.cols, size.rows, { explicit: explicitPending })
        explicitPending = false
      }
      const scheduleLayout = (explicit = false) => {
        if (explicit) explicitPending = true
        if (layoutFrame || disposed) return
        layoutFrame = requestAnimationFrame(applyLayout)
      }
      relayoutRef.current = scheduleLayout
      cleanups.push(() => {
        relayoutRef.current = null
        if (layoutFrame) cancelAnimationFrame(layoutFrame)
      })

      const observer = new ResizeObserver(() => scheduleLayout())
      observer.observe(host)
      cleanups.push(() => observer.disconnect())

      // Soft keyboard: shrink the host to the visible viewport so the controller's rows follow it.
      const vv = window.visualViewport
      if (touch && vv) {
        const onViewport = () => {
          const top = host.getBoundingClientRect().top
          const available = Math.max(160, Math.floor(vv.height + vv.offsetTop - top - 8))
          host.style.maxHeight = `${available}px`
        }
        vv.addEventListener("resize", onViewport)
        cleanups.push(() => vv.removeEventListener("resize", onViewport))
      }

      // Re-theme on light / dark switches (next-themes toggles a class on <html>).
      const themeObserver = new MutationObserver(() => {
        term.options.theme = readTheme(host)
      })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      cleanups.push(() => themeObserver.disconnect())

      // ── Input ──
      let lastTypingAt = -Infinity
      const markTyping = () => {
        lastTypingAt = performance.now()
      }
      const onKeyDown = (ev: KeyboardEvent) => {
        markTyping()
        if (!canType(session.getState()) && isTypingKey(ev)) session.noteBlockedTyping()
      }
      termEl.addEventListener("keydown", onKeyDown, true)
      for (const type of ["compositionend", "paste", "beforeinput"] as const) {
        termEl.addEventListener(type, markTyping, true)
        cleanups.push(() => termEl.removeEventListener(type, markTyping, true))
      }
      cleanups.push(() => termEl.removeEventListener("keydown", onKeyDown, true))

      const dataSub = term.onData((data) => {
        const typed = performance.now() - lastTypingAt < TYPING_WINDOW_MS
        if (typed && ctrlRef.current) {
          data = applyCtrl(data)
          setCtrl(false)
        }
        session.input(data, { intent: typed ? "type" : "pointer" })
      })
      const binarySub = term.onBinary((data) => session.input(data, { intent: "pointer", binary: true }))
      cleanups.push(() => {
        dataSub.dispose()
        binarySub.dispose()
      })

      // Copy on selection (mouse). Touch uses the long-press toolbar instead.
      const onMouseUp = () => {
        if (!term.hasSelection()) return
        const text = term.getSelection()
        if (text) void writeClipboard(text).then((ok) => ok && flashCopied())
      }
      termEl.addEventListener("mouseup", onMouseUp)
      cleanups.push(() => termEl.removeEventListener("mouseup", onMouseUp))

      // ── Touch (coarse pointers only, bound to the terminal element only) ──
      if (touch) {
        let anchor: { row: number; start: number; end: number } | null = null
        let pinchBase: number | null = null
        const dispatchPointer = (type: "mousedown" | "mouseup", at: Point) => {
          screenEl()?.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons: type === "mousedown" ? 1 : 0, clientX: at.x, clientY: at.y })
          )
        }
        const lineCells = (absRow: number): string[] => {
          const line = term.buffer.active.getLine(absRow)
          const cells: string[] = []
          for (let x = 0; x < term.cols; x++) {
            const cell = line?.getCell(x)
            const chars = cell?.getChars() ?? ""
            cells.push(cell && cell.getWidth() === 0 ? (cells[x - 1] ?? " ") : chars || " ")
          }
          return cells
        }
        const unbind = bindTouch(termEl, {
          scroll(deltaY, at) {
            // xterm.js decides: local scrollback, arrow keys (alt screen) or mouse reports (controller only).
            screenEl()?.dispatchEvent(createWheelEvent(deltaY, at))
          },
          tap(at) {
            setCopyAt(null)
            if (term.hasSelection()) term.clearSelection()
            const s = session.getState()
            if (!canType(s)) return
            term.focus()
            if (s.you && term.modes.mouseTrackingMode !== "none") {
              dispatchPointer("mousedown", at)
              dispatchPointer("mouseup", at)
            }
          },
          selectStart(at) {
            const g = geometry()
            if (!g) return
            setCopyAt(null)
            const cell = pointToCell(at, g)
            const row = term.buffer.active.viewportY + cell.row
            const word = wordRange(lineCells(row), cell.col)
            anchor = { row, start: word.start, end: word.end }
            term.select(word.start, row, word.end - word.start)
          },
          selectMove(at) {
            const g = geometry()
            if (!g || !anchor) return
            const cell = pointToCell(at, g)
            const span = selectionSpan(anchor, { row: term.buffer.active.viewportY + cell.row, col: cell.col }, term.cols)
            term.select(span.col, span.row, span.length)
          },
          selectEnd(at) {
            anchor = null
            if (!term.hasSelection()) return
            const rect = host.getBoundingClientRect()
            setCopyAt({ x: at.x - rect.left + host.scrollLeft, y: at.y - rect.top + host.scrollTop })
          },
          pinch(scale) {
            if (pinchBase == null) pinchBase = baseFont
            const next = pinchFontSize(pinchBase, 1, scale)
            if (next !== baseFont) {
              baseFont = next
              scheduleLayout()
            }
          },
          pinchEnd() {
            pinchBase = null
            // A deliberate zoom: the controller's rows / cols follow it (session debounces the resize).
            scheduleLayout(true)
          },
        })
        cleanups.push(unbind)
      }

      // ── State → xterm options, rejected toasts ──
      let lastRejectedAt = 0
      let lastLayoutKey = ""
      const onState = () => {
        const s = session.getState()
        const stdinOff = !canType(s)
        if (term.options.disableStdin !== stdinOff) term.options.disableStdin = stdinOff
        if (s.lastRejected && s.lastRejected.at !== lastRejectedAt) {
          lastRejectedAt = s.lastRejected.at
          if (s.lastRejected.reason !== "agent_owned") toast.message(tRef.current("terminal.rejected"))
        }
        // Re-fit when the rendered size or the role changes (snapshot, control hand-over, keep_size).
        const layoutKey = `${viewerLayout()}:${s.renderCols}x${s.renderRows}`
        if (layoutKey !== lastLayoutKey) {
          lastLayoutKey = layoutKey
          scheduleLayout()
        }
      }
      cleanups.push(session.subscribe(onState))

      slot.set(session)
      cleanups.push(() => slot.set(null))
      const initial = localSize()
      if (initial) session.localResize(initial.cols, initial.rows)
      session.start()
      onState()
      if (initialMode === "control") term.focus()
    })()

    return () => {
      disposed = true
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  }, [flashCopied, info.id, info.owner, initialMode, label, setCtrl, slot, transport])

  const session = slot.session
  const handleKey = (key: ExtraKey, mods: KeyModifiers = {}) => {
    const term = termRef.current
    if (!session || !term) return
    const seq = keySequence(key, { ...mods, ctrl: mods.ctrl || ctrlRef.current }, { applicationCursorKeys: term.modes.applicationCursorKeysMode })
    setCtrl(false)
    session.input(seq, { intent: "type" })
    term.focus()
  }
  useImperativeHandle(handle, () => ({
    key: handleKey,
    type: (data) => void session?.input(data, { intent: "type" }),
    toggleCtrl: () => setCtrl(!ctrlRef.current),
  }))
  const handleCopySelection = async () => {
    const term = termRef.current
    if (!term) return
    const text = term.getSelection()
    setCopyAt(null)
    term.clearSelection()
    if (text && (await writeClipboard(text))) flashCopied()
    else toast.error(t("common.copyFailed"))
  }

  const status = state?.status ?? "connecting"
  const typing = state ? canType(state) : false
  const elsewhere = state ? controlledElsewhere(state) : false
  const controllerName = state?.controller?.label || t("terminal.anotherDevice")

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {/* Status / control bar */}
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-background px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {(status === "connecting" || status === "reconnecting" || state?.claimPending) && (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          )}
          {status === "connecting" && t("terminal.connecting")}
          {status === "reconnecting" && t("terminal.reconnecting", { attempt: Math.max(1, state?.attempt ?? 1) })}
          {status === "live" &&
            (state?.claimPending
              ? t("terminal.claiming")
              : state?.readOnly
                ? t("terminal.agentOwned")
                : state?.you
                  ? t("terminal.youControl")
                  : elsewhere
                    ? state?.controller?.connected === false
                      ? t("terminal.controllerAway", { name: controllerName })
                      : t("terminal.controlledBy", { name: controllerName })
                    : t("terminal.noController"))}
          {status === "exited" &&
            (state?.exit?.signal
              ? t("terminal.exitedSignal", { signal: state.exit.signal })
              : t("terminal.exited", { code: state?.exit?.code ?? 0 }))}
          {status === "closed" && t("terminal.closed")}
        </span>
        {state && status === "live" && state.cols > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {state.cols}×{state.rows}
          </span>
        )}
        {copied && <span className="text-muted-foreground">{t("terminal.copied")}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {status === "reconnecting" && (
            <Button size="xs" variant="outline" onClick={() => session?.reconnectNow()}>
              <RefreshCwIcon />
              {t("terminal.reconnectNow")}
            </Button>
          )}
          {status === "live" && !state?.readOnly && elsewhere && !state?.takeoverPrompt && (
            <>
              <Button size="xs" onClick={() => session?.claim({ keepSize: coarse })}>
                {t("terminal.takeOver")}
              </Button>
            </>
          )}
          {status === "live" && state?.you && state.sizeLocked && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => relayoutRef.current?.(true)}
            >
              <MonitorSmartphoneIcon />
              {t("terminal.fitWindow")}
            </Button>
          )}
          {status === "live" && state?.you && (
            <Button size="xs" variant="outline" onClick={() => session?.release()}>
              {t("terminal.release")}
            </Button>
          )}
        </span>
      </div>

      {info.mode !== "pty" && (
        <p className="rounded-xl bg-banner px-3 py-2 text-xs text-banner-foreground">{t("terminal.noPty")}</p>
      )}

      {state?.takeoverPrompt && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-raised px-3 py-2 text-xs">
          <span className="text-foreground">{t("terminal.takeOverPrompt", { name: controllerName })}</span>
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Button size="xs" onClick={() => session?.claim({ keepSize: false })}>
              {t("terminal.takeOver")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => session?.claim({ keepSize: true })}>
              {t("terminal.takeOverKeepSize")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => session?.dismissTakeoverPrompt()}>
              {t("common.cancel")}
            </Button>
          </span>
        </div>
      )}

      {/* Terminal */}
      <div
        ref={hostRef}
        className={cn(
          "relative min-h-40 overflow-auto rounded-xl bg-background p-1",
          fill ? "flex-1" : "h-[min(64dvh,560px)]",
          status !== "live" && status !== "exited" && "opacity-80"
        )}
      >
        <div
          ref={termElRef}
          data-layout="viewer"
          className={cn(
            "h-full w-full data-[layout=viewer]:h-auto data-[layout=viewer]:w-max data-[layout=viewer]:min-w-full",
            coarse && "touch-pan-x select-none"
          )}
        />
        {copyAt && (
          <div
            className="absolute z-10 -translate-x-1/2 -translate-y-full"
            style={{ left: copyAt.x, top: Math.max(36, copyAt.y - 8) }}
          >
            <Button size="xs" onClick={() => void handleCopySelection()}>
              <CopyIcon />
              {t("terminal.copy")}
            </Button>
          </div>
        )}
      </div>

      {elsewhere && status === "live" && !state?.readOnly && (
        <p className="px-1 text-xs text-muted-foreground">{t("terminal.viewOnlyHint")}</p>
      )}

      {extraKeys && coarse && status === "live" && !state?.readOnly && (
        <TerminalExtraKeys
          disabled={!typing}
          ctrlActive={ctrlActive}
          onToggleCtrl={() => setCtrl(!ctrlRef.current)}
          onKey={handleKey}
        />
      )}
    </div>
  )
}
