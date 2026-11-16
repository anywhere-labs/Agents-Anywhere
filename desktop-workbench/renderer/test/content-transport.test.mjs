import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const transport = await import("../src/lib/transport/content-transport.ts")
const { ApiClient } = await import("../src/lib/api/client.ts")
const { ApiError } = await import("../src/lib/api/errors.ts")
const { createSessionController } = await import("../src/components/session/session-controller.ts")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")

test("only per-session paths are session content", () => {
  assert.equal(transport.sessionIdOfContentPath("/api/v2/sessions/sess_a/snapshot"), "sess_a")
  assert.equal(transport.sessionIdOfContentPath("/api/v2/sessions/sess%2Fb/events?after=seq:1"), "sess/b")
  assert.equal(transport.sessionIdOfContentPath("/api/v2/sessions/sess_a"), "sess_a")
  for (const path of ["/api/v2/sessions/list", "/api/v2/sessions/read", "/api/v2/sessions/create-and-start", "/api/v2/connectors", "/api/v2/sessions"])
    assert.equal(transport.sessionIdOfContentPath(path), null, path)
})

test("content requests use an installed encrypted transport; account requests stay on HTTPS", async (t) => {
  const fetched = [], tunneled = []
  const client = new ApiClient({ fetcher: async (url) => { fetched.push(String(url)); return new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } }) } })
  const restore = transport.setContentTransportResolver(({ sessionId, method, path }) => sessionId === "enc"
    ? { kind: "tunnel", async request(request) { tunneled.push({ ...request, method, path }); return { via: "tunnel" } }, openSessionStream() { throw new Error("unused") } }
    : null)
  t.after(restore)
  assert.deepEqual(await client.get("/sessions/enc/events", { token: "t", query: { after: "seq:3", skip: null } }), { via: "tunnel" })
  assert.deepEqual(tunneled, [{ method: "GET", path: "/api/v2/sessions/enc/events", query: { after: "seq:3" }, body: undefined }])
  await client.post("/sessions/enc/messages", { text: "hi" }, { token: "t" })
  assert.deepEqual(tunneled[1].body, { text: "hi" })
  await client.get("/sessions/plain/snapshot", { token: "t" })
  await client.get("/sessions/list", { token: "t" })
  assert.deepEqual(fetched, ["/api/v2/sessions/plain/snapshot", "/api/v2/sessions/list"])
  restore()
  await client.get("/sessions/enc/events", { token: "t" })
  assert.equal(fetched.at(-1), "/api/v2/sessions/enc/events")
})

test("an encryption-required answer is reported to the trust layer and still thrown", async (t) => {
  const client = new ApiClient({ fetcher: async () => new Response(JSON.stringify({ detail: { code: "e2ee_required", message: "encrypted" } }), { status: 403, headers: { "content-type": "application/json" } }) })
  const reports = []
  t.after(transport.onContentTransportRequired(detail => reports.push(detail)))
  await assert.rejects(client.get("/sessions/s1/snapshot"), error => error instanceof ApiError && error.code === "e2ee_required")
  assert.deepEqual(reports, [{ sessionId: "s1", code: "e2ee_required" }])
})

test("the session controller subscribes through the encrypted transport without a WebSocket ticket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "info", () => {})
  const tickets = []
  t.mock.method(dashboardApi, "createWsTicket", async () => { tickets.push(1); return { ticket: "x" } })
  t.mock.method(dashboardApi, "getSessionEvents", async () => ({ events: [], nextCursor: "seq:10", snapshotRequired: false }))
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: null, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [] } }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [] }))
  const streams = []
  t.after(transport.setContentTransportResolver(() => ({
    kind: "tunnel",
    async request() { throw new Error("unused") },
    openSessionStream(sessionId) {
      const stream = { sessionId, onmessage: null, onclose: null, onerror: null, close() { this.closed = true } }
      streams.push(stream)
      return stream
    },
  })))
  const session = { id: "a", connectorId: "c", connectorStatus: "online", runtime: "codex", status: "idle", updatedSeq: 10 }
  const controller = createSessionController({
    token: "t", sessionId: "a", hasSnapshot: true,
    initialState: { session, state: null, items: [], notices: [], nextSeq: 10, hasMore: false, timelineResetVersion: 0, serverTime: "now", eventCursor: "seq:10", effectiveCapabilities: null, catalogs: {} },
    applyOptimisticItems: state => state, clearResolvedOptimisticMessages() {}, onInvalidated() {},
  })
  t.after(() => controller.dispose())
  controller.start()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(streams.length, 1)
  assert.equal(tickets.length, 0)
  streams[0].onmessage({ data: JSON.stringify({ protocolVersion: "1.2", sessionId: "a", type: "session.subscribed", payload: {}, sequence: 10, cursor: "seq:10", eventId: "sub", emittedAt: "now" }) })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(controller.getSnapshot().subscribed, true)
  assert.equal(controller.getSnapshot().recovered, true)
  controller.dispose()
  assert.equal(streams[0].closed, true)
})
