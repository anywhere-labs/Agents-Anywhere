import assert from "node:assert/strict"
import test from "node:test"
import {
  createTimelineSyncScheduler,
  sessionRequiresTimelineSync,
  TIMELINE_SYNC_COOLDOWN_MS,
  TIMELINE_SYNC_INFLIGHT_TTL_MS,
} from "../src/components/session/session-timeline-sync.ts"

const state = (metadata) => ({ sessionId: "a", runtime: "any", status: "idle", selections: {}, metadata, updatedSeq: 1, createdAt: "now", updatedAt: "now" })
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test("only an explicit requires_timeline_sync flag asks for the session's history", () => {
  assert.equal(sessionRequiresTimelineSync(state({ sync: { changed: true, requires_timeline_sync: true } })), true)
  assert.equal(sessionRequiresTimelineSync(state({ sync: { requires_timeline_sync: true } })), true, "changed is not required")
  assert.equal(sessionRequiresTimelineSync(state({ sync: { changed: true, requires_timeline_sync: false } })), false)
  assert.equal(sessionRequiresTimelineSync(state({ sync: { changed: true } })), false)
  assert.equal(sessionRequiresTimelineSync(state({ sync: { requires_timeline_sync: "true" } })), false)
  assert.equal(sessionRequiresTimelineSync(state({ sync: null })), false)
  assert.equal(sessionRequiresTimelineSync(state({})), false)
  assert.equal(sessionRequiresTimelineSync(null), false)
  assert.equal(sessionRequiresTimelineSync(undefined), false)
})

test("one request per session per cooldown window, independent per session", async () => {
  let clock = 1_000_000
  const scheduler = createTimelineSyncScheduler({ now: () => clock })
  const sent = []
  const send = async () => { sent.push(clock) }
  assert.equal(scheduler.request("a", send), true)
  await settle()
  clock += 1000
  assert.equal(scheduler.request("a", send), false, "a reopen within the cooldown reuses the earlier request")
  assert.equal(scheduler.request("b", send), true, "other sessions are not throttled by it")
  await settle()
  clock = 1_000_000 + TIMELINE_SYNC_COOLDOWN_MS
  assert.equal(scheduler.request("a", send), true, "the cooldown has elapsed")
  await settle()
  assert.deepEqual(sent, [1_000_000, 1_001_000, 1_000_000 + TIMELINE_SYNC_COOLDOWN_MS])
})

test("a request in flight is skipped, and one that never settles stops blocking after the TTL", async () => {
  let clock = 0
  const scheduler = createTimelineSyncScheduler({ now: () => clock })
  const sent = []
  let finish
  scheduler.request("a", () => new Promise(resolve => { finish = resolve }))
  await settle()
  clock = 5000
  assert.equal(scheduler.request("a", async () => { sent.push("overlap") }), false)
  clock = TIMELINE_SYNC_INFLIGHT_TTL_MS
  assert.equal(scheduler.request("a", async () => { sent.push("after the TTL") }), true)
  await settle()
  finish()
  await settle()
  assert.deepEqual(sent, ["after the TTL"])
})

test("a late settlement cannot clear a newer request's in-flight guard", async () => {
  let clock = 0
  const scheduler = createTimelineSyncScheduler({ cooldownMs: 0, now: () => clock })
  const finishes = []
  const hanging = () => new Promise(resolve => { finishes.push(resolve) })
  scheduler.request("a", hanging)
  await settle()
  clock = TIMELINE_SYNC_INFLIGHT_TTL_MS
  assert.equal(scheduler.request("a", hanging), true, "the first request is abandoned after the TTL")
  await settle()
  finishes[0]()
  await settle()
  assert.equal(scheduler.request("a", hanging), false, "the newer request is still in flight")
  finishes[1]()
  await settle()
  assert.equal(scheduler.request("a", async () => {}), true)
  await settle()
  assert.equal(finishes.length, 2)
})

test("failures are swallowed and release the in-flight guard", async () => {
  const scheduler = createTimelineSyncScheduler({ cooldownMs: 0 })
  const sent = []
  assert.equal(scheduler.request("a", async () => { throw new Error("connector is offline") }), true)
  await settle()
  assert.equal(scheduler.request("a", async () => { sent.push("again") }), true)
  await settle()
  assert.deepEqual(sent, ["again"])
})
