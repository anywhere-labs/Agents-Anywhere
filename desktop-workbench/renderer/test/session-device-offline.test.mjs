import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { createSessionController } = await import("../src/components/session/session-controller.ts")
const { parseProtocolEvent, sessionHistoryUnavailable } = await import("../src/components/session/session-remote-state.ts")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")

const session = { id: "a", connectorId: "connector", connectorStatus: "online", runtime: "codex", status: "idle", updatedSeq: 10 }
const offlineSession = { ...session, connectorStatus: "offline", updatedSeq: 11 }
const runtimeState = (seq) => ({ sessionId: "a", runtime: "codex", status: "idle", updatedSeq: seq })
const message = (seq, text = `m${seq}`) => ({ id: `m${seq}`, sessionId: "a", type: "message", role: "assistant", status: "done", source: {}, orderSeq: seq, updatedSeq: seq, revision: 1, content: { text } })
const envelope = (type, payload = {}, sequence = 10, protocolVersion = "1.0") => ({ protocolVersion, sessionId: "a", type, payload, sequence, cursor: `seq:${sequence}`, eventId: `${type}:${sequence}`, emittedAt: "now" })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const cachedState = (items = [message(9), message(10)]) => ({ session, state: runtimeState(10), items, notices: [], nextSeq: 10, hasMore: true, timelineResetVersion: 0, serverTime: "now", eventCursor: "seq:10", effectiveCapabilities: null, catalogs: {} })
const offlineSnapshot = { session: offlineSession, state: null, timeline: { items: [], nextSeq: 0, hasMore: false }, notices: [], eventCursor: "seq:0", effectiveCapabilities: { capabilities: [] }, runtimeCapabilities: { capabilities: [] }, catalogs: {}, serverTime: "now", historySource: "unavailable", deviceOffline: true }

async function fixture(t, { initialState = cachedState(), hasSnapshot = true, snapshot = offlineSnapshot, events } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "info", () => {})
  const previousSocket = globalThis.WebSocket
  const sockets = []
  globalThis.WebSocket = class {
    constructor() { sockets.push(this) }
    close() { if (this.closed) return; this.closed = true; this.onclose?.() }
    send(event) { this.onmessage?.({ data: JSON.stringify(event) }) }
    receive(type, payload, sequence, protocolVersion) { this.send(envelope(type, payload, sequence, protocolVersion)) }
  }
  const recoveries = [], snapshots = []
  t.mock.method(dashboardApi, "createWsTicket", async () => ({ ticket: "ticket" }))
  t.mock.method(dashboardApi, "getSessionEvents", async (_token, _id, cursor) => {
    recoveries.push(cursor)
    return events ? events(cursor) : { events: [], nextCursor: cursor, snapshotRequired: false, deviceOffline: true }
  })
  t.mock.method(dashboardApi, "getSessionSnapshot", async () => { snapshots.push(1); return typeof snapshot === "function" ? snapshot() : snapshot })
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: runtimeState(10), serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [] }, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [], serverTime: "now" }))
  const controller = createSessionController({
    token: "token", sessionId: "a", hasSnapshot, initialState,
    applyOptimisticItems: state => state, clearResolvedOptimisticMessages() {}, onInvalidated() {},
  })
  t.after(() => { controller.dispose(); globalThis.WebSocket = previousSocket })
  controller.start()
  await settle()
  return {
    controller, sockets, recoveries, snapshots,
    async subscribe() { sockets.at(-1).receive("session.subscribed"); await settle() },
    async flush() { t.mock.timers.tick(34); await settle() },
  }
}

test("events from any protocol version up to 1.2 are parsed", () => {
  for (const version of ["1.0", "1.1", "1.2"])
    assert.equal(parseProtocolEvent(JSON.stringify(envelope("session.catchup_required", { sessionId: "a", reason: "device_reconnected" }, 10, version)))?.type, "session.catchup_required")
  assert.equal(parseProtocolEvent(JSON.stringify(envelope("timeline.item_created", {}, 10, "9.9"))), null)
})

