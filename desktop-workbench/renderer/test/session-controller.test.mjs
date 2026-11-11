import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

const hooks = registerSource()
const { createSessionController } = await import("../src/components/session/session-controller.ts")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
const { ApiError } = await import("../src/lib/api/errors.ts")
const session = { id: "a", connectorId: "connector", connectorStatus: "online", runtime: "codex", status: "idle", updatedSeq: 10 }
const runtimeState = (seq, status = "idle") => ({ sessionId: "a", runtime: "codex", status, updatedSeq: seq })
const notice = (title, seq = 10) => ({ noticeId: "n", type: "notification", title, status: "open", updatedSeq: seq })
const envelope = (type, payload = {}, sequence = 10) => ({ protocolVersion: "1.0", sessionId: "a", type, payload, sequence, cursor: `seq:${sequence}`, eventId: `${type}:${sequence}`, emittedAt: "now" })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "info", () => {})
  const previousSocket = globalThis.WebSocket
  const sockets = []
  globalThis.WebSocket = class {
    constructor() { sockets.push(this) }
    close() { if (this.closed) return; this.closed = true; this.onclose?.() }
    receive(type, payload, sequence) { this.onmessage?.({ data: JSON.stringify(envelope(type, payload, sequence)) }) }
  }
  const recoveries = [], snapshots = []
  t.mock.method(dashboardApi, "createWsTicket", async () => ({ ticket: "ticket" }))
  t.mock.method(dashboardApi, "getSessionEvents", async (_token, _id, cursor) => {
    recoveries.push(cursor)
    return { events: [envelope("session.meta.updated", { session })], nextCursor: "seq:10", snapshotRequired: false }
  })
  t.mock.method(dashboardApi, "getSessionSnapshot", async () => {
    snapshots.push(1)
    if (options.snapshot) return options.snapshot
    throw new Error("unexpected snapshot")
  })
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: runtimeState(10), serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [] }, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [], serverTime: "now" }))
  let invalidations = 0
  const controller = createSessionController({
    token: "token", sessionId: "a", hasSnapshot: true,
    initialState: { session, state: runtimeState(10), items: [], notices: [notice("cached")], nextSeq: 10, hasMore: false, timelineResetVersion: 0, serverTime: "now", eventCursor: "seq:10", effectiveCapabilities: null, catalogs: {} },
    applyOptimisticItems: state => state, clearResolvedOptimisticMessages() {}, onInvalidated() { invalidations++ },
    ...options.controller,
  })
  t.after(() => { controller.dispose(); globalThis.WebSocket = previousSocket })
  controller.start()
  await settle()
  return {
    controller, sockets, recoveries, snapshots, get invalidations() { return invalidations },
    async subscribe() { sockets.at(-1).receive("session.subscribed"); await settle() },
    async flush() { t.mock.timers.tick(34); await settle() },
    async reconnect() { sockets.at(-1).close(); t.mock.timers.tick(1200); await settle(); sockets.at(-1).receive("session.subscribed"); await settle() },
  }
}

test("reconnect discards late results from every previous runtime read", async t => {
  const f = await fixture(t)
  const oldState = deferred(), oldCapabilities = deferred(), oldNotices = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeState", () => oldState.promise)
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", () => oldCapabilities.promise)
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => oldNotices.promise)
  await f.subscribe()
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: runtimeState(20), serverTime: "fresh" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [{ id: "fresh" }] }, serverTime: "fresh" }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [notice("fresh")], serverTime: "fresh" }))
  await f.reconnect()
  oldState.resolve({ state: runtimeState(100, "running") })
  oldCapabilities.resolve({ capabilitySet: { capabilities: [{ id: "stale" }] } })
  oldNotices.resolve({ notices: [notice("stale")] })
  await settle(); await f.flush()
  const current = f.controller.getSnapshot()
  assert.equal(current.state.state.status, "idle")
  assert.equal(current.state.state.updatedSeq, 20)
  assert.equal(current.state.effectiveCapabilities.capabilities[0].id, "fresh")
  assert.equal(current.state.notices[0].title, "fresh")
  assert.equal(current.recoveryGeneration, 1)
})

