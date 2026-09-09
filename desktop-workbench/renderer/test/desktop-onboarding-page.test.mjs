import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.scrollTo = function () { this.scrollTop = 0 }
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { AuthProvider } = await import("../src/components/auth/auth-context.tsx")
const { DesktopOnboardingPage } = await import("../src/components/onboarding/desktop-onboarding-page.tsx")
const { authApi } = await import("../src/features/auth/api.ts")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
hooks.deregister()
const account = { userId: "user1", displayName: "测试用户", role: "admin" }
const connector = {
  id: "conn_local", userId: "user1", name: "测试 Mac", status: "online",
  lastSeenAt: null, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
}

async function render(t, { source = "desktop", flowId = "" } = {}) {
  const completed = []
  window.localStorage.clear()
  const hash = `#/onboarding?source=${source}${flowId ? `&flowId=${flowId}` : ""}`
  window.history.replaceState({}, "", `/${hash}`)
  window.localStorage.setItem("aa.session.v1", JSON.stringify({ ...account, accessToken: "test-session" }))
  window.desktopWorkbench = {
    platform: "darwin",
    versions: { chrome: "1", electron: "1", node: "1" },
    openExternal: async () => {},
    device: { createAndConnect: async () => ({ connectorId: connector.id, serverUrl: "https://web.example.test" }) },
    onboarding: { complete: async (value) => { completed.push(value); return { completedAt: "2026-09-09T00:00:00.000Z", source: value } } },
  }
  t.mock.method(authApi, "config", async () => ({ needsBootstrap: false, registrationOpen: true }))
  t.mock.method(authApi, "me", async () => account)
  t.mock.method(dashboardApi, "getConnector", async () => ({ connector }))
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(
    h(NextIntlClientProvider, {
      locale: "zh-CN",
      messages: JSON.parse(readFileSync(new URL("../messages/zh-CN.json", import.meta.url), "utf8")),
      timeZone: "Asia/Shanghai",
    }, h(AuthProvider, null, h(DesktopOnboardingPage))),
  ))
  t.after(async () => { await act(async () => root.unmount()); container.remove(); delete window.desktopWorkbench })
  return { container, completed }
}

async function until(check) {
  for (let count = 0; count < 100; count++) {
    if (check()) return
    await act(async () => { await delay(15) })
  }
  assert.fail("Expected UI state did not arrive: " + document.body.textContent)
}

function button(container, label) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label)
}

test("a desktop launch starts on the copied web welcome slide", async (t) => {
  const { container } = await render(t)
  await until(() => container.querySelector('[data-slide="welcome"]'))
  assert.match(container.textContent, /你的 Agent，/)
  assert.ok(container.querySelector('img[src="/images/onboarding/desktop.webp"]'))
  assert.ok(button(container, "下一页"))
  assert.ok(button(container, "跳过引导"))
})

test("skipping records completion for a user launch and opens the app", async (t) => {
  const { container, completed } = await render(t)
  await until(() => container.querySelector('[data-slide="welcome"]'))
  await act(async () => { button(container, "跳过引导").click(); await delay(10) })
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog, "the skip confirmation did not open")
  assert.match(dialog.textContent, /确认跳过引导？/)
  await act(async () => {
    [...dialog.querySelectorAll("button")].find((item) => item.textContent === "确认跳过").click()
    await delay(10)
  })
  await until(() => container.querySelector('[data-slide="complete"]'))
  await act(async () => { button(container, "立刻体验").click(); await delay(10) })
  await until(() => completed.length === 1)
  assert.deepEqual(completed, ["desktop"])
  assert.equal(window.location.hash, "#/")
})

test("a plugin flow records the plugin source", async (t) => {
  const { container, completed } = await render(t, { source: "dsh-plugin", flowId: "abcdefghijklmnopqrstuvwx" })
  await until(() => container.querySelector('[data-slide="welcome"]'))
  await act(async () => { button(container, "跳过引导").click(); await delay(10) })
  const dialog = document.querySelector('[role="dialog"]')
  await act(async () => {
    [...dialog.querySelectorAll("button")].find((item) => item.textContent === "确认跳过").click()
    await delay(10)
  })
  await until(() => container.querySelector('[data-slide="complete"]'))
  await act(async () => { button(container, "立刻体验").click(); await delay(10) })
  await until(() => completed.length === 1)
  assert.deepEqual(completed, ["dsh-plugin"])
})
