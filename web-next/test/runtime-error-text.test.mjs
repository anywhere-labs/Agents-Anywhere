import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test/" })
for (const name of ["window", "document", "navigator", "HTMLElement", "Node"]) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { NextIntlClientProvider } = await import("next-intl")
const hooks = registerSource()
const { runtimeFailureOf, useRuntimeErrorText } = await import("../src/lib/runtime-error-text.ts")
const { ApiError } = await import("../src/lib/api/errors.ts")
hooks.deregister()

async function render(locale, failure, fallback) {
  const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"))
  let text
  function Probe() { text = useRuntimeErrorText()(failure, fallback); return null }
  const root = createRoot(document.createElement("div"))
  await act(async () => root.render(h(NextIntlClientProvider, { locale, messages, timeZone: "UTC" }, h(Probe))))
  await act(async () => root.unmount())
  return text
}

test("runtime errors: a known code follows the UI language instead of the Connector message", async () => {
  const failure = { code: "pi_source_ambiguous", message: "多个历史文件具有相同会话身份，请先确认来源。" }
  assert.equal(await render("en", failure), "Several history files share the same session identity. Confirm the source first.")
  assert.equal(await render("zh-CN", failure), "多个历史文件具有相同会话身份，请先确认来源。")
})

test("runtime errors: unknown codes fall back to the message, then to the caller's fallback", async () => {
  assert.equal(await render("en", { code: "brand_new_code", message: "raw detail" }), "raw detail")
  assert.equal(await render("en", null, "Fallback"), "Fallback")
})

test("runtime errors: API and Connector failures keep their stable code", () => {
  const api = new ApiError({ status: 409, detail: "请先启动 Runtime。", kind: "conflict", code: "runtime_not_running" })
  assert.deepEqual(runtimeFailureOf(api), { code: "runtime_not_running", message: "请先启动 Runtime。" })
  assert.deepEqual(runtimeFailureOf({ code: "pi_resume_failed", message: "x" }), { code: "pi_resume_failed", message: "x" })
  assert.deepEqual(runtimeFailureOf(new Error("plain")), { code: undefined, message: "plain" })
})