test("failed notice reads retain cached notices and replay events across their read boundary", async t => {
  const f = await fixture(t)
  const recovery = deferred(), read = deferred()
  t.mock.method(dashboardApi, "getSessionEvents", () => recovery.promise)
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => read.promise)
  await f.subscribe()
  f.sockets[0].receive("runtime.notice.updated", { notice: notice("before", 11) }, 11)
  recovery.resolve({ events: [], nextCursor: "seq:10", snapshotRequired: false })
  await settle()
  f.sockets[0].receive("runtime.notice.updated", { notice: notice("during", 12) }, 12)
  read.reject(new Error("notice read unavailable"))
  await settle(); await f.flush()
  assert.equal(f.controller.getSnapshot().state.notices[0].title, "during")
  assert.equal(f.controller.getSnapshot().error, "notice read unavailable")
  assert.equal(f.snapshots.length, 0, "a runtime read failure must not trigger a blocking snapshot")
})

test("live state cannot replace a newer state observation buffered before its read", async t => {
  const f = await fixture(t)
  const recovery = deferred()
  t.mock.method(dashboardApi, "getSessionEvents", () => recovery.promise)
  await f.subscribe()
  f.sockets[0].receive("runtime.state.updated", { state: runtimeState(30, "running") }, 10)
  recovery.resolve({ events: [], nextCursor: "seq:10", snapshotRequired: false })
  await settle(); await f.flush()
  assert.equal(f.controller.getSnapshot().state.state.updatedSeq, 30)
  assert.equal(f.controller.getSnapshot().state.state.status, "running")
})

test("duplicate subscription acknowledgements share one recovery", async t => {
  const f = await fixture(t)
  await f.subscribe(); await f.subscribe()
  assert.equal(f.recoveries.length, 1)
  assert.equal(f.controller.getSnapshot().recoveryGeneration, 0)
  await f.reconnect(); await f.subscribe()
  assert.equal(f.recoveries.length, 2)
  assert.equal(f.controller.getSnapshot().recoveryGeneration, 1)
  await f.reconnect()
  assert.equal(f.controller.getSnapshot().recoveryGeneration, 2)
})

test("a connection lost before its first recovery still invalidates catalogs after reconnecting", async t => {
  const f = await fixture(t)
  await f.reconnect(); await f.subscribe()
  assert.equal(f.recoveries.length, 1)
  assert.equal(f.controller.getSnapshot().recoveryGeneration, 1)
})

test("finishing recovery drains timeline events received in flight", async t => {
  const f = await fixture(t)
  const recovery = deferred()
  t.mock.method(dashboardApi, "getSessionEvents", () => recovery.promise)
  await f.subscribe()
  const item = { id: "message", sessionId: "a", type: "message", role: "assistant", status: "done", source: {}, orderSeq: 11, updatedSeq: 11, revision: 1, content: { text: "received during recovery" } }
  f.sockets[0].receive("timeline.item_created", { item }, 11)
  assert.equal(f.controller.getSnapshot().state.items.length, 0)
  recovery.resolve({ events: [], nextCursor: "seq:10", snapshotRequired: false })
  await settle()
  assert.equal(f.controller.getSnapshot().recovered, true)
  assert.equal(f.controller.getSnapshot().state.items[0].content.text, item.content.text)
  assert.equal(f.controller.getSnapshot().state.eventCursor, "seq:11")
})

for (const fails of [false, true]) test(`capability reads ${fails ? "retain pre-read events on failure" : "supersede pre-read events"} and replay events received during the read`, async t => {
  const f = await fixture(t)
  const recovery = deferred(), read = deferred()
  const capabilities = id => ({ capabilities: [{ capabilityId: id }] })
  t.mock.method(dashboardApi, "getSessionEvents", () => recovery.promise)
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", () => read.promise)
  await f.subscribe()
  f.sockets[0].receive("runtime.capability.updated", { capabilitySet: capabilities("before") })
  recovery.resolve({ events: [envelope("session.meta.updated", { session })], nextCursor: "seq:10", snapshotRequired: false })
  await settle()
  if (fails) read.reject(new Error("capabilities unavailable"))
  else read.resolve({ capabilitySet: capabilities("read") })
  await settle(); await f.flush()
  assert.equal(f.controller.getSnapshot().state.effectiveCapabilities.capabilities[0].capabilityId, fails ? "before" : "read")

  const nextRead = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", () => nextRead.promise)
  await f.reconnect()
  f.sockets.at(-1).receive("runtime.capability.updated", { capabilitySet: capabilities("during") })
  if (fails) nextRead.reject(new Error("capabilities unavailable"))
  else nextRead.resolve({ capabilitySet: capabilities("read") })
  await settle(); await f.flush()
  assert.equal(f.controller.getSnapshot().state.effectiveCapabilities.capabilities[0].capabilityId, "during")
})

