import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

import {
  mergeQueueState,
  messageMustWait,
  queuedDelivery,
  queueItemEditable,
  queuePause,
  readQueueState,
} from "../src/features/message-queue/queue-model.ts"

const item = (id, status = "queued", position = 1) => ({
  messageId: id, sessionId: "s", clientMessageId: `cm-${id}`, content: id, status, position,
  interruptRequested: false, error: status === "failed" ? { code: "x", message: "boom" } : null,
})
const queue = (revision, items = []) => ({ sessionId: "s", revision, items })

test("an older queue revision never replaces a newer one", () => {
  const newer = queue(5, [item("a")])
  assert.equal(mergeQueueState(newer, queue(4, [])), newer)
  const emptied = queue(6, [])
  assert.equal(mergeQueueState(newer, emptied), emptied)
  assert.equal(mergeQueueState(null, null), null)
  // A different session's queue replaces the current one outright.
  const other = { ...queue(1), sessionId: "t" }
  assert.equal(mergeQueueState(newer, other), other)
})

test("a message waits while the turn runs or earlier messages wait", () => {
  for (const status of ["running", "waiting", "pending", "waiting_approval", "blocked", "stopping"]) {
    assert.equal(messageMustWait(status, null), true, status)
  }
  assert.equal(messageMustWait("idle", null), false)
  assert.equal(messageMustWait("idle", queue(1, [])), false)
  assert.equal(messageMustWait("idle", queue(1, [item("a")])), true)
  assert.equal(messageMustWait("error", null), false)
})

test("the queue pauses behind a failure or an errored turn", () => {
  assert.equal(queuePause("idle", queue(1, [])), null)
  assert.equal(queuePause("idle", queue(1, [item("a", "failed"), item("b", "queued", 2)])), "failed")
  assert.equal(queuePause("error", queue(1, [item("a")])), "error")
  assert.equal(queuePause("running", queue(1, [item("a")])), null)
  assert.equal(queuePause("error", queue(1, [item("a", "sending")])), null)
})

test("a message being sent cannot be edited", () => {
  assert.equal(queueItemEditable(item("a", "sending")), false)
  assert.equal(queueItemEditable(item("a", "queued")), true)
  assert.equal(queueItemEditable(item("a", "failed")), true)
})

test("only a queued delivery carries a queue", () => {
  const state = queue(3, [item("a")])
  assert.deepEqual(queuedDelivery({ delivery: "queued", queue: state }), state)
  assert.equal(queuedDelivery({ delivery: "sent" }), undefined)
  assert.equal(queuedDelivery(null), undefined)
  assert.equal(queuedDelivery({ delivery: "queued", queue: { nope: true } }), null)
  assert.equal(readQueueState({ sessionId: "s", revision: "1", items: [] }), null)
})

test("queue events reach the controller's domain events, not the timeline", async t => {
  registerSource()
  const { createSessionController } = await import("../src/components/session/session-controller.ts")
  const { dashboardApi } = await import("../src/features/dashboard/api.ts")
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "info", () => {})
  const previousSocket = globalThis.WebSocket
  const sockets = []
  globalThis.WebSocket = class {
    constructor() { sockets.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }
  const session = { id: "a", connectorId: "c", connectorStatus: "online", runtime: "codex", status: "running", updatedSeq: 10 }
  t.mock.method(dashboardApi, "createWsTicket", async () => ({ ticket: "ticket" }))
  t.mock.method(dashboardApi, "getSessionEvents", async () => ({ events: [], nextCursor: "seq:10", snapshotRequired: false }))
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: { sessionId: "a", runtime: "codex", status: "running", updatedSeq: 10 }, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [] }, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [], serverTime: "now" }))
  const controller = createSessionController({
    token: "token", sessionId: "a", hasSnapshot: true,
    initialState: { session, state: null, items: [], notices: [], nextSeq: 10, hasMore: false, timelineResetVersion: 0, serverTime: "now", eventCursor: "seq:10", effectiveCapabilities: null, catalogs: {} },
    applyOptimisticItems: state => state, clearResolvedOptimisticMessages() {}, onInvalidated() {},
  })
  t.after(() => { controller.dispose(); globalThis.WebSocket = previousSocket })
  controller.start()
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  await settle()
  const socket = sockets.at(-1)
  const send = (type, payload, sequence = 10) => socket.onmessage?.({ data: JSON.stringify({
    protocolVersion: "1.0", sessionId: "a", type, payload, sequence, cursor: `seq:${sequence}`, eventId: `${type}:${sequence}:${JSON.stringify(payload).length}`, emittedAt: "now",
  }) })
  send("session.subscribed", {})
  await settle()
  const state = queue(2, [item("a")])
  send("runtime.queue.updated", { queue: state })
  await settle()
  const snapshot = controller.getSnapshot()
  assert.deepEqual(snapshot.domainEvents.get("runtime.queue.updated")?.payload.queue, state)
  assert.equal(snapshot.state.items.length, 0)
})
