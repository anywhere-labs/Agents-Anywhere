// Framework-free client for one `aa.v3.Terminals` attach (docs/v3/terminal-proposal.md §3–§4).
//
// Consumes output frames, tracks seq / generation / controller / size, stamps `generation` on input and resize and
// applies the client-side control rules:
//   - no controller + the user types → `claim` first, send the typed bytes once `control` says `you`;
//   - someone else controls → raise a "take over?" prompt, never claim silently;
//   - viewers never send `resize`; input from a non-controller is dropped here (the Connector drops it again);
//   - reconnect with `resume_seq` and backoff, falling back to a fresh snapshot on a gap or a failed resume.
//
// The wire is abstracted as `TerminalTransport`, so the MeshCall duplex (Web, Desktop) and a native bridge (mobile
// WebView, doc §6) are interchangeable. The screen is abstracted as `TerminalRenderer` (xterm.js in the view).

import { base64ToBytes, binaryStringToBase64, textToBase64 } from "@/lib/terminal/base64"
import type {
  TerminalAttachRequest,
  TerminalController,
  TerminalInputFrame,
  TerminalOutputFrame,
  TerminalRejectReason,
} from "@/lib/types/v3"

// ── Transport & renderer seams ──────────────────────────────────────────────────────────────────────────────────

export interface TerminalLinkHandlers {
  frame(frame: TerminalOutputFrame): void
  /** The attach ended. `fatal` = do not reconnect (terminal gone, access refused). */
  closed(info?: { error?: unknown; fatal?: boolean; snapshotNext?: boolean }): void
}

export interface TerminalLink {
  send(frame: TerminalInputFrame): void
  close(): void
}

export interface TerminalTransport {
  attach(request: TerminalAttachRequest, handlers: TerminalLinkHandlers): TerminalLink
}

export interface TerminalRenderer {
  /** Replace everything with a snapshot, in a fresh terminal of cols x rows. */
  reset(data: Uint8Array, cols: number, rows: number): void
  write(data: Uint8Array): void
  resize(cols: number, rows: number): void
}

export interface TerminalTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

const defaultTimers: TerminalTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type TerminalStatus = "connecting" | "live" | "reconnecting" | "exited" | "closed"

export interface TerminalSessionState {
  status: TerminalStatus
  controller: TerminalController | null
  generation: number
  /** This attach is the controller. */
  you: boolean
  /** Authoritative PTY size (from snapshot / control). 0 until known. */
  cols: number
  rows: number
  /** Size the screen is rendered at right now. */
  renderCols: number
  renderRows: number
  /** Last output seq rendered. */
  seq: number
  exit: { code: number | null; signal: string | null } | null
  /** The user typed while another client controls: show "take over?". */
  takeoverPrompt: boolean
  claimPending: boolean
  /** A claim with keep_size is in effect: local window changes do not resize the PTY until an explicit resize. */
  sizeLocked: boolean
  /** Agent-owned terminals are read-only for everyone (reserved). */
  readOnly: boolean
  lastRejected: { reason: TerminalRejectReason; generation: number; at: number } | null
  /** Reconnect attempt counter (0 while live). */
  attempt: number
  nextRetryAt: number | null
  error: string | null
}

/** The user can type here: they control, or nobody does and typing will auto-claim. */
export function canType(state: TerminalSessionState): boolean {
  return state.status === "live" && !state.readOnly && (state.you || state.controller === null)
}

/** Someone else holds control. */
export function controlledElsewhere(state: TerminalSessionState): boolean {
  return !state.you && state.controller !== null
}

export interface TerminalSessionOptions {
  terminalId: string
  transport: TerminalTransport
  renderer: TerminalRenderer
  /** Display name sent in attach (ignored by encrypted devices). */
  label?: string
  /** "control" for the device that created the terminal. */
  initialMode?: "view" | "control"
  owner?: "user" | "agent"
  /** Local window size in cells (from fit), if known before attaching. */
  localSize?: { cols: number; rows: number }
  /** Auto-claim (typing with no controller) keeps the current size instead of applying the local window. */
  keepSizeOnAutoClaim?: boolean
  resizeDebounceMs?: number
  claimTimeoutMs?: number
  /** Controller reconnects within this window re-attach with mode=control (Connector grace is 10 s). */
  controlGraceMs?: number
  backoff?: { baseMs?: number; maxMs?: number }
  random?: () => number
  timers?: TerminalTimers
}

export type InputIntent = "type" | "pointer"
export type InputResult = "sent" | "queued" | "blocked" | "dropped"

const MAX_PENDING_CHARS = 64 * 1024

interface PendingInput {
  data: string
  binary: boolean
}