test("runtime projections cannot move the durable cursor past unconsumed timeline events", async t => {
  const f = await fixture(t)
  await f.subscribe()
  f.sockets[0].receive("runtime.state.updated", { state: runtimeState(50, "running") }, 50)
  await f.flush()
  assert.equal(f.controller.getSnapshot().state.eventCursor, "seq:10")
  const item = { id: "message", sessionId: "a", type: "message", role: "assistant", status: "done", content: { text: "retained" }, source: {}, orderSeq: 11, updatedSeq: 11, revision: 1 }
  f.sockets[0].receive("timeline.item_updated", { item }, 11)
  await f.flush()
  assert.equal(f.controller.getSnapshot().state.items[0].content.text, "retained")
  assert.equal(f.controller.getSnapshot().state.eventCursor, "seq:11")
  assert.equal(f.controller.getSnapshot().state.state.updatedSeq, 50)
})

test("revoked recovery access closes the socket without a snapshot fallback or reconnect", async t => {
  const f = await fixture(t)
  t.mock.method(dashboardApi, "getSessionEvents", async () => { throw new ApiError({ status: 403, kind: "forbidden", detail: "revoked" }) })
  await f.subscribe()
  assert.equal(f.controller.getSnapshot().state, null)
  assert.equal(f.controller.getSnapshot().invalidated, true)
  assert.equal(f.invalidations, 1)
  assert.equal(f.sockets[0].closed, true)
  t.mock.timers.tick(30_000); await settle()
  assert.equal(f.sockets.length, 1)
  assert.equal(f.snapshots.length, 0)
})

const catalogCapabilities = { capabilities: ["catalog.model", "catalog.permission"].map(capabilityId => ({ capabilityId, supported: true, available: true, allowed: true })) }
const modelCatalog = id => ({ runtime: "codex", models: [{ id }] })
const permissionCatalog = id => ({ runtime: "codex", permissions: [{ id }] })

