import assert from "node:assert/strict"
import test from "node:test"
import { registerHooks } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { JSDOM } from "jsdom"
import { registerSource } from "./helpers/onboarding-source.mjs"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example.test", pretendToBeVisual: true })
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
}
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)) }
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 })
Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 3000 })
globalThis.qaTranslate = Object.assign(key => key, { raw: () => [] })
globalThis.qaPlanning = { state: null, documents: [], busy: false, ingest() {} }
globalThis.qaGoals = { state: null, busy: false, ingest() {} }

const sourceHooks = registerSource()
const passthrough = names => `import * as React from 'react'; ${names.map(name => `export const ${name}=({children})=>React.createElement('div',null,children);`).join("\n")}`
const stubs = {
  "components/workspace-context.tsx": "export const useWorkspace=()=>globalThis.qaWorkspace",
  "lib/runtime-error-text.ts": "export const useRuntimeErrorText=()=>()=>''",
  "features/planning/use-session-planning.ts": "export const useSessionPlanning=()=>globalThis.qaPlanning",
  "features/goals/use-session-goal.ts": "export const useSessionGoal=()=>globalThis.qaGoals",
  "components/session/planning-panel.tsx": "export const usePlanReader=()=>({document:null,open(){}}); export const getPlanReviewTarget=()=>null; export const PlanningPanel=()=>null; export const PlanningReviewPanel=()=>null; export const PlanningReader=()=>null; export const PlanTimelineEntry=()=>null",
  "components/session/goal-panel.tsx": "export const GoalPanel=()=>null",
  "components/session/native-session-handoff.tsx": "export const NativeSessionHandoff=()=>null",
  "components/session/agent-recovery-notice.tsx": "export const AgentRecoveryNotice=()=>null",
  "components/session/runtime-creation-status.tsx": "export const RuntimeCreationStatus=()=>null",
  "components/session/session-review-card.tsx": "export const SessionReviewCard=()=>null",
  "components/session/session-review-tag.tsx": "export const SessionReviewTag=()=>null",
  "components/session/turn-actions.tsx": "export const TurnActions=()=>null",
  "components/session/session-tool-cards.tsx": "export const JsonBlock=()=>null; export const ToolMarkerRowContent=()=>null; export const timelineItemStatusIsActive=()=>false",
  "components/session/session-skeleton.tsx": "import * as React from 'react'; export const SessionSkeleton=()=>React.createElement('div',{'data-testid':'skeleton'}); export const SessionSkeletonInline=SessionSkeleton",
  "components/session/session-timeline-entry.tsx": "import * as React from 'react'; export const TimelineEntry=({item})=>React.createElement('p',{'data-item':item.id},item.content.text)",
  "components/session/session-composer.tsx": "import * as React from 'react'; export const SessionComposer=props=>{globalThis.qaComposer=props;return React.createElement('textarea',{value:props.value,onChange:e=>props.onValueChange(e.target.value)})}",
  "components/session/session-approval-card.tsx": "import * as React from 'react'; export const InteractionCard=props=>{globalThis.qaInteraction=props;return React.createElement('div',{'data-notice':props.notice.noticeId},props.notice.title)}; export const NotificationCard=InteractionCard",
  "components/session/use-runtime-commands.ts": "export const useRuntimeCommands=()=>({commands:[],loading:false,error:null})",
  "components/ui/scroll-area.tsx": "import * as React from 'react'; export const ScrollArea=({children,viewportRef,viewportProps})=>React.createElement('div',{...viewportProps,ref:viewportRef,'data-testid':'viewport'},children)",
  "components/ui/alert.tsx": passthrough(["Alert", "AlertTitle", "AlertDescription"]),
  "components/ui/badge.tsx": passthrough(["Badge"]),
  "components/ui/button.tsx": passthrough(["Button"]),
  "components/ui/dialog.tsx": "export const Dialog=()=>null;" + passthrough(["DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle"]),
  "components/ui/collapsible.tsx": passthrough(["Collapsible", "CollapsibleContent", "CollapsibleTrigger"]),
  "components/ui/marker.tsx": passthrough(["Marker", "MarkerContent", "MarkerIcon"]),
}
const mockHooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl") return { url: "data:text/javascript,export const useTranslations=()=>globalThis.qaTranslate", shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    const match = Object.keys(stubs).find(path => url.endsWith(`/src/${path}`))
    return match ? { format: "module", shortCircuit: true, source: stubs[match] } : next(url, context)
  },
})
const { createElement: h, act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { SessionDetail } = await import("../src/components/session-detail.tsx")
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
const { ApiError } = await import("../src/lib/api/errors.ts")
const { createSessionStateCache } = await import("../src/components/session/session-state-cache.ts")
const { createSessionControllerStore } = await import("../src/components/session/session-controller-store.ts")

const empty = []
const noop = () => {}
const session = id => ({ id, connectorId: "connector", connectorStatus: "online", runtime: "codex", runtimeId: "codex", title: id, cwd: "/repo", status: "idle", takeover: true, archived: false, updatedSeq: 10 })
const item = (id, text = id, seq = 10) => ({ id, sessionId: "a", type: "message", role: "assistant", status: "done", content: { text }, source: { runtime: "codex" }, orderSeq: seq, updatedSeq: seq, revision: 1, contentHash: text, createdAt: "2026-11-09T00:00:00Z" })
const snapshot = (id, items = [item(`${id}-message`)], hasMore = false) => ({ session: session(id), state: null, timeline: { items, nextSeq: 10, hasMore }, notices: [], eventCursor: "seq:10", serverTime: "now", effectiveCapabilities: null, catalogs: {} })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const event = (id, type, payload = {}, seq = 10) => ({ protocolVersion: "1.0", sessionId: id, type, payload, sequence: seq, cursor: `seq:${seq}`, eventId: `${type}:${seq}`, emittedAt: "now" })

async function fixture(t) {
  t.mock.method(console, "info", () => {})
  const sockets = []
  globalThis.WebSocket = class {
    constructor(url) { this.sessionId = decodeURIComponent(new URL(url).pathname.match(/\/sessions\/([^/]+)\/ws$/)[1]); sockets.push(this) }
    close() { this.closed = true }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const cache = createSessionStateCache("server:user")
  const controllers = createSessionControllerStore(cache)
  globalThis.qaWorkspace = {
    sessionControllers: controllers, sessionStateCache: cache, getOptimisticSessionState: () => null, getOptimisticItems: () => empty,
    isOptimisticSession: () => false, sessionCreations: {}, clearResolvedOptimisticMessages: noop,
    addOptimisticMessage: noop, markOptimisticMessageFailed: noop, consumeComposerInsertion: noop,
  }
  const snapshotCalls = [], recoveryCalls = [], noticeCalls = []
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => { snapshotCalls.push(id); return snapshot(id) })
  t.mock.method(dashboardApi, "createWsTicket", async () => ({ ticket: "ticket" }))
  t.mock.method(dashboardApi, "getSessionEvents", async (_token, id, cursor) => { recoveryCalls.push([id, cursor]); return { events: [], nextCursor: cursor, snapshotRequired: false } })
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => ({ state: null }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: null }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async (_token, id) => { noticeCalls.push(id); return { notices: [] } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = async (id, token = "token", onSessionUpdated) => act(async () => { root.render(h(SessionDetail, { token, sessionId: id, fallbackSession: null, onSessionUpdated })) })
  const socket = id => sockets.findLast(socket => socket.sessionId === id && !socket.closed)
  const subscribe = async id => act(async () => { socket(id).receive(event(id, "session.subscribed")) })
  const flush = async () => act(async () => { await delay(45) })
  t.after(async () => { await act(async () => { root.unmount(); controllers.dispose() }); host.remove() })
  return { cache, controllers, host, sockets, socket, render, subscribe, flush, snapshotCalls, recoveryCalls, noticeCalls }
}

for (const [domain, other] of [["Planning", "Goals"], ["Goals", "Planning"]]) test(`${domain} events are ingested without replaying cached ${other} state`, async t => {
  const f = await fixture(t)
  const types = { Planning: "planning.state.updated", Goals: "goal.state.updated" }
  const ingested = { Planning: [], Goals: [] }
  for (const name of [domain, other])
    t.mock.method(globalThis[`qa${name}`], "ingest", state => ingested[name].push(state))
  await f.render("a"); await f.subscribe("a")
  const previous = { sessionId: "a", epoch: "old", revision: 10 }
  const next = { sessionId: "a", epoch: "new", revision: 1 }
  await act(async () => f.socket("a").receive(event("a", types[other], { state: previous })))
  assert.deepEqual(ingested[other], [previous])
  await act(async () => f.socket("a").receive(event("a", types[domain], { state: next })))
  assert.deepEqual(ingested[domain], [next])
  assert.deepEqual(ingested[other], [previous], "an unrelated update must not replay a cached projection over HTTP-refreshed state")
  await act(async () => f.socket("a").receive(event("a", types[other], { state: next })))
  assert.deepEqual(ingested[other], [previous, next], "a new event in the same domain must still be ingested")
  assert.deepEqual(ingested[domain], [next])
})

test("A→B→A displays cached messages before recovery completes, without another snapshot", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b")
  const recovery = deferred()
  t.mock.method(dashboardApi, "getSessionEvents", () => recovery.promise)
  await f.render("a"); await f.subscribe("a")
  assert.ok(f.host.querySelector('[data-item="a-message"]'))
  assert.equal(f.host.querySelector('[data-testid="skeleton"]'), null)
  assert.deepEqual(f.snapshotCalls, ["a", "b"])
  await act(async () => recovery.resolve({ events: [], nextCursor: "seq:10", snapshotRequired: false }))
  assert.deepEqual(f.noticeCalls, ["a"], "returning must re-read runtime-owned notices")
})

test("restores a paused reading position and keeps older pages during delta recovery", async t => {
  const f = await fixture(t)
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => snapshot(id, [item(`${id}-old`, "old", 1), item(`${id}-message`)]))
  await f.render("a")
  const viewport = f.host.querySelector('[data-testid="viewport"]')
  await act(async () => { viewport.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -30 })); viewport.scrollTop = 420; viewport.dispatchEvent(new window.Event("scroll")) })
  await f.render("b"); await f.render("a")
  assert.equal(f.host.querySelector('[data-testid="viewport"]').scrollTop, 420)
  await f.subscribe("a"); await f.flush()
  assert.ok(f.host.querySelector('[data-item="a-old"]'))
  assert.equal(f.host.querySelector('[data-testid="viewport"]').scrollTop, 420)
  assert.deepEqual(f.recoveryCalls, [["a", "seq:10"]])
})

