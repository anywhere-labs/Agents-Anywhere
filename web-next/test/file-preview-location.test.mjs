import assert from "node:assert/strict"
import test from "node:test"
import { filePreviewLocation } from "../src/lib/file-preview-location.ts"

test("scoped previews accept line and optional column without changing file identity", () => {
  assert.deepEqual(filePreviewLocation("42", "8"), { lineNumber: 42, column: 8 })
  assert.deepEqual(filePreviewLocation("42", null), { lineNumber: 42, column: 1 })
})

test("invalid and unbounded locations cannot be passed to the editor", () => {
  for (const line of [null, "", "0", "-1", "NaN", "1.2", "1e3", "Infinity", "2147483648", "999999999999999999999"]) {
    assert.equal(filePreviewLocation(line, "3"), undefined)
  }
  for (const column of [null, "", "0", "-1", "2.5", "999999999999999999999"]) {
    assert.deepEqual(filePreviewLocation("4", column), { lineNumber: 4, column: 1 })
  }
})
