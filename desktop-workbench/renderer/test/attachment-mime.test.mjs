import assert from "node:assert/strict"
import test from "node:test"
import { attachmentMimeTypes, attachmentMimeAllowed } from "../src/components/session/capabilities.ts"

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
