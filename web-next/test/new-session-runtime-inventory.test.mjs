import assert from "node:assert/strict"
import test from "node:test"

import {
  runtimeInventoryNeedsReconnectSettling,
  watchNewSessionRuntimeInventory,
} from "../src/features/dashboard/new-session-runtime-inventory.ts"

function runtime(overrides = {}) {
  return {
    connectorId: "connector-1",
    runtimeId: "codex",
    runtimeType: "codex",
    displayName: "Codex",
    present: true,
    configured: true,
    active: true,
    status: "running",
    discovery: {},
    metadata: {},
    schema: {},
    uiSchema: {},
    config: {},
    error: null,
    lastDiscoveredAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  }
}

function fakeScheduler() {
  const pending = []
  return {
    scheduler: {
      schedule(callback, delayMs) {
        const handle = { callback, delayMs, cancelled: false }
        pending.push(handle)
        return handle
      },
      cancel(handle) {
        handle.cancelled = true
      },
    },
    async flushPromises() {
      await Promise.resolve()
      await Promise.resolve()
    },
    async runNext() {
      const handle = pending.shift()
      assert.ok(handle, "expected a scheduled runtime inventory retry")
      if (!handle.cancelled) handle.callback()
      await Promise.resolve()
      await Promise.resolve()
      return handle
    },
    pending,
  }
}

test("an empty reconnect inventory retries until an active runtime is running", async () => {
  const { scheduler, flushPromises, runNext, pending } = fakeScheduler()
  const responses = [[], [runtime({ status: "starting" })], [runtime()]]
  const updates = []
  let initialSettled = 0

  const stop = watchNewSessionRuntimeInventory({
    connectorIds: ["connector-1"],
    retryDelaysMs: [500, 1_000, 2_000],
    scheduler,
    load: async () => responses.shift(),
    onUpdate: (_connectorId, runtimes) => updates.push(runtimes),
    onInitialSettled: () => { initialSettled += 1 },
  })

  await flushPromises()
  assert.equal(initialSettled, 1)
  assert.equal(pending.length, 1)
  assert.equal((await runNext()).delayMs, 500)
  assert.equal((await runNext()).delayMs, 1_000)
  assert.equal(pending.length, 0)
  assert.deepEqual(updates.map((items) => items[0]?.status ?? "empty"), ["empty", "starting", "running"])
  stop()
})

test("a discovered but intentionally unconfigured inventory does not poll", async () => {
  const { scheduler, flushPromises, pending } = fakeScheduler()
  const unconfigured = [runtime({ configured: false, active: false, config: null, status: "available" })]
  let attempts = 0

  watchNewSessionRuntimeInventory({
    connectorIds: ["connector-1"],
    scheduler,
    load: async () => {
      attempts += 1
      return unconfigured
    },
    onUpdate: () => {},
    onInitialSettled: () => {},
  })

  await flushPromises()
  assert.equal(runtimeInventoryNeedsReconnectSettling(unconfigured), false)
  assert.equal(attempts, 1)
  assert.equal(pending.length, 0)
})

test("mixed running and starting runtimes keep settling for the starting instance", async () => {
  const { scheduler, flushPromises, runNext, pending } = fakeScheduler()
  const first = [
    runtime({ runtimeId: "codex-work" }),
    runtime({ runtimeId: "codex-personal", status: "starting" }),
  ]
  const second = first.map((item) => ({ ...item, status: "running" }))
  const responses = [first, second]
  let attempts = 0

  watchNewSessionRuntimeInventory({
    connectorIds: ["connector-1"],
    retryDelaysMs: [500, 1_000],
    scheduler,
    load: async () => {
      attempts += 1
      return responses.shift()
    },
    onUpdate: () => {},
    onInitialSettled: () => {},
  })

  await flushPromises()
  assert.equal(runtimeInventoryNeedsReconnectSettling(first), true)
  assert.equal((await runNext()).delayMs, 500)
  assert.equal(attempts, 2)
  assert.equal(pending.length, 0)
})

test("empty inventory retries are bounded", async () => {
  const { scheduler, flushPromises, runNext, pending } = fakeScheduler()
  let attempts = 0

  watchNewSessionRuntimeInventory({
    connectorIds: ["connector-1"],
    retryDelaysMs: [500, 1_000],
    scheduler,
    load: async () => {
      attempts += 1
      return []
    },
    onUpdate: () => {},
    onInitialSettled: () => {},
  })

  await flushPromises()
  await runNext()
  await runNext()
  assert.equal(attempts, 3)
  assert.equal(pending.length, 0)
})

test("cleanup cancels scheduled retries and fences an in-flight response", async () => {
  const first = fakeScheduler()
  const stopScheduled = watchNewSessionRuntimeInventory({
    connectorIds: ["connector-1"],
    scheduler: first.scheduler,
    load: async () => [],
    onUpdate: () => {},
    onInitialSettled: () => {},
  })
  await first.flushPromises()
  stopScheduled()
  assert.equal(first.pending.length, 1)
  assert.equal(first.pending[0].cancelled, true)

  const second = fakeScheduler()
  let resolveLoad
  const deferred = new Promise((resolve) => { resolveLoad = resolve })
  const updates = []
  const stopInFlight = watchNewSessionRuntimeInventory({
    connectorIds: ["connector-1"],
    scheduler: second.scheduler,
    load: () => deferred,
    onUpdate: (_connectorId, runtimes) => updates.push(runtimes),
    onInitialSettled: () => {},
  })
  stopInFlight()
  resolveLoad([runtime()])
  await second.flushPromises()

  assert.deepEqual(updates, [])
  assert.equal(second.pending.length, 0)
})