test("late snapshots cannot overwrite a different session or a later visit to A", async t => {
  const f = await fixture(t)
  const old = deferred()
  let aVisits = 0
  t.mock.method(dashboardApi, "getSessionSnapshot", (_token, id) => id === "a" && aVisits++ === 0 ? old.promise : Promise.resolve(snapshot(id)))
  await f.render("a"); await f.render("b"); await f.render("a")
  await act(async () => old.resolve(snapshot("a", [item("obsolete", "obsolete")])) )
  assert.ok(f.host.querySelector('[data-item="a-message"]'))
  assert.equal(f.host.querySelector('[data-item="obsolete"]'), null)
})

test("a late history page cannot write into another session", async t => {
  const f = await fixture(t)
  const older = deferred()
  t.mock.method(dashboardApi, "getSessionTimelineBefore", () => older.promise)
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => snapshot(id, [item(`${id}-message`)], true))
  await f.render("a")
  await act(async () => { const viewport = f.host.querySelector('[data-testid="viewport"]'); viewport.scrollTop = 0; viewport.dispatchEvent(new window.Event("scroll")) })
  await f.render("b")
  await act(async () => older.resolve({ items: [item("a-old")], nextSeq: 10, hasMore: false }))
  assert.ok(f.host.querySelector('[data-item="b-message"]'))
  assert.equal(f.host.querySelector('[data-item="a-old"]'), null)
})

