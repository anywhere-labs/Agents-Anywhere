import assert from "node:assert/strict"
import test from "node:test"

import {
  BLOB_INLINE_IMAGE_MAX_BYTES,
  BLOB_INLINE_TEXT_MAX_BYTES,
  SESSION_BLOB_CHUNK_MAX_BYTES,
  SessionBlobError,
  blobKind,
  blobText,
  formatBlobBytes,
  readSessionBlob,
  timelineBlobRefs,
} from "../src/features/dashboard/session-blobs.ts"

/** A device that answers slices of `bytes`, at most `cap` bytes each. */
function device(bytes, { cap = Infinity, mediaType = "text/plain; charset=utf-8", tamper } = {}) {
  const calls = []
  const read = async (blobRef, offset, length) => {
    calls.push({ blobRef, offset, length })
    const slice = bytes.subarray(offset, offset + Math.min(length, cap))
    const chunk = { blobRef, name: blobRef, mediaType, encoding: "base64", data: Buffer.from(slice).toString("base64"), offset, size: bytes.length, eof: offset + slice.length >= bytes.length }
    return tamper ? tamper(chunk, calls.length) : chunk
  }
  return { read, calls }
}

test("blob refs keep only well-formed entries", () => {
  assert.deepEqual(timelineBlobRefs({}), [])
  assert.deepEqual(timelineBlobRefs({ blobRefs: "x" }), [])
  assert.deepEqual(timelineBlobRefs({ blobRefs: [
    { path: "/output", blobId: "blob_a", bytes: 10, mediaType: "text/plain" },
    { path: "/content/0/data", blobId: "blob_b", bytes: -1 },
    { blobId: "blob_c" },
    null,
  ] }), [
    { path: "/output", blobId: "blob_a", bytes: 10, mediaType: "text/plain" },
    { path: "/content/0/data", blobId: "blob_b", bytes: 0, mediaType: null },
  ])
})

test("text and images within their limits show inline, the rest are files", () => {
  assert.equal(blobKind({ mediaType: "text/plain; charset=utf-8", bytes: 10 }), "text")
  assert.equal(blobKind({ mediaType: "text/plain", bytes: BLOB_INLINE_TEXT_MAX_BYTES + 1 }), "file")
  assert.equal(blobKind({ mediaType: "IMAGE/PNG", bytes: 10 }), "image")
  assert.equal(blobKind({ mediaType: "image/png", bytes: BLOB_INLINE_IMAGE_MAX_BYTES + 1 }), "file")
  assert.equal(blobKind({ mediaType: "audio/wav", bytes: 10 }), "file")
  assert.equal(blobKind({ mediaType: null, bytes: 10 }), "file")
})

test("a blob is read slice by slice until eof", async () => {
  const text = Array.from({ length: 5000 }, (_, i) => `row ${i} 行`).join("\n")
  const bytes = new TextEncoder().encode(text)
  const { read, calls } = device(bytes, { cap: 7000 })
  const content = await readSessionBlob(read, "blob_x", { chunkBytes: 10_000 })
  assert.equal(blobText(content), text)
  assert.equal(content.size, bytes.length)
  assert.equal(content.mediaType, "text/plain; charset=utf-8")
  assert.deepEqual(calls.map((call) => call.offset), Array.from({ length: Math.ceil(bytes.length / 7000) }, (_, i) => i * 7000))
  assert.ok(calls.every((call) => call.length === 10_000))
  // The slice length never exceeds the route's limit; an empty blob is one read.
  await readSessionBlob(device(new Uint8Array(0)).read, "blob_empty", { chunkBytes: SESSION_BLOB_CHUNK_MAX_BYTES * 2 })
  const { read: one, calls: oneCall } = device(new Uint8Array(3))
  await readSessionBlob(one, "blob_y", { chunkBytes: SESSION_BLOB_CHUNK_MAX_BYTES * 2 })
  assert.equal(oneCall[0].length, SESSION_BLOB_CHUNK_MAX_BYTES)
})

test("misaligned, short, stalled and oversized answers are refused", async () => {
  const bytes = new Uint8Array(100).fill(1)
  const expectCode = async (promise, code) => {
    await assert.rejects(promise, (error) => error instanceof SessionBlobError && error.code === code)
  }
  await expectCode(readSessionBlob(device(bytes, { cap: 40, tamper: (chunk, n) => (n === 2 ? { ...chunk, offset: 0 } : chunk) }).read, "b", { chunkBytes: 40 }), "blob_invalid")
  await expectCode(readSessionBlob(device(bytes, { tamper: (chunk) => ({ ...chunk, size: 200 }) }).read, "b"), "blob_invalid")
  await expectCode(readSessionBlob(device(bytes, { tamper: (chunk) => ({ ...chunk, data: "", eof: false }) }).read, "b"), "blob_invalid")
  await expectCode(readSessionBlob(device(bytes, { tamper: (chunk) => ({ ...chunk, encoding: "hex" }) }).read, "b"), "blob_invalid")
  await expectCode(readSessionBlob(device(bytes).read, "b", { maxBytes: 99 }), "blob_too_large")
})

test("sizes are labelled briefly", () => {
  assert.equal(formatBlobBytes(512), "512 B")
  assert.equal(formatBlobBytes(12_600), "12.3 KB")
  assert.equal(formatBlobBytes(4 * 1024 * 1024), "4.0 MB")
})
