import assert from "node:assert/strict"
import test from "node:test"

import { nativeFilePreviewUrl } from "../src/lib/file-preview-window.ts"

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