test("snapshotRequired replaces stale cached history with the authoritative timeline", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  t.mock.method(dashboardApi, "getSessionEvents", async () => ({ events: [], nextCursor: "seq:12", snapshotRequired: true }))
  t.mock.method(dashboardApi, "getSessionSnapshot", async () => snapshot("a", [item("replacement")]))
  await f.subscribe("a")
  assert.ok(f.host.querySelector('[data-item="replacement"]'))
  assert.equal(f.host.querySelector('[data-item="a-message"]'), null)
})

test("missed runtime notices are restored, and events arriving during the read win afterwards", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  const notices = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => notices.promise)
  await f.subscribe("a")
  const notice = { noticeId: "approval", type: "notification", title: "fresh", status: "open", source: {}, context: {}, updatedSeq: 11 }
  await act(async () => f.socket("a").receive(event("a", "runtime.notice.updated", { notice }, 11)))
  await act(async () => notices.resolve({ notices: [] }))
  await f.flush()
  assert.equal(f.host.querySelector('[data-notice="approval"]').textContent, "fresh")
})

test("failed recovery retains cached messages; revoked access removes them and the cache", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  t.mock.method(dashboardApi, "getSessionEvents", async () => { throw new Error("unavailable") })
  t.mock.method(dashboardApi, "getSessionSnapshot", async () => { throw new Error("offline") })
  await f.subscribe("a")
  assert.ok(f.host.querySelector('[data-item="a-message"]'))
  t.mock.method(dashboardApi, "getSessionSnapshot", async () => { throw new ApiError({ status: 404, kind: "notFound", detail: "removed" }) })
  await act(async () => f.socket("a").receive(event("a", "session.refetch_required", {}, 12)))
  assert.equal(f.host.querySelector('[data-item="a-message"]'), null)
  assert.equal(f.cache.get("a"), null)
})

