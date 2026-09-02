import assert from "node:assert/strict"
import test from "node:test"

import { isTransientHttpStatus, retryWithDelays } from "../src/lib/retry.ts"

test("retryWithDelays retries transient failures with the configured backoff", async () => {
  const delays = []
  let attempts = 0
  const result = await retryWithDelays(
    async () => {
      attempts += 1
      if (attempts < 3) throw new Error("not ready")
      return "ready"
    },
    [250, 500],
    () => true,
    async (delayMs) => { delays.push(delayMs) },
  )

  assert.equal(result, "ready")
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [250, 500])
})

test("retryWithDelays stops immediately for permanent failures", async () => {
  let attempts = 0
  await assert.rejects(
    retryWithDelays(
      async () => {
        attempts += 1
        throw new Error("invalid")
      },
      [250, 500],
      () => false,
      async () => {},
    ),
    /invalid/,
  )
  assert.equal(attempts, 1)
})

test("runtime discovery retries startup failures but not request errors", () => {
  assert.equal(isTransientHttpStatus(0), true)
  assert.equal(isTransientHttpStatus(502), true)
  assert.equal(isTransientHttpStatus(503), true)
  assert.equal(isTransientHttpStatus(401), false)
  assert.equal(isTransientHttpStatus(422), false)
})
