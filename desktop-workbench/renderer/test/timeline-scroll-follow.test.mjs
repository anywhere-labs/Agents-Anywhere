import assert from "node:assert/strict"
import test from "node:test"
import { createTimelineScrollFollow } from "../src/components/session/timeline-scroll-follow.ts"

function fixture() {
  let resize
  let disconnected = false
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback }
    observe() {}
    disconnect() { disconnected = true }
  }
  const frames = new Map()
  let nextFrame = 0
  const calls = []
  let pauses = 0
  const root = new EventTarget()
  const document = new EventTarget()
  document.defaultView = {
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame(id) { frames.delete(id) },
  }
  const viewport = Object.assign(new EventTarget(), {
    ownerDocument: document, parentElement: root,
    scrollHeight: 2000, clientHeight: 600, scrollTop: 1400,
    closest: () => null,
    scrollTo(options) {
      calls.push(options)
      if (options.behavior !== "smooth") this.scrollTop = Math.min(options.top, this.scrollHeight - this.clientHeight)
    },
  })
  const follow = createTimelineScrollFollow(viewport, {}, () => {}, () => { pauses++ })
  const emit = (name, properties = {}, target = viewport) => {
    const event = new Event(name)
    Object.assign(event, properties)
    target.dispatchEvent(event)
  }
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback())
  }
  return { follow, viewport, root, document, frames, calls, emit, flush,
    resize: () => resize(), disconnected: () => disconnected, pauses: () => pauses }
}

test("rapid growth of the same message follows its latest height once per frame", () => {
  const f = fixture()
  for (let index = 0; index < 100; index++) {
    f.viewport.scrollHeight += 10
    f.resize()
  }
  assert.equal(f.frames.size, 1)
  f.flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.viewport.scrollTop, 2400)
  assert.equal(f.calls[0].behavior, "instant")
  f.follow.dispose()
})

test("a tiny upward wheel gesture cancels queued following before the viewport moves", () => {
  const f = fixture()
  f.resize()
  const staleFrame = [...f.frames.values()][0]
  f.emit("wheel", { deltaY: -1 })
  assert.equal(f.follow.isFollowing(), false)
  assert.equal(f.frames.size, 0)
  assert.equal(f.pauses(), 1)
  f.viewport.scrollTop -= 1
  f.emit("scroll")
  for (let index = 0; index < 20; index++) {
    f.viewport.scrollHeight += 40
    f.resize()
  }
  staleFrame()
  f.follow.scrollNow() // A late initial-layout callback must also respect the pause.
  f.flush()
  assert.equal(f.viewport.scrollTop, 1399)
  assert.equal(f.calls.length, 1, "Only the cancellation of the current animation may write scrollTop")
  f.follow.dispose()
})

test("manual downward scrolling resumes only on reaching the bottom", () => {
  const f = fixture()
  f.emit("wheel", { deltaY: -30 })
  f.viewport.scrollTop = 1200
  f.emit("scroll")
  f.emit("wheel", { deltaY: 50 })
  f.viewport.scrollTop = 1250
  f.emit("scroll")
  assert.equal(f.follow.isFollowing(), false)
  f.viewport.scrollTop = 1398
  f.emit("scroll")
  assert.equal(f.follow.isFollowing(), true)
  f.viewport.scrollHeight += 200
  f.resize()
  f.flush()
  assert.equal(f.viewport.scrollTop, 1600)
  f.follow.dispose()
})

test("explicit resume works, and upward input interrupts its smooth animation", () => {
  const f = fixture()
  f.follow.pause()
  f.viewport.scrollTop = 600
  f.follow.resume("smooth")
  assert.equal(f.follow.isFollowing(), true)
  assert.equal(f.calls.at(-1).behavior, "smooth")
  f.viewport.scrollTop = 800 // Partway through the browser's animation.
  f.emit("wheel", { deltaY: -1 })
  assert.deepEqual(f.calls.at(-1), { top: 800, behavior: "instant" })
  f.resize()
  f.flush()
  assert.equal(f.viewport.scrollTop, 800)
  f.follow.resume() // Sending a new message also explicitly resumes following.
  assert.equal(f.viewport.scrollTop, 1400)
  f.follow.dispose()
})

test("keyboard and touch navigation pause immediately without hijacking text editing", () => {
  const f = fixture()
  f.viewport.closest = () => ({ tagName: "TEXTAREA" })
  f.emit("keydown", { key: "ArrowUp" })
  assert.equal(f.follow.isFollowing(), true)
  f.viewport.closest = () => null
  for (const key of ["ArrowUp", "PageUp", "Home", " "]) {
    f.follow.resume()
    f.emit("keydown", { key, shiftKey: key === " " })
    assert.equal(f.follow.isFollowing(), false)
  }
  f.follow.resume()
  f.emit("touchstart", { touches: [{ clientY: 100 }] })
  f.emit("touchmove", { touches: [{ clientY: 102 }] })
  assert.equal(f.follow.isFollowing(), false)
  f.follow.dispose()
})

test("dragging the sibling scrollbar pauses and only releasing at the bottom resumes", () => {
  const f = fixture()
  f.root.closest = () => ({})
  f.emit("pointerdown", {}, f.root)
  assert.equal(f.follow.isFollowing(), false)
  f.viewport.scrollTop = 800
  f.emit("scroll")
  f.emit("pointerup", {}, f.document)
  assert.equal(f.follow.isFollowing(), false)
  f.emit("pointerdown", {}, f.root)
  f.viewport.scrollTop = 1400
  f.emit("scroll")
  assert.equal(f.follow.isFollowing(), false)
  f.emit("pointerup", {}, f.document)
  assert.equal(f.follow.isFollowing(), true)
  f.follow.dispose()
})

test("reading older history preserves the restored position as content and viewport resize", () => {
  const f = fixture()
  f.emit("wheel", { deltaY: -600 })
  f.viewport.scrollTop = 20
  f.emit("scroll")
  // Prepending older history restores the visible anchor by the added height.
  f.viewport.scrollHeight += 2000
  f.viewport.scrollTop += 2000
  f.emit("scroll")
  f.viewport.clientHeight = 500
  f.resize()
  f.flush()
  assert.equal(f.follow.isFollowing(), false)
  assert.equal(f.viewport.scrollTop, 2020)
  f.follow.dispose()
})

test("leaving a session cancels all pending work and detaches input listeners", () => {
  const f = fixture()
  f.resize()
  const staleFrame = [...f.frames.values()][0]
  f.follow.dispose()
  assert.equal(f.disconnected(), true)
  assert.equal(f.frames.size, 0)
  staleFrame()
  f.resize()
  f.emit("wheel", { deltaY: -1 })
  f.follow.resume()
  f.flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.pauses(), 0)
})