test("runtime reads reconcile notifications missed while away, including their removal", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  const notice = { noticeId: "missed", type: "notification", title: "missed notification", status: "open", source: {}, context: {}, updatedSeq: 0 }
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [notice] }))
  await f.subscribe("a")
  assert.ok(f.host.querySelector('[data-notice="missed"]'))
  await f.render("b"); await f.render("a")
  assert.ok(f.host.querySelector('[data-notice="missed"]'), "retain the last known fact while refreshing")
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [] }))
  await f.subscribe("a")
  assert.equal(f.host.querySelector('[data-notice="missed"]'), null)
})

test("revoked notice access invalidates the cache even when another runtime read also fails", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  t.mock.method(dashboardApi, "getSessionRuntimeState", async () => { throw new Error("offline") })
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => {
    throw new ApiError({ status: 403, kind: "forbidden", detail: "revoked" })
  })
  await f.subscribe("a")
  assert.equal(f.host.querySelector('[data-item="a-message"]'), null)
  assert.equal(f.cache.get("a"), null)
})

test("leaving flushes uncommitted stream revisions before saving the recovery cursor", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.subscribe("a")
  await act(async () => f.socket("a").receive(event("a", "timeline.item_updated", { item: item("a-message", "final", 11) }, 11)))
  await f.render("b"); await f.render("a")
  t.mock.method(dashboardApi, "getSessionEvents", async (_token, id, cursor) => {
    assert.equal(cursor, "seq:11", "leaving must save the pending revision together with its cursor")
    return { events: [event(id, "timeline.item_updated", { item: item("a-message", "final", 11) }, 11)], nextCursor: "seq:11", snapshotRequired: false }
  })
  await f.subscribe("a"); await f.flush()
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "final")
})

test("history pagination cannot advance the stream watermark past unrecovered changes", async t => {
  const f = await fixture(t)
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => snapshot(id, [item(`${id}-message`)], true))
  t.mock.method(dashboardApi, "getSessionTimelineBefore", async () => ({ items: [item("a-old", "old", 1)], nextSeq: 50, hasMore: false }))
  await f.render("a")
  await act(async () => { const viewport = f.host.querySelector('[data-testid="viewport"]'); viewport.scrollTop = 0; viewport.dispatchEvent(new window.Event("scroll")) })
  await f.render("b"); await f.render("a")
  t.mock.method(dashboardApi, "getSessionEvents", async (_token, id, cursor) => {
    assert.equal(cursor, "seq:10")
    return { events: [event(id, "timeline.item_updated", { item: item("a-message", "updated", 11) }, 11)], nextCursor: "seq:50", snapshotRequired: false }
  })
  await f.subscribe("a"); await f.flush()
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "updated")
  assert.ok(f.host.querySelector('[data-item="a-old"]'))
})

test("a history page started before an authoritative reset cannot restore deleted items", async t => {
  const f = await fixture(t)
  const older = deferred()
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => snapshot(id, [item(`${id}-message`)], true))
  t.mock.method(dashboardApi, "getSessionTimelineBefore", () => older.promise)
  await f.render("a"); await f.subscribe("a")
  await act(async () => { const viewport = f.host.querySelector('[data-testid="viewport"]'); viewport.scrollTop = 0; viewport.dispatchEvent(new window.Event("scroll")) })
  await act(async () => f.socket("a").receive(event("a", "timeline.snapshot", { items: [item("replacement", "replacement", 12)] }, 12)))
  await f.flush()
  await act(async () => older.resolve({ items: [item("deleted")], nextSeq: 12, hasMore: false }))
  assert.ok(f.host.querySelector('[data-item="replacement"]'))
  assert.equal(f.host.querySelector('[data-item="deleted"]'), null)
})

