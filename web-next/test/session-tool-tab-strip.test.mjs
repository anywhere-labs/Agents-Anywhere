import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const hooks = registerSource()
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { SessionToolTabStrip } = await import("../src/components/session-tool-tab-strip.tsx")

test("tab strip converts vertical wheels, preserves native gestures, and clamps at the ends", async t => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(h(SessionToolTabStrip, { label: "Files", onKeyDown() {} }, h("button", { role: "tab" }, "file.ts"))))
  const viewport = host.querySelector('[data-slot="scroll-area-viewport"]')
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 200 })
  Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 600 })
  const wheel = async options => {
    const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...options })
    await act(async () => viewport.dispatchEvent(event))
    return event
  }
  assert.equal((await wheel({ deltaY: 80 })).defaultPrevented, true)
  assert.equal(viewport.scrollLeft, 80)
  assert.equal((await wheel({ deltaX: 50, deltaY: 1 })).defaultPrevented, false)
  assert.equal((await wheel({ deltaY: 80, ctrlKey: true })).defaultPrevented, false)
  assert.equal(viewport.scrollLeft, 80)
  await wheel({ deltaY: 2, deltaMode: 1 })
  assert.equal(viewport.scrollLeft, 112)
  await wheel({ deltaY: 2, deltaMode: 2 })
  assert.equal(viewport.scrollLeft, 400)
  assert.equal((await wheel({ deltaY: 80 })).defaultPrevented, false)
  await wheel({ deltaY: -1000 })
  assert.equal(viewport.scrollLeft, 0)
  Object.defineProperty(viewport, "scrollWidth", { value: 200 })
  assert.equal((await wheel({ deltaY: 80 })).defaultPrevented, false)
})

test.after(() => { hooks.deregister(); dom.window.close() })
