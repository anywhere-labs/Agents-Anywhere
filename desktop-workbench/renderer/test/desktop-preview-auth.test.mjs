import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fixture.example/", pretendToBeVisual: true })
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

function Screen() {
  const { screen, loading } = useAuth()
  return h("output", { "data-screen": loading ? "loading" : screen })
}

async function renderPreview(t, bridge) {
  window.history.replaceState({}, "", "/#/preview?path=%2Frepo%2Fmain.ts")
  window.localStorage.clear()
  const stored = JSON.stringify({ accessToken: "saved-token", userId: "user-1", role: "admin", serverUrl: "https://server.example" })
  window.localStorage.setItem("aa.session.v1", stored)
  if (bridge) window.desktopWorkbench = { auth: bridge }
  else delete window.desktopWorkbench
  t.mock.method(authApi, "me", async () => assert.fail("Preview must not validate and clear the shared login session"))
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC",
  }, h(AuthProvider, null, h(Screen)))))
  t.after(async () => { await act(async () => root.unmount()); host.remove(); delete window.desktopWorkbench })
  return { host, stored }
}

test("first preview window keeps its route and saved login without a desktop preload bridge", async t => {
  const { host, stored } = await renderPreview(t)
  assert.equal(host.querySelector("output").dataset.screen, "preview")
  assert.equal(window.localStorage.getItem("aa.session.v1"), stored)
})

test("preview still opens when desktop server initialization fails", async t => {
  const { host, stored } = await renderPreview(t, { getServer: async () => { throw new Error("bridge unavailable") } })
  assert.equal(host.querySelector("output").dataset.screen, "preview")
  assert.equal(window.localStorage.getItem("aa.session.v1"), stored)
})
