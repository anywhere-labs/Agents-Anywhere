import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { runtimeFailureOf } = await import("../src/lib/runtime-error-text.ts")
const { ApiError } = await import("../src/lib/api/errors.ts")
const { createSessionController } = await import("../src/components/session/session-controller.ts")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
const contract = read("../../contracts/runtime-errors/1.1/messages.json").messages

test("every runtime-errors 1.1 code has text in both UI languages, matching the contract", () => {
  for (const [lang, file] of [["zh-CN", "../messages/zh-CN.json"], ["en", "../messages/en.json"]]) {
    const messages = read(file).runtimeErrors
    for (const [code, text] of Object.entries(contract)) assert.equal(messages[code], text[lang], `${lang} ${code}`)
  }
})

test("an API failure keeps its stable code for translation", () => {
  const failure = runtimeFailureOf(new ApiError({ status: 409, detail: "device offline", kind: "http", code: "connector_offline" }))
  assert.deepEqual(failure, { code: "connector_offline", message: "device offline" })
})

test("catchUp reads the gap from the session's own cursor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "info", () => {})
  const previousSocket = globalThis.WebSocket
  const sockets = []
  globalThis.WebSocket = class {
    constructor() { sockets.push(this) }
    close() { if (this.closed) return; this.closed = true; this.onclose?.() }
    receive(type) { this.onmessage?.({ data: JSON.stringify({ protocolVersion: "1.2", sessionId: "a", type, payload: {}, sequence: 10, cursor: "seq:10", eventId: type, emittedAt: "now" }) }) }
  }
  const session = { id: "a", connectorId: "c", connectorStatus: "online", runtime: "codex", status: "idle", updatedSeq: 10 }
  const runtimeState = { sessionId: "a", runtime: "codex", status: "idle", updatedSeq: 10 }
  const recoveries = []
  t.mock.method(dashboardApi, "createWsTicket", async () => ({ ticket: "ticket" }))
  t.mock.method(dashboardApi, "getSessionEvents", async (_t, _id, cursor) => { recoveries.push(cursor); return { events: [], nextCursor: cursor, snapshotRequired: false } })
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: runtimeState, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: { capabilities: [] }, serverTime: "now" }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [], serverTime: "now" }))
  const controller = createSessionController({
    token: "token", sessionId: "a", hasSnapshot: true,
    initialState: { session, state: runtimeState, items: [], notices: [], nextSeq: 12, hasMore: false, timelineResetVersion: 0, serverTime: "now", eventCursor: "seq:12", effectiveCapabilities: null, catalogs: {} },
    applyOptimisticItems: state => state, clearResolvedOptimisticMessages() {}, onInvalidated() {},
  })
  t.after(() => { controller.dispose(); globalThis.WebSocket = previousSocket })
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  controller.start()
  await settle()
  sockets.at(-1).receive("session.subscribed")
  await settle()
  const before = recoveries.length
  controller.catchUp()
  await settle()
  assert.equal(recoveries.length, before + 1)
  assert.equal(recoveries.at(-1), "seq:12")
})
