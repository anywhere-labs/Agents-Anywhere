import { describe, expect, it } from "vitest"

import { applyCtrl, EXTRA_KEY_ROW, keySequence } from "@/lib/terminal/keys"
import { clientLabel } from "@/lib/terminal/label"
import {
  fitFontSize,
  inertiaStep,
  INERTIA_MIN_VELOCITY,
  LONG_PRESS_MS,
  pinchFontSize,
  pointToCell,
  selectionSpan,
  TouchGestures,
  VelocityTracker,
  wordRange,
  type FrameScheduler,
  type Point,
  type TouchCallbacks,
} from "@/lib/terminal/touch"

describe("extra keys → sequences", () => {
  it("maps the row to xterm sequences", () => {
    expect(keySequence("escape")).toBe("\x1b")
    expect(keySequence("tab")).toBe("\t")
    expect(keySequence("tab", { shift: true })).toBe("\x1b[Z")
    expect(keySequence("up")).toBe("\x1b[A")
    expect(keySequence("down")).toBe("\x1b[B")
    expect(keySequence("right")).toBe("\x1b[C")
    expect(keySequence("left")).toBe("\x1b[D")
    expect(keySequence("home")).toBe("\x1b[H")
    expect(keySequence("end")).toBe("\x1b[F")
    expect(keySequence("pageUp")).toBe("\x1b[5~")
    expect(keySequence("pageDown")).toBe("\x1b[6~")
  })

  it("uses SS3 cursor keys in application cursor mode (vim, less)", () => {
    expect(keySequence("up", {}, { applicationCursorKeys: true })).toBe("\x1bOA")
    expect(keySequence("home", {}, { applicationCursorKeys: true })).toBe("\x1bOH")
    expect(keySequence("pageUp", {}, { applicationCursorKeys: true })).toBe("\x1b[5~")
  })

  it("encodes modifiers with the xterm parameter", () => {
    expect(keySequence("left", { ctrl: true })).toBe("\x1b[1;5D")
    expect(keySequence("right", { ctrl: true }, { applicationCursorKeys: true })).toBe("\x1b[1;5C")
    expect(keySequence("up", { shift: true })).toBe("\x1b[1;2A")
    expect(keySequence("pageDown", { ctrl: true })).toBe("\x1b[6;5~")
    expect(keySequence("escape", { alt: true })).toBe("\x1b\x1b")
  })

  it("applies a latched Ctrl to the next typed character", () => {
    expect(applyCtrl("c")).toBe("\x03")
    expect(applyCtrl("C")).toBe("\x03")
    expect(applyCtrl("a")).toBe("\x01")
    expect(applyCtrl("[")).toBe("\x1b")
    expect(applyCtrl(" ")).toBe("\x00")
    expect(applyCtrl("?")).toBe("\x7f")
    expect(applyCtrl("\\")).toBe("\x1c")
    expect(applyCtrl("ls")).toBe("ls")
    expect(applyCtrl("中")).toBe("中")
  })

  it("lists the documented keys", () => {
    expect(EXTRA_KEY_ROW).toEqual([
      "escape",
      "ctrl",
      "tab",
      "left",
      "up",
      "down",
      "right",
      "home",
      "end",
      "pageUp",
      "pageDown",
    ])
  })
})

