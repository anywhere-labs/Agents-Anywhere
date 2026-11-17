// The pairing dialog: paste an aa-pair:// link, compare the device fingerprint, pair.
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test/", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { SecurePairingDialog } = await import("../src/components/e2ee/secure-pairing-dialog.tsx")
const { startE2ee } = await import("../src/features/e2ee/runtime.ts")
const { b64url, utf8 } = await import("../src/lib/e2ee/bytes.ts")
const { identityFingerprint } = await import("../src/lib/e2ee/formats.ts")
hooks.deregister()

const messages = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))

async function until(check) {
  for (let count = 0; count < 200; count++) {
    if (check()) return
    await act(async () => { await delay(10) })
  }
  assert.fail("Expected UI state did not arrive: " + document.body.textContent)
}

async function typeInto(element, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
}

test("pasting a pairing link shows the device fingerprint and pairs", async (t) => {
  const runtime = startE2ee("web")
  assert.ok(runtime, "runtime starts with WebCrypto")
  const pairedWith = []
  runtime.pair = async (payload) => {
    pairedWith.push(payload)
    return { deviceId: payload.deviceId }
  }
  const devicePub = crypto.getRandomValues(new Uint8Array(32))
  const payload = {
    v: 1, deviceId: "dev_ui", deviceIdentityPub: b64url(devicePub), pairingId: "pair_1",
    psk: b64url(crypto.getRandomValues(new Uint8Array(32))), serverUrl: "https://aa.test", e2eeMode: "required",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }
  const uri = `aa-pair://${b64url(utf8(JSON.stringify(payload)))}`
  const paired = []

  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" },
    h(SecurePairingDialog, { open: true, onOpenChange() {}, onPaired: (id) => paired.push(id) }))))
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await runtime.dispose() })

  const textarea = () => document.getElementById("e2ee-pairing-link")
  await until(() => textarea())
  const pairButton = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Pair")
  assert.equal(pairButton().disabled, true)

  await typeInto(textarea(), "https://not-a-pairing-link")
  await until(() => document.body.textContent.includes("This is not a pairing link"))

  await typeInto(textarea(), uri)
  const fingerprint = await identityFingerprint(devicePub)
  await until(() => document.querySelector("[data-testid=e2ee-pairing-fingerprint]")?.textContent === fingerprint)
  assert.ok(document.body.textContent.includes("dev_ui"))
  assert.equal(pairButton().disabled, false)

  await act(async () => pairButton().click())
  await until(() => paired.length === 1)
  assert.deepEqual(pairedWith[0], payload)
  assert.deepEqual(paired, ["dev_ui"])
})

test("the pairing dialog can be opened again and again on request", async (t) => {
  registerSource()
  const { SecurePairingHost } = await import("../src/components/e2ee/secure-pairing-host.tsx")
  const { requestSecurePairing } = await import("../src/lib/e2ee/state.ts")
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" }, h(SecurePairingHost))))
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  const textarea = () => document.getElementById("e2ee-pairing-link")
  for (let round = 0; round < 2; round++) {
    await act(async () => requestSecurePairing("dev_again"))
    await until(() => textarea())
    assert.ok(document.body.textContent.includes("dev_again"))
    const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")
    await act(async () => cancel.click())
    await until(() => !textarea())
  }
})