function enableCatalogs(t, f) {
  f.controller.updateState(current => ({ ...current, effectiveCapabilities: catalogCapabilities, catalogs: { model: modelCatalog("cached"), permission: permissionCatalog("cached") } }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: catalogCapabilities, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionModelCatalog", async () => ({ catalog: modelCatalog("read"), serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionPermissionCatalog", async () => ({ catalog: permissionCatalog("read"), serverTime: "now" }))
}

for (const type of ["model", "permission"]) for (const fails of [false, true]) test(`${type} catalog ${fails ? "failure" : "success"} preserves events received during its read without blocking other domains`, async t => {
  const f = await fixture(t)
  enableCatalogs(t, f)
  const read = deferred()
  const catalog = type === "model" ? modelCatalog : permissionCatalog
  t.mock.method(dashboardApi, type === "model" ? "getSessionModelCatalog" : "getSessionPermissionCatalog", () => read.promise)
  await f.subscribe()
  const other = type === "model" ? "permission" : "model"
  assert.equal(f.controller.getSnapshot().state.catalogs[other][other === "model" ? "models" : "permissions"][0].id, "read")
  f.sockets[0].receive("runtime.catalog.updated", { catalogType: type, catalog: catalog("during") }, 10)
  const item = { id: "message", sessionId: "a", type: "message", role: "assistant", status: "done", content: { text: "unblocked" }, source: {}, orderSeq: 20, updatedSeq: 20, revision: 1 }
  f.sockets[0].receive("timeline.item_updated", { item }, 20)
  await f.flush()
  assert.equal(f.controller.getSnapshot().state.items[0].content.text, "unblocked")
  assert.equal(f.controller.getSnapshot().state.catalogs[type][type === "model" ? "models" : "permissions"][0].id, "cached")
  if (fails) read.reject(new Error("catalog unavailable"))
  else read.resolve({ catalog: catalog("read"), serverTime: "now" })
  await settle(); await f.flush()
  assert.equal(f.controller.getSnapshot().state.catalogs[type][type === "model" ? "models" : "permissions"][0].id, "during")
  assert.equal(f.controller.getSnapshot().state.eventCursor, "seq:20")
})

test("reconnect ignores both catalog responses from the previous connection", async t => {
  const f = await fixture(t)
  enableCatalogs(t, f)
  const model = deferred(), permission = deferred()
  t.mock.method(dashboardApi, "getSessionModelCatalog", () => model.promise)
  t.mock.method(dashboardApi, "getSessionPermissionCatalog", () => permission.promise)
  await f.subscribe()
  t.mock.method(dashboardApi, "getSessionModelCatalog", async () => ({ catalog: modelCatalog("fresh") }))
  t.mock.method(dashboardApi, "getSessionPermissionCatalog", async () => ({ catalog: permissionCatalog("fresh") }))
  await f.reconnect()
  model.resolve({ catalog: modelCatalog("obsolete") })
  permission.resolve({ catalog: permissionCatalog("obsolete") })
  await settle(); await f.flush()
  assert.equal(f.controller.getSnapshot().state.catalogs.model.models[0].id, "fresh")
  assert.equal(f.controller.getSnapshot().state.catalogs.permission.permissions[0].id, "fresh")
})

test("cold snapshots avoid duplicate catalog reads but capabilities can enable a missing catalog later", async t => {
  const catalogs = { model: modelCatalog("snapshot"), permission: permissionCatalog("snapshot") }
  const f = await fixture(t, {
    controller: { hasSnapshot: false, initialState: null },
    snapshot: { session, state: runtimeState(10), timeline: { items: [], nextSeq: 10, hasMore: false }, notices: [], eventCursor: "seq:10", effectiveCapabilities: catalogCapabilities, catalogs, serverTime: "now" },
  })
  const reads = []
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: catalogCapabilities }))
  t.mock.method(dashboardApi, "getSessionModelCatalog", async () => { reads.push("model"); return { catalog: modelCatalog("enabled") } })
  t.mock.method(dashboardApi, "getSessionPermissionCatalog", async () => { reads.push("permission"); return { catalog: permissionCatalog("enabled") } })
  await f.subscribe()
  assert.deepEqual(reads, [])
  f.controller.updateState(current => ({ ...current, effectiveCapabilities: { capabilities: [] }, catalogs: { permission: current.catalogs.permission } }))
  f.sockets[0].receive("runtime.capability.updated", { capabilitySet: catalogCapabilities })
  await f.flush(); await settle()
  assert.deepEqual(reads, ["model"])
  assert.equal(f.controller.getSnapshot().state.catalogs.model.models[0].id, "enabled")
})

test("offline recovery preserves notices and reads them when the Connector comes online on the same socket", async t => {
  const f = await fixture(t)
  const offline = { ...session, connectorStatus: "offline" }
  t.mock.method(dashboardApi, "getSessionEvents", async () => ({ events: [envelope("session.meta.updated", { session: offline })], nextCursor: "seq:10", snapshotRequired: false }))
  const reads = []
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => { reads.push(1); return { notices: [notice("fresh")] } })
  await f.subscribe()
  assert.deepEqual(reads, [])
  assert.equal(f.controller.getSnapshot().error, null)
  assert.equal(f.controller.getSnapshot().state.notices[0].title, "cached")
  f.sockets[0].receive("session.meta.updated", { session })
  await f.flush(); await settle()
  assert.deepEqual(reads, [1])
  assert.equal(f.controller.getSnapshot().state.notices[0].title, "fresh")
})

