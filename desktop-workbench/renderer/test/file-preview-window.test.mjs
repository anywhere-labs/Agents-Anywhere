import assert from "node:assert/strict"
import test from "node:test"

import { nativeFilePreviewUrl, openNativeFilePreviewWindow, requestNativeFilePreviewToken, PREVIEW_AUTH_REQUEST, PREVIEW_AUTH_RESPONSE } from "../src/lib/file-preview-window.ts"

test("workspace files open through the product preview route", () => {
  const url = nativeFilePreviewUrl({
    connectorId: "connector-1",
    root: "/repo",
    file: { name: "main.ts", path: "/repo/src/main.ts" },
  })

  assert.match(url, /^\/#\/preview\?/)
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1))
  assert.equal(params.get("connectorId"), "connector-1")
  assert.equal(params.get("root"), "/repo")
  assert.equal(params.get("path"), "/repo/src/main.ts")
  assert.equal(params.get("sourceUrl"), null)
})

test("message attachments open through the product preview route with source metadata", () => {
  const sourceUrl = "/api/v2/sessions/session-1/attachments/file-1/open?token=secret"
  const url = nativeFilePreviewUrl({
    connectorId: "connector-1",
    root: "/repo",
    file: {
      name: "timeline.json",
      path: "/attachments/timeline.json",
      sourceUrl,
      mediaType: "application/json",
      size: 594_400,
    },
  })

  assert.match(url, /^\/#\/preview\?/)
  assert.equal(url.startsWith(sourceUrl), false)
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1))
  assert.equal(params.get("sourceUrl"), sourceUrl)
  assert.equal(params.get("mediaType"), "application/json")
  assert.equal(params.get("size"), "594400")
})

test("desktop preview hands authentication only to its matching same-origin child", t => {
  const originalWindow = globalThis.window
  const listeners = new Map()
  const sent = []
  let openedUrl = ""
  let focused = false
  let closeCheck
  const child = {
    closed: false,
    focus() { focused = true },
    postMessage(...args) { sent.push(args) },
  }
  globalThis.window = {
    location: { origin: "aa-workbench://web" },
    open(url) { openedUrl = url; return child },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type) },
    setInterval(callback) { closeCheck = callback; return 1 },
    clearInterval() {},
  }
  t.after(() => { globalThis.window = originalWindow })

  openNativeFilePreviewWindow({
    token: "private-access-token",
    connectorId: "connector-1",
    root: "C:\\repo",
    file: { name: "main.ts", path: "C:\\repo\\main.ts" },
  })
  assert.equal(focused, true)
  assert.equal(openedUrl.includes("private-access-token"), false)
  const requestId = new URLSearchParams(openedUrl.split("?")[1]).get("previewRequestId")
  assert.ok(requestId)
  const request = { type: PREVIEW_AUTH_REQUEST, previewRequestId: requestId }
  listeners.get("message")({ source: {}, origin: "aa-workbench://web", data: request })
  listeners.get("message")({ source: child, origin: "https://elsewhere.example", data: request })
  listeners.get("message")({ source: child, origin: "aa-workbench://web", data: { ...request, previewRequestId: "other" } })
  assert.deepEqual(sent, [])
  listeners.get("message")({ source: child, origin: "aa-workbench://web", data: request })
  assert.deepEqual(sent, [[
    { type: PREVIEW_AUTH_RESPONSE, previewRequestId: requestId, token: "private-access-token" },
    "aa-workbench://web",
  ]])
  child.closed = true
  closeCheck()
  assert.equal(listeners.has("message"), false)
})

test("preview accepts authentication only from its opener for the current request", t => {
  const originalWindow = globalThis.window
  const listeners = new Map()
  const requests = []
  const opener = { postMessage(...args) { requests.push(args) } }
  globalThis.window = {
    opener,
    location: { origin: "aa-workbench://web" },
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type) },
  }
  t.after(() => { globalThis.window = originalWindow })
  const accepted = []
  const dispose = requestNativeFilePreviewToken("request-1", token => accepted.push(token))
  assert.deepEqual(requests, [[{ type: PREVIEW_AUTH_REQUEST, previewRequestId: "request-1" }, "aa-workbench://web"]])
  const reply = { type: PREVIEW_AUTH_RESPONSE, previewRequestId: "request-1", token: "private-access-token" }
  listeners.get("message")({ source: {}, origin: "aa-workbench://web", data: reply })
  listeners.get("message")({ source: opener, origin: "https://elsewhere.example", data: reply })
  listeners.get("message")({ source: opener, origin: "aa-workbench://web", data: { ...reply, previewRequestId: "other" } })
  assert.deepEqual(accepted, [])
  listeners.get("message")({ source: opener, origin: "aa-workbench://web", data: reply })
  assert.deepEqual(accepted, ["private-access-token"])
  dispose()
  assert.equal(listeners.has("message"), false)
})