test("changing the account/server scope cannot display a previous account's cache", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  const pending = deferred()
  t.mock.method(dashboardApi, "getSessionSnapshot", () => pending.promise)
  const otherCache = createSessionStateCache("other-server:other-user")
  const otherControllers = createSessionControllerStore(otherCache)
  t.after(() => otherControllers.dispose())
  globalThis.qaWorkspace = { ...globalThis.qaWorkspace, sessionStateCache: otherCache, sessionControllers: otherControllers }
  await f.render("a")
  assert.equal(f.host.querySelector('[data-item="a-message"]'), null)
  assert.ok(f.host.querySelector('[data-testid="skeleton"]'))
})

test("A→B→A closes departed subscriptions and recovers a new connection from cache", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.subscribe("a")
  const oldA = f.socket("a")
  await f.render("b"); await f.subscribe("b")
  const oldB = f.socket("b")
  assert.equal(oldA.closed, true)
  const reads = f.recoveryCalls.length
  await f.render("a")
  assert.equal(oldB.closed, true)
  assert.equal(f.sockets.length, 3)
  assert.notEqual(f.socket("a"), oldA)
  assert.equal(f.sockets.filter(socket => !socket.closed).length, 1)
  assert.equal(f.recoveryCalls.length, reads)
  assert.deepEqual(f.snapshotCalls, ["a", "b"])
  assert.ok(f.host.querySelector('[data-item="a-message"]'))
  await f.subscribe("a")
  assert.equal(f.recoveryCalls.length, reads + 1)
  assert.deepEqual(f.recoveryCalls.at(-1), ["a", "seq:10"])
})

test("departed sockets are ignored and missed messages and notices are recovered on return", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.subscribe("a")
  const old = f.socket("a")
  await f.render("b")
  assert.equal(old.closed, true)
  const notice = { noticeId: "background", type: "notification", title: "background notice", status: "open", source: {}, context: {}, updatedSeq: 11 }
  await act(async () => {
    old.receive(event("a", "timeline.item_updated", { item: item("a-message", "obsolete socket text", 11) }, 11))
    old.receive(event("a", "runtime.notice.updated", { notice }, 11))
  })
  assert.equal(f.host.querySelector('[data-item="a-message"]'), null)
  await f.render("a")
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "a-message")
  assert.equal(f.host.querySelector('[data-notice="background"]'), null)
  t.mock.method(dashboardApi, "getSessionEvents", async () => ({ events: [event("a", "timeline.item_updated", { item: item("a-message", "recovered text", 11) }, 11)], nextCursor: "seq:11", snapshotRequired: false }))
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", async () => ({ notices: [notice] }))
  await f.subscribe("a")
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "recovered text")
  assert.ok(f.host.querySelector('[data-notice="background"]'))
})

test("returning before the first snapshot finishes starts a fresh load and ignores the abandoned result", async t => {
  const f = await fixture(t)
  const pending = deferred()
  let calls = 0
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => {
    if (id === "a" && ++calls === 1) return pending.promise
    return snapshot(id)
  })
  await f.render("a"); await f.render("b"); await f.render("a")
  assert.equal(calls, 2)
  await act(async () => pending.resolve(snapshot("a", [item("obsolete", "obsolete")])))
  assert.ok(f.host.querySelector('[data-item="a-message"]'))
  assert.equal(f.host.querySelector('[data-item="obsolete"]'), null)
})

test("leaving while a ticket request is pending cannot open a background socket", async t => {
  const f = await fixture(t)
  const ticket = deferred()
  t.mock.method(dashboardApi, "createWsTicket", (_token, _clientId, id) => id === "a" ? ticket.promise : Promise.resolve({ ticket: "ticket" }))
  await f.render("a"); await f.render("b")
  await act(async () => ticket.resolve({ ticket: "late-ticket" }))
  assert.deepEqual(f.sockets.map(socket => socket.sessionId), ["b"])
})

test("slow runtime reads cannot hold timeline events or another runtime domain", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  const stateRead = deferred(), capabilitiesRead = deferred(), noticesRead = deferred()
  t.mock.method(dashboardApi, "getSessionEvents", async () => ({ events: [event("a", "session.meta.updated", { session: session("a") })], nextCursor: "seq:10", snapshotRequired: false }))
  t.mock.method(dashboardApi, "getSessionRuntimeState", () => stateRead.promise)
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", () => capabilitiesRead.promise)
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => noticesRead.promise)
  await f.subscribe("a")
  await act(async () => f.socket("a").receive(event("a", "timeline.item_updated", { item: item("a-message", "not blocked", 12) }, 12)))
  await f.flush()
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "not blocked")
  const notice = { noticeId: "independent", type: "notification", title: "notice available", status: "open", source: {}, context: {}, updatedSeq: 10 }
  await act(async () => noticesRead.resolve({ notices: [notice] }))
  assert.ok(f.host.querySelector('[data-notice="independent"]'))
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "not blocked")
})

