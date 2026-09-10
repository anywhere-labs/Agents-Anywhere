import assert from "node:assert/strict"
import test from "node:test"

import { shouldAuthorizeDownloadUrl } from "../src/lib/api/download-auth.ts"
import { desktopDownloadUrl, setDesktopServerConnection } from "../src/features/desktop/server-connection.ts"

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

test("self-hosted downloads use the Desktop proxy and never authorize another server", () => {
  setDesktopServerConnection({ serverUrl: "https://self.example", apiNamespace: "/api/v2", oauthWebOrigin: "https://self.example" })
  assert.equal(desktopDownloadUrl("/api/v2/files/1?download=1"), "aa-workbench://web/api/v2/files/1?download=1")
  assert.equal(desktopDownloadUrl("https://self.example/api/v2/files/1"), "aa-workbench://web/api/v2/files/1")
  assert.equal(desktopDownloadUrl("https://storage.example/files/1"), "https://storage.example/files/1")
  assert.equal(shouldAuthorizeDownloadUrl("aa-workbench://web/api/v2/files/1"), true)
  assert.equal(shouldAuthorizeDownloadUrl("aa-workbench://other/api/v2/files/1"), false)
  assert.equal(shouldAuthorizeDownloadUrl("https://self.example/api/v2/files/1"), true)
  assert.equal(shouldAuthorizeDownloadUrl("https://web.agents-anywhere.com/api/v2/files/1"), false)
  assert.equal(shouldAuthorizeDownloadUrl("//storage.example/files/1"), false)
})
