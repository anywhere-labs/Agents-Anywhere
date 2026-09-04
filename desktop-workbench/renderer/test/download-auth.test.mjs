import assert from "node:assert/strict"
import test from "node:test"

import { shouldAuthorizeDownloadUrl } from "../src/lib/api/download-auth.ts"

test("download authorization is limited to relative and trusted API origins", () => {
  const browserOrigin = "http://127.0.0.1:5184"
  const apiBase = "http://127.0.0.1:8000"

  assert.equal(shouldAuthorizeDownloadUrl("/api/v2/files/1", browserOrigin, apiBase), true)
  assert.equal(shouldAuthorizeDownloadUrl("files/1", browserOrigin, apiBase), true)
  assert.equal(shouldAuthorizeDownloadUrl("http://127.0.0.1:5184/api/v2/files/1", browserOrigin, apiBase), true)
  assert.equal(shouldAuthorizeDownloadUrl("http://127.0.0.1:8000/api/v2/files/1", browserOrigin, apiBase), true)
  assert.equal(shouldAuthorizeDownloadUrl("https://storage.example/file", browserOrigin, apiBase), false)
  assert.equal(shouldAuthorizeDownloadUrl("//storage.example/file", browserOrigin, apiBase), false)
  assert.equal(shouldAuthorizeDownloadUrl("\\\\storage.example/file", browserOrigin, apiBase), false)
  assert.equal(shouldAuthorizeDownloadUrl("blob:http://127.0.0.1:5184/id", browserOrigin, apiBase), false)
  assert.equal(shouldAuthorizeDownloadUrl("file:///tmp/private", browserOrigin, apiBase), false)
})
