import assert from "node:assert/strict"
import test from "node:test"

import { watchConnectorPresence } from "../src/features/dashboard/connector-presence.ts"

function fakeScheduler() {
  const pending = []
  return {
    scheduler: {
      schedule(callback) {
        const handle = { callback, cancelled: false }
        pending.push(handle)
        return handle
      },
      cancel(handle) {
        handle.cancelled = true
      },
    },
    async runNext() {
      const handle = pending.shift()
      assert.ok(handle, "expected a scheduled presence check")
      if (!handle.cancelled) handle.callback()
      await Promise.resolve()
      await Promise.resolve()
    },
    pending,
  }
}

test("presence polling reports an offline transition and a later reconnect", async () => {
  const { scheduler, runNext } = fakeScheduler()
  const results = [false, true]
  const transitions = []
  const stop = watchConnectorPresence({
    initialOnline: true,
    intervalMs: 2000,
    scheduler,
    check: async () => results.shift(),
    onTransition: (transition) => transitions.push(transition),
  })

  await runNext()
  await runNext()
  stop()

  assert.deepEqual(transitions, [
    { online: false, reconnected: false },
    { online: true, reconnected: true },
  ])
})

test("an unreachable presence API is treated as offline and keeps polling", async () => {
  const { scheduler, runNext, pending } = fakeScheduler()
  const transitions = []
  let attempts = 0
  const stop = watchConnectorPresence({
    initialOnline: true,
    intervalMs: 2000,
    scheduler,
    check: async () => {
      attempts += 1
      throw new Error("network unavailable")
    },
    onTransition: (transition) => transitions.push(transition),
  })

  await runNext()

  assert.equal(attempts, 1)
  assert.deepEqual(transitions, [{ online: false, reconnected: false }])
  assert.equal(pending.length, 1)
  stop()
})

test("cleanup cancels a timer and fences an in-flight response", async () => {
  const first = fakeScheduler()
  const cancelledTransitions = []
  const stopBeforeTick = watchConnectorPresence({
    initialOnline: true,
    intervalMs: 2000,
    scheduler: first.scheduler,
    check: async () => false,
    onTransition: (transition) => cancelledTransitions.push(transition),
  })
  stopBeforeTick()
  await first.runNext()
  assert.deepEqual(cancelledTransitions, [])

  const second = fakeScheduler()
  let resolveCheck
  const check = new Promise((resolve) => {
    resolveCheck = resolve
  })
  const staleTransitions = []
  const stopInFlight = watchConnectorPresence({
    initialOnline: true,
    intervalMs: 2000,
    scheduler: second.scheduler,
    check: () => check,
    onTransition: (transition) => staleTransitions.push(transition),
  })
  await second.runNext()
  stopInFlight()
  resolveCheck(false)
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(staleTransitions, [])
  assert.equal(second.pending.length, 0)
})