test("notice events held during a read survive newer timeline watermarks", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.render("b"); await f.render("a")
  const read = deferred()
  t.mock.method(dashboardApi, "getSessionRuntimeNotices", () => read.promise)
  await f.subscribe("a")
  const notice = { noticeId: "concurrent", type: "notification", title: "latest notice", status: "open", source: {}, context: {}, updatedSeq: 11 }
  await act(async () => {
    f.socket("a").receive(event("a", "runtime.notice.updated", { notice }, 11))
    f.socket("a").receive(event("a", "timeline.item_updated", { item: item("a-message", "newer timeline", 20) }, 20))
  })
  await f.flush()
  await act(async () => read.resolve({ notices: [] }))
  await f.flush()
  assert.equal(f.host.querySelector('[data-item="a-message"]').textContent, "newer timeline")
  assert.ok(f.host.querySelector('[data-notice="concurrent"]'))
})

test("React effect replay shares one connection and a real unmount disposes it", async t => {
  const f = await fixture(t)
  const { StrictMode } = await import("react")
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(h(StrictMode, null, h(SessionDetail, { token: "token", sessionId: "strict", fallbackSession: null }))))
  assert.equal(f.sockets.filter(socket => socket.sessionId === "strict").length, 1)
  assert.deepEqual(f.snapshotCalls, ["strict"])
  await act(async () => { root.unmount() })
  assert.equal(f.sockets[0].closed, true)
  host.remove()
})

test("refreshing credentials replaces the transport while retaining the visible timeline", async t => {
  const f = await fixture(t)
  await f.render("a"); await f.subscribe("a")
  const oldSocket = f.socket("a")
  const tokens = []
  t.mock.method(dashboardApi, "createWsTicket", async token => { tokens.push(token); return { ticket: "new-ticket" } })
  await f.render("a", "new-token")
  assert.ok(f.host.querySelector('[data-item="a-message"]'))
  assert.deepEqual(tokens, ["new-token"])
  await act(async () => { await delay(5) })
  assert.equal(oldSocket.closed, true)
  assert.notEqual(f.socket("a"), oldSocket)
  assert.deepEqual(f.snapshotCalls, ["a"], "a token refresh keeps the existing authenticated account's data")
})

for (const field of ["model", "permission"]) for (const transition of ["visit", "credentials", "visit with credentials"]) test(`${field} writes stay serialized across ${transition} changes and ignore old results`, async t => {
  const f = await fixture(t)
  const first = deferred(), second = deferred(), calls = []
  t.mock.method(dashboardApi, "updateSessionSelections", (_token, _id, patch) => {
    calls.push(patch[field])
    return patch[field] === "first" ? first.promise : second.promise
  })
  await f.render("a")
  let firstChange, secondChange
  await act(async () => { firstChange = globalThis.qaComposer.onSelectionChange({ [field]: "first" }) })
  if (transition !== "credentials") await f.render("b")
  await f.render("a", transition === "visit" ? "token" : "new-token")
  await act(async () => { secondChange = globalThis.qaComposer.onSelectionChange({ [field]: "second" }) })
  assert.deepEqual(calls, ["first"], "the second view must join the existing selection queue")
  await act(async () => { first.resolve({ state: { selections: { [field]: "first" } } }); await firstChange })
  assert.deepEqual(calls, ["first", "second"])
  assert.equal(globalThis.qaComposer.runtimeState.selections[field], "second", "the old view's reply cannot restore its choice")
  await act(async () => { second.resolve({ state: { selections: { [field]: "second" } } }); await secondChange })
})

for (const transition of ["visit", "credentials", "visit with credentials"]) test(`sending after ${transition} changes waits for a pending selection write`, async t => {
  const f = await fixture(t)
  const pending = deferred(), calls = []
  t.mock.method(dashboardApi, "updateSessionSelections", () => pending.promise)
  t.mock.method(dashboardApi, "sendSessionMessage", async (_token, id) => { calls.push(id) })
  await f.render("a")
  let selectionChange, send
  await act(async () => { selectionChange = globalThis.qaComposer.onSelectionChange({ model: "new" }) })
  if (transition !== "credentials") await f.render("b")
  await f.render("a", transition === "visit" ? "token" : "new-token")
  await act(async () => { send = globalThis.qaComposer.onSend("hello", [], {}) })
  assert.deepEqual(calls, [])
  await act(async () => { pending.resolve({ state: { selections: { model: "new" } } }); await selectionChange; await send })
  assert.deepEqual(calls, ["a"])
})