for (const domain of ["capabilities", "notices", "model", "permission"]) test(`a ${domain} read racing with Connector disconnect does not report a refresh error`, async t => {
  const f = await fixture(t)
  enableCatalogs(t, f)
  const method = { capabilities: "getSessionRuntimeCapabilities", notices: "getSessionRuntimeNotices", model: "getSessionModelCatalog", permission: "getSessionPermissionCatalog" }[domain]
  t.mock.method(dashboardApi, method, async () => { throw new ApiError({ status: 409, kind: "http", detail: "connector is offline" }) })
  await f.subscribe()
  assert.equal(f.controller.getSnapshot().error, null)
  if (domain === "notices") assert.equal(f.controller.getSnapshot().state.notices[0].title, "cached")
  else if (domain !== "capabilities") assert.equal(f.controller.getSnapshot().state.catalogs[domain][domain === "model" ? "models" : "permissions"][0].id, "cached")
})

test("offline presence cancels capability reads and clears their errors before retrying online", async t => {
  const f = await fixture(t)
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => { throw new Error("capabilities unavailable") })
  await f.subscribe()
  assert.equal(f.controller.getSnapshot().error, "capabilities unavailable")
  const offline = { ...session, connectorStatus: "offline" }
  f.sockets[0].receive("session.meta.updated", { session: offline })
  await f.flush()
  assert.equal(f.controller.getSnapshot().error, null)
  const read = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", () => read.promise)
  f.sockets[0].receive("session.meta.updated", { session })
  await f.flush()
  f.sockets[0].receive("session.meta.updated", { session: offline })
  await f.flush()
  read.reject(new ApiError({ status: 409, kind: "http", detail: "connector is offline" }))
  await settle()
  assert.equal(f.controller.getSnapshot().error, null)
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [{ capabilityId: "fresh" }] } }))
  f.sockets[0].receive("session.meta.updated", { session })
  await f.flush()
  assert.equal(f.controller.getSnapshot().state.effectiveCapabilities.capabilities[0].capabilityId, "fresh")
})

for (const status of [403, 404]) test(`notice access denied with ${status} still invalidates the session`, async t => {
  const f = await fixture(t)
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => { throw new ApiError({ status, kind: "http", detail: "unavailable" }) })
  await f.subscribe()
  assert.equal(f.controller.getSnapshot().invalidated, true)
  assert.equal(f.invalidations, 1)
  assert.equal(f.controller.getSnapshot().state, null)
})

test("going offline cancels old notice reads and clears their errors before retrying online", async t => {
  const f = await fixture(t)
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => { throw new Error("notice unavailable") })
  await f.subscribe()
  assert.equal(f.controller.getSnapshot().error, "notice unavailable")
  const offline = { ...session, connectorStatus: "offline" }
  f.sockets[0].receive("session.meta.updated", { session: offline })
  await f.flush()
  assert.equal(f.controller.getSnapshot().error, null)
  const read = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => read.promise)
  f.sockets[0].receive("session.meta.updated", { session })
  await f.flush(); await settle()
  f.sockets[0].receive("session.meta.updated", { session: offline })
  await f.flush()
  read.resolve({ notices: [notice("obsolete")] })
  await settle()
  assert.equal(f.controller.getSnapshot().state.notices[0].title, "cached")
})

test("a queued offline presence event cancels a notice response before it can replace cached notices", async t => {
  const f = await fixture(t)
  const read = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => read.promise)
  await f.subscribe()
  f.sockets[0].receive("session.meta.updated", { session: { ...session, connectorStatus: "offline" } })
  read.resolve({ notices: [notice("obsolete")] })
  await settle()
  assert.equal(f.controller.getSnapshot().state.session.connectorStatus, "offline")
  assert.equal(f.controller.getSnapshot().state.notices[0].title, "cached")
})

test("a failed catalog read retains its cached domain while the other catalog refreshes", async t => {
  const f = await fixture(t)
  enableCatalogs(t, f)
  t.mock.method(dashboardApi, "getSessionModelCatalog", async () => { throw new Error("model catalog unavailable") })
  await f.subscribe()
  assert.equal(f.controller.getSnapshot().state.catalogs.model.models[0].id, "cached")
  assert.equal(f.controller.getSnapshot().state.catalogs.permission.permissions[0].id, "read")
  assert.equal(f.controller.getSnapshot().error, "model catalog unavailable")
  assert.equal(f.controller.getSnapshot().recovered, true)
})

test.after(() => hooks.deregister())