test("an offline recovery keeps cached history and the cursor, then a catch-up reads the gap", async t => {
  let online = false
  const f = await fixture(t, {
    events: (cursor) => online
      ? { events: [envelope("timeline.item_created", { item: message(11) }, 11)], nextCursor: "seq:11", snapshotRequired: false, deviceOffline: false }
      : { events: [], nextCursor: cursor, snapshotRequired: false, deviceOffline: true },
  })
  await f.subscribe()
  let current = f.controller.getSnapshot()
  assert.equal(current.recovered, true)
  assert.equal(sessionHistoryUnavailable(current.state), true)
  assert.deepEqual(current.state.items.map(item => item.id), ["m9", "m10"])
  assert.equal(current.state.eventCursor, "seq:10")
  assert.equal(current.state.hasMore, true)

  online = true
  f.sockets[0].receive("session.catchup_required", { sessionId: "a", reason: "device_reconnected" }, 0, "1.2")
  await settle(); await f.flush()
  current = f.controller.getSnapshot()
  assert.deepEqual(f.recoveries, ["seq:10", "seq:10"])
  assert.equal(sessionHistoryUnavailable(current.state), false)
  assert.deepEqual(current.state.items.map(item => item.id), ["m9", "m10", "m11"])
  assert.equal(current.state.eventCursor, "seq:11")
  assert.equal(f.snapshots.length, 0)
})

test("a live item while history is unavailable recovers the gap before it instead of skipping it", async t => {
  let online = false
  const f = await fixture(t, {
    events: (cursor) => online
      ? { events: [envelope("timeline.item_created", { item: message(11) }, 11)], nextCursor: "seq:11", snapshotRequired: false }
      : { events: [], nextCursor: cursor, snapshotRequired: false, deviceOffline: true },
  })
  await f.subscribe()
  online = true
  f.sockets[0].receive("timeline.item_created", { item: message(12) }, 12)
  await settle(); await f.flush()
  const current = f.controller.getSnapshot()
  assert.deepEqual(f.recoveries, ["seq:10", "seq:10"])
  assert.deepEqual(current.state.items.map(item => item.id), ["m9", "m10", "m11", "m12"])
  assert.equal(current.state.eventCursor, "seq:12")
})

test("a catch-up during an in-flight recovery reads again after it", async t => {
  const first = deferred()
  const answers = [() => first.promise, async () => ({ events: [envelope("timeline.item_created", { item: message(11) }, 11)], nextCursor: "seq:11", snapshotRequired: false })]
  const f = await fixture(t, { events: () => answers.shift()() })
  await f.subscribe()
  f.sockets[0].receive("session.catchup_required", { sessionId: "a", reason: "device_reconnected" }, 0, "1.2")
  first.resolve({ events: [], nextCursor: "seq:10", snapshotRequired: false, deviceOffline: true })
  await settle(); await f.flush()
  const current = f.controller.getSnapshot()
  assert.equal(f.recoveries.length, 2)
  assert.equal(sessionHistoryUnavailable(current.state), false)
  assert.equal(current.state.items.at(-1).id, "m11")
})

test("an offline snapshot after a reset keeps the retained content", async t => {
  const f = await fixture(t, {
    events: () => ({ events: [], nextCursor: "seq:10", snapshotRequired: true }),
  })
  await f.subscribe()
  const current = f.controller.getSnapshot()
  assert.equal(f.snapshots.length, 1)
  assert.equal(current.hasSnapshot, true)
  assert.equal(current.state.session.connectorStatus, "offline")
  assert.equal(sessionHistoryUnavailable(current.state), true)
  assert.deepEqual(current.state.items.map(item => item.id), ["m9", "m10"])
  assert.equal(current.state.eventCursor, "seq:10")
})

test("an offline first load is not an authoritative base; coming online reads a real snapshot", async t => {
  let online = false
  const onlineSnapshot = { ...offlineSnapshot, session: { ...session, updatedSeq: 12 }, timeline: { items: [message(10)], nextSeq: 10, hasMore: false }, eventCursor: "seq:10", historySource: "live", deviceOffline: false }
  const f = await fixture(t, {
    initialState: null, hasSnapshot: false,
    snapshot: () => online ? onlineSnapshot : offlineSnapshot,
    events: (cursor) => online
      ? { events: [], nextCursor: "seq:10", snapshotRequired: false }
      : { events: [], nextCursor: cursor, snapshotRequired: false, deviceOffline: true },
  })
  await f.subscribe()
  let current = f.controller.getSnapshot()
  assert.equal(current.initialLoadComplete, true)
  assert.equal(current.hasSnapshot, false)
  assert.equal(sessionHistoryUnavailable(current.state), true)
  assert.deepEqual(current.state.items, [])
  assert.equal(current.state.eventCursor, "seq:0")

  online = true
  f.sockets[0].receive("session.meta.updated", { session: { ...session, updatedSeq: 12 } }, 0)
  await f.flush(); await settle(); await f.flush()
  current = f.controller.getSnapshot()
  assert.equal(f.snapshots.length, 2)
  assert.equal(current.hasSnapshot, true)
  assert.equal(sessionHistoryUnavailable(current.state), false)
  assert.deepEqual(current.state.items.map(item => item.id), ["m10"])
})