describe("touch math", () => {
  it("tracks release velocity over the last 100 ms", () => {
    const tracker = new VelocityTracker()
    tracker.add(0, 500)
    tracker.add(100, 400)
    tracker.add(200, 300)
    tracker.add(216, 280)
    // Only samples within 100 ms of `now` count (t = 200 and 216).
    expect(tracker.velocity(216)).toBeCloseTo((280 - 300) / 16, 5)
    expect(tracker.velocity(1000)).toBe(0)
  })

  it("decays inertia per frame and stops below the threshold", () => {
    const step = inertiaStep(1, 16)
    expect(step.delta).toBe(16)
    expect(step.velocity).toBeCloseTo(0.95, 5)
    let v = 1
    let frames = 0
    let total = 0
    for (;;) {
      const s = inertiaStep(v, 16)
      total += s.delta
      v = s.velocity
      frames++
      if (s.done) break
    }
    expect(Math.abs(v)).toBeLessThan(INERTIA_MIN_VELOCITY)
    expect(frames).toBeGreaterThan(50)
    expect(total).toBeLessThan(16 / (1 - 0.95) + 1)
    // Same decay regardless of frame rate.
    expect(inertiaStep(1, 32).velocity).toBeCloseTo(0.95 ** 2, 5)
  })

  it("scales font with pinch, clamped", () => {
    expect(pinchFontSize(12, 100, 150)).toBe(18)
    expect(pinchFontSize(12, 100, 10)).toBe(8)
    expect(pinchFontSize(12, 100, 1000)).toBe(28)
    expect(pinchFontSize(12, 0, 100)).toBe(12)
  })

  it("maps points to cells", () => {
    const g = { left: 10, top: 20, width: 800, height: 480, cols: 80, rows: 24 }
    expect(pointToCell({ x: 10, y: 20 }, g)).toEqual({ col: 0, row: 0 })
    expect(pointToCell({ x: 25, y: 41 }, g)).toEqual({ col: 1, row: 1 })
    expect(pointToCell({ x: 5000, y: 5000 }, g)).toEqual({ col: 79, row: 23 })
    expect(pointToCell({ x: -5, y: -5 }, g)).toEqual({ col: 0, row: 0 })
  })

  it("finds the word under a cell", () => {
    const line = "$ git status ~/code/aa-v3"
    expect(wordRange(line, 3)).toEqual({ start: 2, end: 5 })
    expect(wordRange(line, 15)).toEqual({ start: 13, end: 25 })
    expect(wordRange(line, 1)).toEqual({ start: 1, end: 2 })
    expect(wordRange(line, 40)).toEqual({ start: 40, end: 41 })
    // Per-cell arrays keep wide characters at their cell columns.
    expect(wordRange(["a", "中", "中", "b", " "], 2)).toEqual({ start: 0, end: 4 })
  })

  it("spans a selection between anchor word and focus across rows", () => {
    const anchor = { row: 10, start: 4, end: 8 }
    expect(selectionSpan(anchor, { row: 10, col: 6 }, 80)).toEqual({ col: 4, row: 10, length: 4 })
    expect(selectionSpan(anchor, { row: 11, col: 1 }, 80)).toEqual({ col: 4, row: 10, length: 78 })
    expect(selectionSpan(anchor, { row: 9, col: 78 }, 80)).toEqual({ col: 78, row: 9, length: 10 })
  })

  it("fits the controller's columns by shrinking the font, within bounds", () => {
    // 0.6 px of cell width per px of font: 132 cols at 13 px = 1029.6 px.
    expect(fitFontSize(2000, 132, 0.6, 13)).toBe(13)
    expect(fitFontSize(400, 80, 0.6, 13)).toBe(8)
    expect(fitFontSize(200, 132, 0.6, 13, 7)).toBe(7)
    expect(fitFontSize(0, 80, 0.6, 13)).toBe(13)
  })
})

class FakeScheduler implements FrameScheduler {
  t = 0
  frames = new Map<number, (t: number) => void>()
  timers = new Map<number, { at: number; fn: () => void }>()
  private id = 0

  request = (fn: (t: number) => void) => {
    const id = ++this.id
    this.frames.set(id, fn)
    return id
  }
  cancel = (h: unknown) => {
    this.frames.delete(h as number)
  }
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.id
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number)
  }
  advance(ms: number) {
    this.t += ms
    for (const [id, task] of [...this.timers]) {
      if (task.at <= this.t) {
        this.timers.delete(id)
        task.fn()
      }
    }
  }
  frame(dt = 16) {
    this.t += dt
    const frames = [...this.frames]
    this.frames.clear()
    for (const [, fn] of frames) fn(this.t)
  }
}