test("a failed send from an earlier visit cannot roll back a later send's waiting state", async t => {
  const f = await fixture(t)
  const { toast } = await import("sonner")
  t.mock.method(toast, "error", () => {})
  const first = deferred(), second = deferred()
  t.mock.method(dashboardApi, "sendSessionMessage", (_token, _id, text) => text === "first" ? first.promise : second.promise)
  await f.render("a")
  let oldSend, newSend
  await act(async () => { oldSend = globalThis.qaComposer.onSend("first", [], {}) })
  await f.render("b"); await f.render("a")
  await act(async () => { newSend = globalThis.qaComposer.onSend("second", [], {}) })
  await act(async () => { first.reject(new Error("late failure")); await oldSend })
  assert.equal(globalThis.qaComposer.runtimeState.status, "waiting")
  await act(async () => { second.resolve({}); await newSend })
})

test("each visit restores its own saved draft", async t => {
  const f = await fixture(t)
  t.after(() => window.localStorage.clear())
  await f.render("a")
  await act(async () => globalThis.qaComposer.onValueChange("draft a"))
  await f.render("b")
  assert.equal(globalThis.qaComposer.value, "")
  await act(async () => globalThis.qaComposer.onValueChange("draft b"))
  await f.render("a")
  assert.equal(globalThis.qaComposer.value, "draft a")
  await f.render("b")
  assert.equal(globalThis.qaComposer.value, "draft b")
})

test("a command completed after leaving cannot update a later visit to the same session", async t => {
  const f = await fixture(t)
  const pending = deferred()
  const updates = []
  t.mock.method(dashboardApi, "sendSessionCommand", () => pending.promise)
  await f.render("a", "token", session => updates.push(session))
  let command
  await act(async () => { command = globalThis.qaComposer.onCommand("compact", { args: [], raw: "/compact" }) })
  await f.render("b"); await f.render("a")
  updates.length = 0
  await act(async () => {
    pending.resolve({ ok: true, session: { ...session("a"), status: "running" }, result: null })
    await command
  })
  assert.equal(globalThis.qaComposer.session.status, "idle")
  assert.deepEqual(updates, [], "an abandoned command must not update the workspace session either")
})

for (const ok of [true, false]) test(`credential refresh removes approvals after ${ok ? "success" : "an already resolved response"}`, async t => {
  const f = await fixture(t)
  const notice = { noticeId: "approval", type: "interaction", title: "approval", status: "open", source: {}, context: {}, updatedSeq: 10, actions: [] }
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => ({ ...snapshot(id), notices: [notice] }))
  t.mock.method(dashboardApi, "respondInteraction", async () => ({ ok, error: ok ? null : { code: "interaction_not_found" } }))
  await f.render("a")
  await f.render("a", "new-token")
  await act(async () => globalThis.qaInteraction.onRespondInteraction("approval", "approve"))
  assert.equal(Boolean(f.host.querySelector('[data-notice="approval"]')), false)
})

test("returning refreshes cached model and permission catalogs without another snapshot", async t => {
  const f = await fixture(t)
  const caps = { capabilities: ["catalog.model", "catalog.permission"].map(capabilityId => ({ capabilityId, supported: true, available: true, allowed: true })) }
  let model = { runtime: "codex", models: [{ id: "old-model" }] }
  let permission = { runtime: "codex", permissions: [{ id: "old-permission" }] }
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => {
    f.snapshotCalls.push(id)
    return { ...snapshot(id), effectiveCapabilities: caps, catalogs: { model, permission } }
  })
  t.mock.method(dashboardApi, "getSessionModelCatalog", async () => ({ catalog: model }))
  t.mock.method(dashboardApi, "getSessionPermissionCatalog", async () => ({ catalog: permission }))
  t.mock.method(dashboardApi, "getSessionRuntimeCapabilities", async () => ({ capabilitySet: caps }))
  await f.render("a"); await f.subscribe("a"); await f.render("b")
  model = { runtime: "codex", models: [{ id: "new-model" }] }
  permission = { runtime: "codex", permissions: [{ id: "new-permission" }] }
  await f.render("a"); await f.subscribe("a"); await f.flush()
  assert.equal(globalThis.qaComposer.modelCatalog.models[0].id, "new-model")
  assert.equal(globalThis.qaComposer.permissionCatalog.permissions[0].id, "new-permission")
  assert.deepEqual(f.snapshotCalls, ["a", "b"])
})

