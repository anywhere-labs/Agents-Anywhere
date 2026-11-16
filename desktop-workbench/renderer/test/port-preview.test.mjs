import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const ports = await import("../src/features/preview/session-ports.ts")
const { apiPath } = await import("../src/lib/api/client.ts")
const { PreviewApi } = await import("../src/features/preview/api.ts")
const { createSessionController } = await import("../src/components/session/session-controller.ts")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")

const listening = (...list) => ({ deviceId: "connector", ports: list })
const port = (number, sessionId = "a", extra = {}) => ({ port: number, pid: 100 + number, processName: "node", sessionId, ...extra })

test("a port report keeps only this session's ports and is stable when nothing changed", () => {
  const empty = new Map()
  const first = ports.applySessionPortEvent(empty, "port.listening", listening(port(5173), port(8080, "other"), port(3000, null)), "a")
  assert.deepEqual([...first.keys()], [5173])
  assert.equal(ports.applySessionPortEvent(first, "port.listening", listening(port(5173)), "a"), first)
  const changed = ports.applySessionPortEvent(first, "port.listening", listening(port(5173, "a", { url: "http://localhost:5173/app" })), "a")
  assert.notEqual(changed, first)
  assert.equal(ports.localPortUrl(changed.get(5173)), "http://localhost:5173/app")
  assert.equal(ports.localPortUrl(port(3000)), "http://localhost:3000")
  const closed = ports.applySessionPortEvent(changed, "port.closed", { deviceId: "connector", port: 5173 }, "a")
  assert.equal(closed.size, 0)
  assert.equal(ports.applySessionPortEvent(closed, "port.closed", { deviceId: "connector", port: 5173 }, "a"), closed)
  assert.equal(ports.applySessionPortEvent(empty, "port.listening", { deviceId: "connector" }, "a"), empty)
})

test("versioned API paths are not prefixed with the v2 namespace", () => {
  assert.equal(apiPath("/api/v3/previews"), "/api/v3/previews")
  assert.equal(apiPath("/api/v3"), "/api/v3")
  assert.equal(apiPath("/sessions/list"), "/api/v2/sessions/list")
  assert.equal(apiPath("/api/v2/sessions"), "/api/v2/sessions")
})

test("the preview API talks to /api/v3/previews", async () => {
  const calls = []
  const client = {
    get: async (path, options) => { calls.push(["GET", path, undefined, options.token]); return { previews: [] } },
    post: async (path, body, options) => { calls.push(["POST", path, body, options.token]); return {} },
    delete: async (path, options) => { calls.push(["DELETE", path, undefined, options.token]); return undefined },
  }
  const api = new PreviewApi(client)
  await api.list("t")
  await api.create("t", { deviceId: "connector", port: 5173, sessionId: "a", visibility: "private" })
  await api.ticket("t", "prv/1")
  await api.close("t", "prv/1")
  assert.deepEqual(calls, [
    ["GET", "/api/v3/previews", undefined, "t"],
    ["POST", "/api/v3/previews", { deviceId: "connector", port: 5173, sessionId: "a", visibility: "private" }, "t"],
    ["POST", "/api/v3/previews/prv%2F1/ticket", undefined, "t"],
    ["DELETE", "/api/v3/previews/prv%2F1", undefined, "t"],
  ])
})

test("the session controller tracks port events and forgets them when the device goes offline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "info", () => {})
  const previousSocket = globalThis.WebSocket
  const sockets = []
  globalThis.WebSocket = class {
    constructor() { sockets.push(this) }
    close() { if (this.closed) return; this.closed = true; this.onclose?.() }
    receive(type, payload, sequence) { this.onmessage?.({ data: JSON.stringify({ protocolVersion: "1.2", sessionId: "a", type, payload, sequence, cursor: `seq:${sequence}`, eventId: `${type}:${sequence}`, emittedAt: "now" }) }) }
  }
  const session = { id: "a", connectorId: "connector", connectorStatus: "online", runtime: "codex", status: "idle", updatedSeq: 10 }
  const runtimeState = { sessionId: "a", runtime: "codex", status: "idle", updatedSeq: 10 }
  t.mock.method(dashboardApi, "createWsTicket", async () => ({ ticket: "ticket" }))
  t.mock.method(dashboardApi, "getSessionEvents", async (_t, _id, cursor) => ({ events: [], nextCursor: cursor, snapshotRequired: false }))
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: runtimeState, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [] }, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [], serverTime: "now" }))
  const controller = createSessionController({
    token: "token", sessionId: "a", hasSnapshot: true,
    initialState: { session, state: runtimeState, items: [], notices: [], nextSeq: 10, hasMore: false, timelineResetVersion: 0, serverTime: "now", eventCursor: "seq:10", effectiveCapabilities: null, catalogs: {} },
    applyOptimisticItems: state => state, clearResolvedOptimisticMessages() {}, onInvalidated() {},
  })
  t.after(() => { controller.dispose(); globalThis.WebSocket = previousSocket })
  controller.start()
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  await settle()
  sockets.at(-1).receive("session.subscribed", {}, 10)
  await settle()

  sockets.at(-1).receive("port.listening", listening(port(5173), port(9000, "b")), 10)
  await settle()
  assert.deepEqual([...controller.getSnapshot().listeningPorts.keys()], [5173])
  sockets.at(-1).receive("port.closed", { deviceId: "connector", port: 5173 }, 10)
  await settle()
  assert.equal(controller.getSnapshot().listeningPorts.size, 0)

  sockets.at(-1).receive("port.listening", listening(port(5173)), 10)
  await settle()
  assert.equal(controller.getSnapshot().listeningPorts.size, 1)
  controller.updateState(current => ({ ...current, session: { ...session, connectorStatus: "offline", updatedSeq: 11 } }))
  await settle()
  assert.equal(controller.getSnapshot().listeningPorts.size, 0)
})
