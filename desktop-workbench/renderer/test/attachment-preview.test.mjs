import assert from "node:assert/strict"
import test from "node:test"

import {
  attachmentIsImage,
  attachmentShouldReadFromDevice,
} from "../src/features/dashboard/attachments.ts"

test("persisted user attachments prefer their server source over device paths", () => {
  assert.equal(attachmentShouldReadFromDevice({
    fileId: "file_123",
    name: "brief.pdf",
    path: "/device/cache/brief.pdf",
  }), false)
  assert.equal(attachmentShouldReadFromDevice({
    fileId: "local-result",
    name: "result.txt",
    path: "/workspace/result.txt",
  }), true)
  assert.equal(attachmentShouldReadFromDevice({
    fileId: "local-result",
    name: "result.txt",
    path: "/workspace/result.txt",
  }, true), false)
})

test("image lightbox classification uses resolved names and media types", () => {
  assert.equal(attachmentIsImage("opaque", "image/png"), true)
  assert.equal(attachmentIsImage("resolved-photo.webp", "application/octet-stream"), true)
  assert.equal(attachmentIsImage("brief.pdf", "application/pdf"), false)
})