export class TerminalSession {
  private readonly opts: Required<
    Pick<TerminalSessionOptions, "resizeDebounceMs" | "claimTimeoutMs" | "controlGraceMs">
  > &
    TerminalSessionOptions
  private readonly timers: TerminalTimers
  private readonly random: () => number
  private readonly listeners = new Set<() => void>()
  private state: TerminalSessionState
  private link: TerminalLink | null = null
  private linkEpoch = 0
  private linkGotFrame = false
  private linkResumed = false
  private resumeFailures = 0
  private started = false
  private disposed = false
  private forceSnapshot = false
  private localSize: { cols: number; rows: number } | null
  private pending: PendingInput[] = []
  private pendingChars = 0
  private resizeTimer: unknown = null
  private claimTimer: unknown = null
  private retryTimer: unknown = null
  private lastSentSize: { cols: number; rows: number; generation: number } | null = null
  /** Whether we held control when the last attach dropped, and when. */
  private droppedWhileController: number | null = null

  constructor(options: TerminalSessionOptions) {
    this.opts = {
      resizeDebounceMs: 300,
      claimTimeoutMs: 5000,
      controlGraceMs: 10_000,
      ...options,
    }
    this.timers = options.timers ?? defaultTimers
    this.random = options.random ?? Math.random
    this.localSize = options.localSize ?? null
    this.state = {
      status: "connecting",
      controller: null,
      generation: 0,
      you: false,
      cols: 0,
      rows: 0,
      renderCols: 0,
      renderRows: 0,
      seq: 0,
      exit: null,
      takeoverPrompt: false,
      claimPending: false,
      sizeLocked: false,
      readOnly: options.owner === "agent",
      lastRejected: null,
      attempt: 0,
      nextRetryAt: null,
      error: null,
    }
  }

  // ── Store (useSyncExternalStore-friendly) ──

