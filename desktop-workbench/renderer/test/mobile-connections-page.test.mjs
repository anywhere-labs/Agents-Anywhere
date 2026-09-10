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
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { AuthProvider } = await import("../src/components/auth/auth-context.tsx")
const { MobileConnectionsPage } = await import("../src/components/pages/mobile-connections-page.tsx")
const { authApi } = await import("../src/features/auth/api.ts")
hooks.deregister()
const account = { userId: "user1", displayName: "测试用户", role: "admin" }

async function render(t, { locale = "zh-CN" } = {}) {
  window.localStorage.clear()
  window.history.replaceState({}, "", "/#/mobile-connections")
  window.localStorage.setItem("aa.session.v1", JSON.stringify({ ...account, accessToken: "test-session" }))
  t.mock.method(authApi, "config", async () => ({ needsBootstrap: false, registrationOpen: true }))
  t.mock.method(authApi, "me", async () => account)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(
    h(NextIntlClientProvider, {
      locale,
      messages: JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")),
      timeZone: "Asia/Shanghai",
    }, h(AuthProvider, null, h(MobileConnectionsPage))),
  ))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return container
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

test("the mobile connection page renders the onboarding phone slide without a wordmark", async (t) => {
  const container = await render(t)
  await until(() => container.querySelector('[data-slide="phone"]'))
  assert.ok(container.querySelector('img[src="/images/onboarding/phone.webp"]'))
  assert.equal(container.querySelector(".aa-wordmark"), null)
  assert.match(container.textContent, /Agent 在工作。/)
  assert.ok(button(container, "连接手机"))
  // The slide stands alone here, so it offers no onboarding "next" step.
  assert.equal(button(container, "下一步"), undefined)
})

test("the slide's connect button opens the QR dialog", async (t) => {
  const container = await render(t)
  await until(() => container.querySelector('[data-slide="phone"]'))
  await act(async () => { button(container, "连接手机").click(); await delay(10) })
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog, "the connect dialog did not open")
  assert.match(dialog.textContent, /下载移动端 App/)
})

test("the slide copy comes from translations, not from hardcoded strings", async (t) => {
  const container = await render(t, { locale: "en" })
  await until(() => container.querySelector('[data-slide="phone"]'))
  assert.match(container.textContent, /Agents at work\./)
  assert.match(container.textContent, /You, anywhere\./)
  assert.ok(button(container, "Connect phone"))
})

test("the sidebar visibility toggle stays available on the page", async (t) => {
  const container = await render(t)
  await until(() => container.querySelector('[data-slide="phone"]'))
  assert.ok(button(container, "在侧边栏隐藏"))
})
