import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MutationObserver"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { AuthProvider, useAuth } = await import("../src/components/auth/auth-context.tsx")
const { authApi } = await import("../src/features/auth/api.ts")
hooks.deregister()
const messages = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))
const account = { userId: "admin-1", displayName: "Administrator", role: "admin" }
const stored = JSON.stringify({ ...account, accessToken: "test-session" })

async function render(t, hash, signedIn = true) {
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState({}, "", "/" + hash)
  if (signedIn) window.localStorage.setItem("aa.session.v1", stored)
  t.mock.method(authApi, "config", async () => ({ needsBootstrap: false, registrationOpen: true }))
  const me = t.mock.method(authApi, "me", async () => account)
  let auth
  function Capture() { auth = useAuth(); return null }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" }, h(AuthProvider, null, h(Capture)))))
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  assert.equal(auth.loading, false)
  return { current: () => auth, me }
}

async function navigate(hash) {
  await act(async () => {
    window.location.hash = hash
    await delay(10)
  })
}

test("administration routes are app routes that keep the login session", async (t) => {
  const { current, me } = await render(t, "#/")
  assert.equal(current().screen, "app")
  for (const hash of [
    "#/admin/overview", "#/admin/users", "#/admin/usage", "#/admin/devices", "#/admin/quality",
    "#/admin/team", "#/admin/announcements", "#/admin/service-general", "#/admin/service-auth", "#/admin",
    "#/dashboard", "#/team", "#/service", "#/settings/account", "#/",
  ]) {
    await navigate(hash)
    assert.equal(current().screen, "app", hash)
    assert.equal(current().isAuthenticated, true, hash)
    assert.equal(current().session.accessToken, "test-session", hash)
    assert.equal(window.localStorage.getItem("aa.session.v1"), stored, hash)
  }
  assert.equal(me.mock.callCount(), 1)
  // Unrelated route names keep the existing fallback.
  await navigate("#/administrator")
  assert.equal(current().screen, "login")
  assert.equal(current().isAuthenticated, true)
})

test("reloading on an administration route stays authenticated across sections", async (t) => {
  const { current } = await render(t, "#/admin/overview")
  assert.equal(current().screen, "app")
  assert.equal(current().isAuthenticated, true)
  await navigate("#/admin/team")
  assert.equal(current().screen, "app")
  assert.equal(window.localStorage.getItem("aa.session.v1"), stored)
})

test("administration routes still require a valid login session", async (t) => {
  const { current, me } = await render(t, "#/admin/overview", false)
  assert.equal(current().screen, "login")
  assert.equal(current().isAuthenticated, false)
  assert.equal(me.mock.callCount(), 0)
  assert.equal(window.localStorage.getItem("aa.session.v1"), null)
})
