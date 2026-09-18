import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act, useState } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { SessionComposer } = await import("../src/components/session/session-composer.tsx")
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url)))

async function render(t, { steer = true, takeover = true, sending = false, value = "follow up" } = {}) {
  const calls = []
  const capabilities = [
    { capabilityId: "session.send_message", supported: true, available: false, allowed: true },
    { capabilityId: "session.steer", supported: steer, available: steer, allowed: true },
    { capabilityId: "session.interrupt", supported: true, available: true, allowed: true },
  ]
  function Fixture() {
    const [draft, setDraft] = useState(value)
    return h(NextIntlClientProvider, { locale: "en", messages }, h(SessionComposer, {
      token: "fixture", session: { id: "session", runtime: "codex", runtimeId: "codex", connectorStatus: "online", takeover, status: "running" },
      runtimeState: { status: "running", selections: {}, metadata: {} }, pendingInteractionCount: 0,
      sending, interrupting: false, takeoverBusy: false, value: draft,
      effectiveCapabilities: { capabilities }, modelCatalog: null, permissionCatalog: null, runtimeCommands: [],
      onValueChange: setDraft, onCommandQueryChange() {}, onSelectionChange: async () => true,
      onSend: async (...args) => { calls.push(args); return true }, onInterrupt() {}, onCommand() {}, onToggleTakeover() {},
    }))
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(Fixture)))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { container, calls }
}

async function enter(container) {
  await act(async () => container.querySelector("textarea").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
}

test("running tasks can queue via Enter while a prior send is pending", async t => {
  const { container, calls } = await render(t, { sending: true })
  assert.equal(container.querySelector("textarea").disabled, false)
  await enter(container)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "follow up")
  assert.equal(calls[0][3], "queue")
  assert.equal(container.querySelector("textarea").value, "")
})

test("steering sends the explicit mode without starting a new turn", async t => {
  const { container, calls } = await render(t)
  await act(async () => container.querySelector('[aria-label="Send mode"]').dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Steer now")
  assert.ok(item)
  await act(async () => item.click())
  await enter(container)
  assert.equal(calls[0][3], "steer")
})

test("unsupported steering is disabled and read-only sessions cannot send", async t => {
  const { container, calls } = await render(t, { steer: false, takeover: false })
  await act(async () => container.querySelector('[aria-label="Send mode"]').dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Steering unavailable")
  assert.equal(item.getAttribute("aria-disabled"), "true")
  await enter(container)
  assert.equal(calls.length, 0)
})
