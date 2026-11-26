// Touch handling for the terminal on coarse pointers (docs/v3/terminal-proposal.md §5).
//
// - one-finger vertical drag → `scroll(deltaY)` (the view turns it into a synthetic WheelEvent on the xterm element,
//   so xterm.js decides between local scrollback, arrow keys and mouse reports), then inertia after release;
// - tap → `tap(x, y)` (the view focuses only when the user may type);
// - long-press → `selectStart` / `selectMove` / `selectEnd` (the view selects cells and shows a copy toolbar);
// - pinch → `pinch(scale)` / `pinchEnd()` (font size; the controller then resizes, debounced).
//
// The gesture state machine is DOM-free (points + timestamps in, callbacks out) so it is unit-tested; `bindTouch`
// attaches it to exactly one element and never to anything outside the terminal.

export interface Point {
  x: number
  y: number
}

// ── Math ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const TAP_SLOP_PX = 8
export const LONG_PRESS_MS = 450
/** Velocity decay per 16 ms frame. */
export const INERTIA_FRICTION = 0.95
/** px/ms below which inertia stops. */
export const INERTIA_MIN_VELOCITY = 0.02
/** px/ms above which a release starts inertia. */
export const INERTIA_START_VELOCITY = 0.1
const VELOCITY_WINDOW_MS = 100

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Tracks recent positions along one axis and reports the release velocity in px/ms. */
export class VelocityTracker {
  private samples: { t: number; v: number }[] = []

  reset(): void {
    this.samples = []
  }

  add(t: number, value: number): void {
    this.samples.push({ t, v: value })
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW_MS) this.samples.shift()
  }

  velocity(now: number): number {
    const recent = this.samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS)
    if (recent.length < 2) return 0
    const first = recent[0]
    const last = recent[recent.length - 1]
    const dt = last.t - first.t
    return dt > 0 ? (last.v - first.v) / dt : 0
  }
}

/** One inertia frame: how far to scroll for `dtMs` and the decayed velocity. */
export function inertiaStep(
  velocity: number,
  dtMs: number,
  friction = INERTIA_FRICTION
): { delta: number; velocity: number; done: boolean } {
  const delta = velocity * dtMs
  const next = velocity * friction ** (dtMs / 16)
  return { delta, velocity: next, done: Math.abs(next) < INERTIA_MIN_VELOCITY }
}

export function pinchFontSize(
  startFont: number,
  startDistance: number,
  currentDistance: number,
  min = 8,
  max = 28
): number {
  if (!(startDistance > 0)) return startFont
  const size = Math.round(startFont * (currentDistance / startDistance))
  return Math.min(max, Math.max(min, size))
}

export interface ScreenGeometry {
  left: number
  top: number
  width: number
  height: number
  cols: number
  rows: number
}

/** Client point → viewport cell (0-based, clamped). */
export function pointToCell(p: Point, g: ScreenGeometry): { col: number; row: number } {
  const cellW = g.width / Math.max(1, g.cols)
  const cellH = g.height / Math.max(1, g.rows)
  const col = Math.floor((p.x - g.left) / cellW)
  const row = Math.floor((p.y - g.top) / cellH)
  return {
    col: Math.min(g.cols - 1, Math.max(0, col)),
    row: Math.min(g.rows - 1, Math.max(0, row)),
  }
}

const WORD_CHAR = /[\p{L}\p{N}_\-./~:@%+=]/u

/**
 * Word around `col` in a rendered line: [start, end) in cells. Pass a string, or one entry per cell (a wide
 * character's trailing cell repeats it) for exact cell columns. A non-word cell selects just itself.
 */
export function wordRange(line: string | readonly string[], col: number): { start: number; end: number } {
  const chars = typeof line === "string" ? [...line] : line
  if (col >= chars.length || !WORD_CHAR.test(chars[col] ?? "")) return { start: col, end: col + 1 }
  let start = col
  let end = col + 1
  while (start > 0 && WORD_CHAR.test(chars[start - 1])) start--
  while (end < chars.length && WORD_CHAR.test(chars[end])) end++
  return { start, end }
}

/**
 * Linear selection between an anchor range and a focus cell, in buffer coordinates, as xterm.js `select(col, row,
 * length)` wants it (length wraps across rows of `cols`).
 */
export function selectionSpan(
  anchor: { row: number; start: number; end: number },
  focus: { row: number; col: number },
  cols: number
): { col: number; row: number; length: number } {
  const aStart = anchor.row * cols + anchor.start
  const aEnd = anchor.row * cols + anchor.end
  const f = focus.row * cols + focus.col
  const start = Math.min(aStart, f)
  const end = Math.max(aEnd, f + 1)
  return { col: start % cols, row: Math.floor(start / cols), length: end - start }
}