function gestures() {
  const calls: string[] = []
  const scrolls: number[] = []
  const pinches: number[] = []
  const cb: TouchCallbacks = {
    scroll: (d) => {
      scrolls.push(d)
    },
    tap: (p) => calls.push(`tap:${p.x},${p.y}`),
    selectStart: (p) => calls.push(`selectStart:${p.x},${p.y}`),
    selectMove: (p) => calls.push(`selectMove:${p.x},${p.y}`),
    selectEnd: () => calls.push("selectEnd"),
    pinch: (s) => {
      pinches.push(s)
    },
    pinchEnd: (s) => calls.push(`pinchEnd:${s.toFixed(2)}`),
  }
  const scheduler = new FakeScheduler()
  return { g: new TouchGestures(cb, scheduler), calls, scrolls, pinches, scheduler }
}

const pt = (x: number, y: number): Point => ({ x, y })

describe("touch gestures", () => {
  it("tap", () => {
    const { g, calls } = gestures()
    g.touchStart([pt(10, 10)], 0)
    g.touchMove([pt(12, 11)], 50)
    expect(g.touchEnd([], 100)).toBe(true)
    expect(calls).toEqual(["tap:10,10"])
  })

  it("vertical drag scrolls with the finger (up = positive delta) and keeps going with inertia", () => {
    const { g, scrolls, scheduler, calls } = gestures()
    g.touchStart([pt(100, 300)], 0)
    expect(g.touchMove([pt(100, 280)], 16)).toBe(true)
    g.touchMove([pt(100, 240)], 32)
    g.touchMove([pt(100, 200)], 48)
    expect(scrolls).toEqual([20, 40, 40])
    g.touchEnd([], 48)
    expect(calls).toEqual([])
    scheduler.t = 48
    scheduler.frame()
    scheduler.frame()
    expect(scrolls.length).toBe(5)
    expect(scrolls[3]).toBeGreaterThan(0)
    expect(scrolls[4]).toBeLessThan(scrolls[3])
    // A new touch stops inertia.
    g.touchStart([pt(0, 0)], 100)
    expect(scheduler.frames.size).toBe(0)
  })

  it("a horizontal drag is left to the browser", () => {
    const { g, scrolls } = gestures()
    g.touchStart([pt(100, 100)], 0)
    expect(g.touchMove([pt(140, 105)], 16)).toBe(false)
    expect(g.current).toBe("pan-x")
    expect(g.touchEnd([], 32)).toBe(false)
    expect(scrolls).toEqual([])
  })

  it("long-press selects, drag extends, release ends", () => {
    const { g, calls, scheduler } = gestures()
    g.touchStart([pt(50, 60)], 0)
    scheduler.advance(LONG_PRESS_MS)
    expect(calls).toEqual(["selectStart:50,60"])
    g.touchMove([pt(90, 60)], 600)
    g.touchEnd([], 700)
    expect(calls).toEqual(["selectStart:50,60", "selectMove:90,60", "selectEnd"])
  })

  it("moving before the long-press fires cancels it", () => {
    const { g, calls, scheduler } = gestures()
    g.touchStart([pt(50, 60)], 0)
    g.touchMove([pt(50, 100)], 100)
    scheduler.advance(LONG_PRESS_MS)
    expect(calls).toEqual([])
  })

  it("pinch reports scale and ends once a finger lifts", () => {
    const { g, calls, pinches } = gestures()
    g.touchStart([pt(100, 100)], 0)
    g.touchStart([pt(100, 100), pt(200, 100)], 10)
    g.touchMove([pt(100, 100), pt(250, 100)], 30)
    expect(pinches).toEqual([1.5])
    g.touchEnd([pt(100, 100)], 40)
    expect(calls).toEqual(["pinchEnd:1.50"])
    // The remaining finger does not turn into a tap or a scroll.
    g.touchMove([pt(100, 160)], 50)
    g.touchEnd([], 60)
    expect(calls).toEqual(["pinchEnd:1.50"])
  })
})

describe("client label", () => {
  it("names browser and OS", () => {
    expect(
      clientLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
      )
    ).toBe("Chrome · macOS")
    expect(
      clientLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
      )
    ).toBe("Safari · iPhone")
  })
})