  getState = (): TerminalSessionState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<TerminalSessionState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  // ── Lifecycle ──

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    const mode = this.opts.initialMode === "control" && !this.state.readOnly ? "control" : "view"
    this.connect(mode)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer("resizeTimer")
    this.clearTimer("claimTimer")
    this.clearTimer("retryTimer")
    this.closeLink()
    this.listeners.clear()
  }

  /** Reconnect right away (manual retry). */
  reconnectNow(): void {
    if (this.disposed || this.state.status === "exited") return
    this.clearTimer("retryTimer")
    this.closeLink()
    this.set({ attempt: 0, nextRetryAt: null, error: null })
    this.connect(this.reconnectMode())
  }

  /** Drop what we have and ask for a fresh snapshot (renderer fell behind, or a seq gap). */
  requestSnapshot(): void {
    this.forceSnapshot = true
    this.reconnectNow()
  }

  private connect(mode: "view" | "control"): void {
    if (this.disposed) return
    const epoch = ++this.linkEpoch
    this.linkGotFrame = false
    const request: TerminalAttachRequest = { id: this.opts.terminalId, mode }
    if (this.opts.label) request.label = this.opts.label.slice(0, 80)
    if (mode === "control" && this.localSize) {
      request.cols = this.localSize.cols
      request.rows = this.localSize.rows
    }
    this.linkResumed = this.state.seq > 0 && !this.forceSnapshot
    if (this.linkResumed) request.resume_seq = this.state.seq
    this.set({
      status: this.state.seq > 0 || this.state.attempt > 0 ? "reconnecting" : "connecting",
      nextRetryAt: null,
    })
    try {
      this.link = this.opts.transport.attach(request, {
        frame: (frame) => {
          if (epoch === this.linkEpoch) this.onFrame(frame)
        },
        closed: (info) => {
          if (epoch === this.linkEpoch) this.onClosed(info)
        },
      })
    } catch (error) {
      this.onClosed({ error })
    }
  }

  private closeLink(): void {
    this.linkEpoch++
    const link = this.link
    this.link = null
    link?.close()
  }

  private reconnectMode(): "view" | "control" {
    if (this.state.readOnly) return "view"
    const dropped = this.droppedWhileController
    if (dropped != null && this.timers.now() - dropped < this.opts.controlGraceMs) return "control"
    return "view"
  }

  private onClosed(info?: { error?: unknown; fatal?: boolean; snapshotNext?: boolean }): void {
    this.link = null
    this.linkEpoch++
    if (this.disposed || this.state.status === "exited") return
    if (this.state.you && this.droppedWhileController == null) this.droppedWhileController = this.timers.now()
    // Control does not survive the attach: pending typing and resize timers belong to the old stream.
    this.clearTimer("resizeTimer")
    this.clearTimer("claimTimer")
    this.pending = []
    this.pendingChars = 0
    const message = info?.error instanceof Error ? info.error.message : info?.error ? String(info.error) : null
    if (info?.fatal) {
      this.set({ status: "closed", error: message, you: false, claimPending: false, takeoverPrompt: false })
      return
    }
    // A resume that keeps ending before anything arrives may itself be the cause: after two, ask for a snapshot.
    if (this.linkResumed && !this.linkGotFrame) this.resumeFailures++
    if (this.resumeFailures >= 2 || info?.snapshotNext) this.forceSnapshot = true
    const attempt = this.state.attempt + 1
    const base = this.opts.backoff?.baseMs ?? 500
    const max = this.opts.backoff?.maxMs ?? 15_000
    const delay = Math.round(Math.min(max, base * 2 ** (attempt - 1)) * (0.8 + 0.4 * this.random()))
    this.set({
      status: "reconnecting",
      attempt,
      nextRetryAt: this.timers.now() + delay,
      error: message,
      you: false,
      claimPending: false,
      takeoverPrompt: false,
    })
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      this.connect(this.reconnectMode())
    }, delay)
  }

  // ── Frames ──

  private onFrame(frame: TerminalOutputFrame): void {
    this.linkGotFrame = true
    this.resumeFailures = 0
    switch (frame.type) {
      case "snapshot": {
        this.forceSnapshot = false
        this.opts.renderer.reset(base64ToBytes(frame.data), frame.cols, frame.rows)
        this.set({
          seq: frame.seq,
          cols: frame.cols,
          rows: frame.rows,
          renderCols: frame.cols,
          renderRows: frame.rows,
          status: "live",
          attempt: 0,
          error: null,
        })
        return
      }
      case "output": {
        if (frame.seq <= this.state.seq) return // already rendered (resume overlap)
        if (this.state.seq > 0 && frame.seq !== this.state.seq + 1) {
          // Missed chunks: the screen can no longer be trusted, start over from a snapshot.
          this.requestSnapshot()
          return
        }
        this.opts.renderer.write(base64ToBytes(frame.data))
        this.set({ seq: frame.seq, status: "live", attempt: 0, error: null })
        return
      }
      case "control":
        this.onControl(frame)
        return
      case "rejected": {
        const readOnly = this.state.readOnly || frame.reason === "agent_owned"
        if (readOnly) {
          this.pending = []
          this.pendingChars = 0
          this.clearTimer("claimTimer")
        }
        this.set({
          lastRejected: { reason: frame.reason, generation: frame.generation, at: this.timers.now() },
          readOnly,
          ...(readOnly ? { claimPending: false, takeoverPrompt: false } : {}),
        })
        return
      }
      case "exit": {
        this.clearTimer("resizeTimer")
        this.clearTimer("claimTimer")
        this.clearTimer("retryTimer")
        this.pending = []
        this.pendingChars = 0
        this.set({
          status: "exited",
          exit: { code: frame.exit_code, signal: frame.exit_signal ?? null },
          you: false,
          claimPending: false,
          takeoverPrompt: false,
        })
        this.closeLink()
        return
      }
    }
  }

  private onControl(frame: Extract<TerminalOutputFrame, { type: "control" }>): void {
    const wasYou = this.state.you
    const becameYou = frame.you && !wasYou
    const lostControl = !frame.you && wasYou
    // The attach is established and this frame is authoritative: a later drop starts a new grace window.
    this.droppedWhileController = null

    const patch: Partial<TerminalSessionState> = {
      controller: frame.controller,
      generation: frame.generation,
      you: frame.you,
      cols: frame.cols,
      rows: frame.rows,
      status: "live",
      attempt: 0,
      error: null,
    }
    if (frame.you) {
      patch.claimPending = false
      patch.takeoverPrompt = false
    } else if (frame.controller === null) {
      patch.takeoverPrompt = false
    }
    if (lostControl) {
      patch.sizeLocked = false
      this.clearTimer("resizeTimer")
    }
    this.set(patch)

    if (becameYou) {
      this.clearTimer("claimTimer")
      const queued = this.pending
      this.pending = []
      this.pendingChars = 0
      for (const item of queued) this.sendInput(item.data, item.binary)
    }
    if (lostControl || (!frame.you && !this.state.claimPending)) {
      this.pending = []
      this.pendingChars = 0
    }
    this.syncRenderSize()
    if (frame.you) this.scheduleResize(becameYou ? 0 : this.opts.resizeDebounceMs)
  }

  // ── User actions ──

  /**
   * Bytes from the keyboard (`intent: "type"`, may auto-claim) or produced by pointer / wheel handling
   * (`intent: "pointer"`, only ever sent by the controller). `binary` = xterm.js `onBinary` strings.
   */
  input(data: string, options: { intent?: InputIntent; binary?: boolean } = {}): InputResult {
    if (!data) return "dropped"
    const s = this.state
    if (s.status !== "live" || s.readOnly) return "dropped"
    const binary = options.binary ?? false
    if (s.you) {
      this.sendInput(data, binary)
      return "sent"
    }
    if ((options.intent ?? "type") === "pointer") return "dropped"
    if (s.controller === null) {
      if (this.pendingChars + data.length > MAX_PENDING_CHARS) return "dropped"
      this.pending.push({ data, binary })
      this.pendingChars += data.length
      if (!s.claimPending) this.claim({ keepSize: this.opts.keepSizeOnAutoClaim ?? false, auto: true })
      return "queued"
    }
    if (!s.takeoverPrompt) this.set({ takeoverPrompt: true })
    return "blocked"
  }

  /** A key was pressed while input is disabled (someone else controls): surface the take-over prompt. */
  noteBlockedTyping(): void {
    const s = this.state
    if (s.status === "live" && !s.readOnly && controlledElsewhere(s) && !s.takeoverPrompt) {
      this.set({ takeoverPrompt: true })
    }
  }

  dismissTakeoverPrompt(): void {
    if (this.state.takeoverPrompt) this.set({ takeoverPrompt: false })
  }

  /** Take control now. `keepSize` keeps the PTY's current size instead of applying this window. */
  claim(options: { keepSize?: boolean; auto?: boolean } = {}): boolean {
    const s = this.state
    if (this.disposed || s.status !== "live" || s.readOnly || !this.link) return false
    if (!options.auto) {
      // An explicit take-over does not replay keys typed before it.
      this.pending = []
      this.pendingChars = 0
    }
    const frame: TerminalInputFrame = options.keepSize
      ? { type: "claim", keep_size: true }
      : this.localSize
        ? { type: "claim", cols: this.localSize.cols, rows: this.localSize.rows }
        : { type: "claim" }
    this.link.send(frame)
    this.set({ claimPending: true, takeoverPrompt: false, sizeLocked: Boolean(options.keepSize) })
    this.clearTimer("claimTimer")
    this.claimTimer = this.timers.setTimeout(() => {
      this.claimTimer = null
      this.pending = []
      this.pendingChars = 0
      if (this.state.claimPending) this.set({ claimPending: false })
    }, this.opts.claimTimeoutMs)
    return true
  }

  release(): boolean {
    if (!this.state.you || !this.link) return false
    this.clearTimer("resizeTimer")
    this.link.send({ type: "release" })
    this.set({ sizeLocked: false })
    return true
  }

  /**
   * The local window now fits cols x rows. `explicit` (pinch, "fit to window") lifts a keep_size lock.
   * Only the controller turns this into a debounced `resize`; viewers keep rendering at the controller's size.
   */
  localResize(cols: number, rows: number, options: { explicit?: boolean } = {}): void {
    if (!(cols >= 1 && rows >= 1)) return
    cols = Math.min(1000, Math.floor(cols))
    rows = Math.min(1000, Math.floor(rows))
    this.localSize = { cols, rows }
    if (options.explicit && this.state.sizeLocked) this.set({ sizeLocked: false })
    this.syncRenderSize()
    if (this.state.you) this.scheduleResize(this.opts.resizeDebounceMs)
  }

  // ── Internals ──

  private sendInput(data: string, binary: boolean): void {
    if (!this.link) return
    this.link.send({
      type: "input",
      data: binary ? binaryStringToBase64(data) : textToBase64(data),
      generation: this.state.generation,
    })
  }

  private targetRenderSize(): { cols: number; rows: number } | null {
    const s = this.state
    if (s.you && !s.sizeLocked && this.localSize) return this.localSize
    if (s.cols > 0 && s.rows > 0) return { cols: s.cols, rows: s.rows }
    return null
  }

  private syncRenderSize(): void {
    const target = this.targetRenderSize()
    if (!target) return
    if (target.cols === this.state.renderCols && target.rows === this.state.renderRows) return
    this.opts.renderer.resize(target.cols, target.rows)
    this.set({ renderCols: target.cols, renderRows: target.rows })
  }

  private scheduleResize(delayMs: number): void {
    this.clearTimer("resizeTimer")
    const s = this.state
    if (!s.you || s.sizeLocked || !this.localSize) return
    this.resizeTimer = this.timers.setTimeout(() => {
      this.resizeTimer = null
      this.flushResize()
    }, delayMs)
  }

  private flushResize(): void {
    const s = this.state
    const size = this.localSize
    if (!s.you || s.sizeLocked || !size || !this.link || s.status !== "live") return
    if (size.cols === s.cols && size.rows === s.rows) return
    const last = this.lastSentSize
    if (last && last.cols === size.cols && last.rows === size.rows && last.generation === s.generation) return
    this.lastSentSize = { ...size, generation: s.generation }
    this.link.send({ type: "resize", cols: size.cols, rows: size.rows, generation: s.generation })
  }

  private clearTimer(name: "resizeTimer" | "claimTimer" | "retryTimer"): void {
    const handle = this[name]
    if (handle != null) this.timers.clearTimeout(handle)
    this[name] = null
  }
}
