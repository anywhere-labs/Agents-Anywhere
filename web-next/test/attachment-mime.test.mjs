import assert from "node:assert/strict"
import test from "node:test"
import { attachmentMimeTypes, attachmentMimeAllowed, attachmentRejection, attachmentErrorReasons, isImageMediaType } from "../src/components/session/capabilities.ts"

function capability(runtime, metadata = {}, supported = true) {
  return { capabilityId: "runtime.attachment", runtime, supported, available: true, allowed: true, metadata }
}

test("DSH MIME restrictions follow the selected runtime while older runtimes remain unrestricted", () => {
  const set = { revision: 1, capabilities: [capability("codex"), capability("dsh", {
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  })] }
  const allowed = attachmentMimeTypes(set, "dsh")
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "IMAGE/PNG"]) {
    assert.equal(attachmentMimeAllowed(mime, allowed), true)
  }
  for (const mime of ["application/pdf", "image/svg+xml", "image/avif", "application/octet-stream", ""]) {
    assert.equal(attachmentMimeAllowed(mime, allowed), false)
  }
  assert.equal(attachmentMimeAllowed("application/pdf", attachmentMimeTypes(set, "codex")), true)
  assert.equal(attachmentMimeAllowed("application/pdf", allowed), false, "already selected files are rejected after switching to DSH")
})

test("missing, disabled and malformed restrictions fail closed", () => {
  for (const set of [null, { revision: 1, capabilities: [capability("dsh", {}, false)] },
    { revision: 1, capabilities: [capability("dsh", { allowedMimeTypes: [] })] },
    { revision: 1, capabilities: [capability("dsh", { allowedMimeTypes: "image/*" })] }]) {
    assert.equal(attachmentMimeAllowed("image/png", attachmentMimeTypes(set, "dsh")), false)
  }
})

test("model image limits match the Connector image types regardless of case", () => {
  assert.equal(isImageMediaType("IMAGE/PNG"), true)
  assert.equal(isImageMediaType("image/jpeg; charset=binary"), true)
  // Other image types travel as plain files, so a text-only model can still receive them.
  assert.equal(isImageMediaType("image/svg+xml"), false)
  const textOnly = { enabled: true, allowedMimeTypes: undefined, imagesAllowed: false }
  assert.deepEqual(attachmentRejection("Image/WebP", textOnly), { image: true, type: false })
  assert.deepEqual(attachmentRejection("image/heic", textOnly), { image: false, type: false })
})

test("a mixed drop reports both the model and the transport rejection", () => {
  const limits = { enabled: true, allowedMimeTypes: ["image/png", "text/plain"], imagesAllowed: false }
  assert.deepEqual(attachmentRejection("application/zip", limits), { image: false, type: true })
  assert.deepEqual(attachmentErrorReasons([], { image: true, type: true }, limits), ["image", "type"])
  assert.deepEqual(attachmentErrorReasons(["text/plain"], { image: false, type: false }, limits), [])
  // A stale image rejection no longer applies once the selected model accepts images.
  assert.deepEqual(attachmentErrorReasons([], { image: true, type: false }, { ...limits, imagesAllowed: true }), [])
})