/**
 * Font size at which `cols` cells fit `containerWidth` (viewers render at the controller's size). `cellWidthPerPx`
 * is the measured cell width divided by the font size. Never above `baseFont`, never below `minFont`.
 */
export function fitFontSize(
  containerWidth: number,
  cols: number,
  cellWidthPerPx: number,
  baseFont: number,
  minFont = 7
): number {
  if (!(containerWidth > 0 && cols > 0 && cellWidthPerPx > 0)) return baseFont
  const fit = Math.floor((containerWidth / (cols * cellWidthPerPx)) * 2) / 2
  return Math.max(minFont, Math.min(baseFont, fit))
}

// ── Gesture state machine ───────────────────────────────────────────────────────────────────────────────────────

export interface TouchCallbacks {
  scroll(deltaY: number, at: Point): void
  tap(at: Point): void
  selectStart(at: Point): void
  selectMove(at: Point): void
  selectEnd(at: Point): void
  pinch(scale: number): void
  pinchEnd(scale: number): void
}

export interface FrameScheduler {
  request(fn: (t: number) => void): unknown
  cancel(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

type Mode = "idle" | "pending" | "scroll" | "pan-x" | "select" | "pinch" | "done"

export class TouchGestures {
  private mode: Mode = "idle"
  private start: Point = { x: 0, y: 0 }
  private last: Point = { x: 0, y: 0 }
  private startDistance = 0
  private lastScale = 1
  private readonly tracker = new VelocityTracker()
  private longPressTimer: unknown = null
  private inertiaFrame: unknown = null

  constructor(
    private readonly cb: TouchCallbacks,
    private readonly scheduler: FrameScheduler
  ) {}

  get current(): Mode {
    return this.mode
  }

  /** Returns true when the event should be preventDefault()-ed. */
  touchStart(points: Point[], t: number): boolean {
    this.stopInertia()
    if (points.length >= 2) {
      this.cancelLongPress()
      if (this.mode === "select") this.cb.selectEnd(this.last)
      this.mode = "pinch"
      this.startDistance = distance(points[0], points[1])
      this.lastScale = 1
      return true
    }
    if (this.mode !== "idle" && this.mode !== "done") return false
    if (points.length !== 1) return false
    this.mode = "pending"
    this.start = points[0]
    this.last = points[0]
    this.tracker.reset()
    this.tracker.add(t, points[0].y)
    this.longPressTimer = this.scheduler.setTimeout(() => {
      this.longPressTimer = null
      if (this.mode !== "pending") return
      this.mode = "select"
      this.cb.selectStart(this.last)
    }, LONG_PRESS_MS)
    return false
  }

  touchMove(points: Point[], t: number): boolean {
    switch (this.mode) {
      case "pinch": {
        if (points.length < 2) return true
        this.lastScale = this.startDistance > 0 ? distance(points[0], points[1]) / this.startDistance : 1
        this.cb.pinch(this.lastScale)
        return true
      }
      case "pending": {
        const p = points[0]
        if (!p) return false
        const dx = p.x - this.start.x
        const dy = p.y - this.start.y
        if (Math.hypot(dx, dy) < TAP_SLOP_PX) return true
        this.cancelLongPress()
        if (Math.abs(dx) > Math.abs(dy)) {
          // Horizontal: leave it to the browser (a viewer wider than the screen scrolls sideways).
          this.mode = "pan-x"
          return false
        }
        this.mode = "scroll"
        return this.scrollTo(p, t)
      }
      case "scroll": {
        const p = points[0]
        return p ? this.scrollTo(p, t) : true
      }
      case "select": {
        const p = points[0]
        if (p) {
          this.last = p
          this.cb.selectMove(p)
        }
        return true
      }
      default:
        return false
    }
  }

  touchEnd(remaining: Point[], t: number): boolean {
    this.cancelLongPress()
    switch (this.mode) {
      case "pinch":
        if (remaining.length < 2) {
          this.cb.pinchEnd(this.lastScale)
          this.mode = remaining.length === 0 ? "idle" : "done"
        }
        return true
      case "pending":
        this.mode = "idle"
        this.cb.tap(this.last)
        return true
      case "scroll": {
        this.mode = remaining.length === 0 ? "idle" : "done"
        // Finger moving up = content moving up = positive wheel delta.
        const velocity = -this.tracker.velocity(t)
        if (Math.abs(velocity) >= INERTIA_START_VELOCITY) this.startInertia(velocity, t)
        return true
      }
      case "select":
        this.mode = remaining.length === 0 ? "idle" : "done"
        this.cb.selectEnd(this.last)
        return true
      default:
        if (remaining.length === 0) this.mode = "idle"
        return false
    }
  }

  touchCancel(): void {
    this.cancelLongPress()
    if (this.mode === "select") this.cb.selectEnd(this.last)
    if (this.mode === "pinch") this.cb.pinchEnd(this.lastScale)
    this.mode = "idle"
  }

  dispose(): void {
    this.cancelLongPress()
    this.stopInertia()
    this.mode = "idle"
  }

  private scrollTo(p: Point, t: number): boolean {
    const delta = this.last.y - p.y
    this.last = p
    this.tracker.add(t, p.y)
    if (delta !== 0) this.cb.scroll(delta, p)
    return true
  }

  private startInertia(velocity: number, t0: number): void {
    let v = velocity
    let lastT = t0
    const at = this.last
    const frame = (t: number) => {
      // Touch and animation-frame timestamps share a clock; fall back to one frame if they do not.
      const dt = t > lastT ? Math.min(64, t - lastT) : 16
      lastT = t
      const step = inertiaStep(v, dt)
      v = step.velocity
      if (step.delta !== 0) this.cb.scroll(step.delta, at)
      this.inertiaFrame = step.done ? null : this.scheduler.request(frame)
    }
    this.inertiaFrame = this.scheduler.request(frame)
  }

  private stopInertia(): void {
    if (this.inertiaFrame != null) this.scheduler.cancel(this.inertiaFrame)
    this.inertiaFrame = null
  }

  private cancelLongPress(): void {
    if (this.longPressTimer != null) this.scheduler.clearTimeout(this.longPressTimer)
    this.longPressTimer = null
  }
}

// ── DOM binding ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A wheel event xterm.js treats like a real one. Its scrollback viewport (VS Code's scrollable element) reads the
 * legacy `wheelDeltaY` first where the browser has it (Chromium, WebKit), and a constructed WheelEvent carries 0
 * there, so set it to match: wheelDeltaY / 120 × 50 px per notch = exactly `deltaY` px of scroll.
 */
export function createWheelEvent(deltaY: number, at: Point): WheelEvent {
  const ev = new WheelEvent("wheel", {
    deltaY,
    deltaMode: 0,
    clientX: at.x,
    clientY: at.y,
    bubbles: true,
    cancelable: true,
    view: window,
  })
  if ("wheelDeltaY" in ev) {
    Object.defineProperty(ev, "wheelDeltaY", { value: Math.round(-deltaY * 2.4) })
    Object.defineProperty(ev, "wheelDeltaX", { value: 0 })
    Object.defineProperty(ev, "wheelDelta", { value: Math.round(-deltaY * 2.4) })
  }
  return ev
}

function points(list: TouchList): Point[] {
  const out: Point[] = []
  for (let i = 0; i < list.length; i++) out.push({ x: list[i].clientX, y: list[i].clientY })
  return out
}

/** Attach gestures to `element` only (never window / document). Returns a disposer. */
export function bindTouch(element: HTMLElement, cb: TouchCallbacks): () => void {
  const gestures = new TouchGestures(cb, {
    request: (fn) => requestAnimationFrame(fn),
    cancel: (h) => cancelAnimationFrame(h as number),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  })
  const onStart = (ev: TouchEvent) => {
    if (gestures.touchStart(points(ev.touches), ev.timeStamp) && ev.cancelable) ev.preventDefault()
  }
  const onMove = (ev: TouchEvent) => {
    if (gestures.touchMove(points(ev.touches), ev.timeStamp) && ev.cancelable) ev.preventDefault()
  }
  const onEnd = (ev: TouchEvent) => {
    if (gestures.touchEnd(points(ev.touches), ev.timeStamp) && ev.cancelable) ev.preventDefault()
  }
  const onCancel = () => gestures.touchCancel()
  element.addEventListener("touchstart", onStart, { passive: false })
  element.addEventListener("touchmove", onMove, { passive: false })
  element.addEventListener("touchend", onEnd, { passive: false })
  element.addEventListener("touchcancel", onCancel)
  return () => {
    gestures.dispose()
    element.removeEventListener("touchstart", onStart)
    element.removeEventListener("touchmove", onMove)
    element.removeEventListener("touchend", onEnd)
    element.removeEventListener("touchcancel", onCancel)
  }
}