test("revisiting an offline session preserves its notices without reporting a refresh failure", async t => {
  const f = await fixture(t)
  const offline = id => ({ ...session(id), connectorStatus: "offline" })
  const notice = { noticeId: "cached", type: "notification", title: "cached", status: "open", source: {}, context: {}, updatedSeq: 10 }
  t.mock.method(dashboardApi, "getSessionSnapshot", async (_token, id) => ({ ...snapshot(id), session: offline(id), notices: [notice] }))
  t.mock.method(dashboardApi, "getSessionEvents", async (_token, id, cursor) => ({ events: [event(id, "session.meta.updated", { session: offline(id) })], nextCursor: cursor, snapshotRequired: false }))
  await f.render("a"); await f.subscribe("a"); await f.render("b"); await f.render("a"); await f.subscribe("a")
  assert.deepEqual(f.noticeCalls, [])
  assert.ok(f.host.querySelector('[data-notice="cached"]'))
  assert.equal(f.controllers.get("a", () => assert.fail("existing"), "token").getSnapshot().error, null)
})

test("temporary sessions release their controllers when bound or abandoned without starting a transport", async t => {
  const f = await fixture(t)
  globalThis.qaWorkspace = { ...globalThis.qaWorkspace,
    isOptimisticSession: id => id.startsWith("local-"),
    getOptimisticSessionState: id => id.startsWith("local-") ? {
      session: session(id), state: null, items: [item(`${id}-message`)],
      nextSeq: 0, hasMore: false, serverTime: "now",
    } : null,
  }
  for (const [localId, destination] of [["local-bound", "a"], ["local-abandoned", "b"]]) {
    await f.render(localId)
    const local = f.controllers.get(localId, () => assert.fail("existing"), "token")
    assert.ok(f.host.querySelector(`[data-item="${localId}-message"]`))
    assert.equal(f.sockets.some(socket => socket.sessionId === localId), false)
    assert.equal(f.snapshotCalls.includes(localId), false)
    await f.render(destination)
    const state = local.getSnapshot().state
    local.updateState(null)
    assert.equal(local.getSnapshot().state, state, "departed local controllers must be disposed")
    let recreated = false
    f.controllers.get(localId, () => { recreated = true; return local }, "token")
    assert.equal(recreated, true, "the store must release the departed local entry")
  }
})

for (const outcome of ["pending", "failed"]) for (const transition of ["visit", "credentials", "visit with credentials"]) test(`an optimistic session whose first snapshot is ${outcome} retries after ${transition}`, async t => {
  const f = await fixture(t)
  const first = deferred(), retry = deferred()
  const optimisticItems = [{ ...item("optimistic-message:pending", "pending", 10), source: { optimistic: true } }]
  globalThis.qaWorkspace = { ...globalThis.qaWorkspace,
    getOptimisticSessionState: id => id === "a" ? {
      session: session(id), state: null, items: optimisticItems, nextSeq: 10, hasMore: false, serverTime: "now",
    } : null,
    getOptimisticItems: id => id === "a" ? optimisticItems : empty,
  }
  let loads = 0
  t.mock.method(dashboardApi, "getSessionSnapshot", (_token, id) => {
    if (id !== "a") return Promise.resolve(snapshot(id))
    return ++loads === 1 ? first.promise : retry.promise
  })
  await f.render("a")
  if (outcome === "failed") await act(async () => { first.reject(new Error("initial load failed")) })
  if (transition !== "credentials") await f.render("b")
  const token = transition === "visit" ? "token" : "new-token"
  await f.render("a", token)
  assert.ok(f.host.querySelector('[data-item="optimistic-message:pending"]'), "keep the optimistic first paint")
  assert.equal(loads, 2, "an optimistic state is not a successfully loaded snapshot")
  await f.subscribe("a")
  assert.equal(f.recoveryCalls.length, 0, "wait for the first authoritative snapshot before delta recovery")
  await act(async () => retry.resolve(snapshot("a", [item("history", "server history", 1), item("latest")], true)))
  assert.ok(f.host.querySelector('[data-item="history"]'))
  assert.equal(f.controllers.get("a", () => assert.fail("existing"), token).getSnapshot().state.hasMore, true)
  if (outcome === "pending") {
    await act(async () => first.resolve(snapshot("a", [item("obsolete")])) )
    assert.equal(f.host.querySelector('[data-item="obsolete"]'), null)
  }
})

test.after(() => { mockHooks.deregister(); sourceHooks.deregister(); dom.window.close() })
