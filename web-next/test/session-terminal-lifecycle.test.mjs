import assert from "node:assert/strict"
import test from "node:test"
import { openWorkspaceTerminal } from "../src/components/session-terminal-lifecycle.ts"
import { createSessionToolSidebarStore } from "../src/components/session-tool-sidebar-store.ts"
import { createSessionToolTab } from "../src/components/session-tool-tabs.ts"
import { readTerminalPreferences, terminalPreferenceKey, writeTerminalPreferences } from "../src/components/session-terminal-preferences.ts"

function terminal(id, root = "/repo", status = "running") {
  return { terminalId: id, sessionId: "browse_device", root, cwd: root, label: id, cols: 80, rows: 24, purpose: "user", pid: 100, status, exitCode: null, scrollbackBytes: 12, scrollbackSeq: 1, createdAt: "2026-09-06" }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture({ terminals = [], preference, operations = {} } = {}) {
  let saved = []
  const store = createSessionToolSidebarStore({
    terminalPreferences: preference ? [preference] : [],
    onTerminalPreferencesChange: value => { saved = value },
  })
  const context = { ownerUserId: "user", connectorId: "device", root: "/repo", terminalLabel: "Terminal" }
  store.setContext("session", context)
  const calls = { list: 0, create: [], close: [] }
  const options = {
    store, sessionId: "session", userId: "user", connectorId: "device", root: "/repo", label: "Terminal",
    operations: {
      async list() { calls.list++; return terminals },
      async create(label) { calls.create.push(label); return { ...terminal(`new-${calls.create.length}`), label } },
      async close(id) { calls.close.push(id) },
      ...operations,
    },
  }
  return { store, context, calls, options, saved: () => saved }
}
const preference = { sessionId: "session", connectorId: "device", root: "/repo", open: false, expanded: false, preferredWidth: 560, activeTerminalId: "second" }

test("first open restores all terminals in the same workspace, including exited records", async () => {
  const f = fixture({ terminals: [terminal("first"), terminal("other", "/elsewhere"), terminal("exited", "/repo", "exited")] })
  f.store.dispatch("session", { type: "open-tool", tab: createSessionToolTab("files", "files", "Files") })
  await openWorkspaceTerminal(f.options)
  const state = f.store.getState("session")
  assert.deepEqual(state.tabs.flatMap(tab => tab.terminal ? [tab.terminal.terminalId] : []), ["first", "exited"])
  assert.equal(state.tabs.find(tab => tab.id === state.activeTabId).terminal.terminalId, "first")
  assert.equal(f.calls.list, 1)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.close, [])
})

test("repeated opens during the initial query do not duplicate queries or shells", async () => {
  const query = deferred()
  const f = fixture({ operations: { list: () => query.promise } })
  const first = openWorkspaceTerminal(f.options)
  assert.equal(openWorkspaceTerminal(f.options), first)
  query.resolve([])
  await first
  assert.deepEqual(f.calls.create, ["Terminal"])
  await openWorkspaceTerminal(f.options)
  assert.deepEqual(f.calls.create, ["Terminal", "Terminal 2"])
  assert.equal(f.store.getState("session").tabs.length, 2)
})

test("query failures do not create replacements and a later open retries the inventory", async () => {
  const f = fixture({ operations: { async list() { throw new Error("offline") } } })
  await assert.rejects(openWorkspaceTerminal(f.options), /offline/)
  assert.deepEqual(f.calls.create, [])
  assert.equal(f.store.getState("session").tabs[0].error, "offline")
  f.options.operations.list = async () => [terminal("recovered")]
  await openWorkspaceTerminal(f.options)
  assert.deepEqual(f.store.getState("session").tabs.map(tab => tab.terminal.terminalId), ["recovered"])
})

test("reload restores layout and active terminal from a fresh inventory, not cached processes", async () => {
  const f = fixture({ preference, terminals: [terminal("first"), terminal("second")] })
  await openWorkspaceTerminal({ ...f.options, restore: f.store.getTerminalPreference("session") })
  const state = f.store.getState("session")
  assert.equal(state.open, false)
  assert.equal(state.preferredWidth, 560)
  assert.equal(state.tabs.find(tab => tab.id === state.activeTabId).terminal.terminalId, "second")
  assert.deepEqual(f.calls.create, [])
  assert.equal(f.saved()[0].activeTerminalId, "second")
})

test("reload never creates a shell when previously running terminals have been collected", async () => {
  const f = fixture({ preference })
  await openWorkspaceTerminal({ ...f.options, restore: preference })
  assert.deepEqual(f.calls.create, [])
  assert.equal(f.store.getState("session").tabs.length, 0)
  assert.equal(f.store.getTerminalPreference("session"), null)
})

test("closing the loading tab does not close terminals returned by the query", async () => {
  const query = deferred()
  const f = fixture({ operations: { list: () => query.promise } })
  const opening = openWorkspaceTerminal(f.options)
  f.store.dispatch("session", { type: "close-tab", id: f.store.getState("session").tabs[0].id })
  query.resolve([terminal("existing")])
  await opening
  assert.deepEqual(f.calls.close, [])
  assert.deepEqual(f.calls.create, [])
  assert.equal(f.store.getState("session").tabs.length, 0)
})

test("closing and immediately reopening a loading tab waits for the previous query then restores", async () => {
  const query = deferred()
  let queries = 0
  const f = fixture({ operations: { list: () => { queries++; return query.promise } } })
  const first = openWorkspaceTerminal(f.options)
  f.store.dispatch("session", { type: "close-tab", id: f.store.getState("session").tabs[0].id })
  const reopened = openWorkspaceTerminal(f.options)
  query.resolve([terminal("existing")])
  await Promise.all([first, reopened])
  assert.equal(queries, 2)
  assert.equal(f.store.getState("session").tabs[0].terminal.terminalId, "existing")
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.close, [])
})

test("explicitly closing a creating tab cleans up only that newly created process", async () => {
  const creation = deferred()
  const started = deferred()
  const f = fixture({ operations: { create: () => { started.resolve(); return creation.promise } } })
  const opening = openWorkspaceTerminal(f.options)
  await started.promise
  f.store.dispatch("session", { type: "close-tab", id: f.store.getState("session").tabs[0].id })
  creation.resolve(terminal("new-shell"))
  await opening
  assert.deepEqual(f.calls.close, ["new-shell"])
  assert.equal(f.store.getState("session").tabs.length, 0)
})

test("leaving the page/account during creation preserves the Connector process for later queries", async () => {
  const creation = deferred()
  const started = deferred()
  const f = fixture({ operations: { create: () => { started.resolve(); return creation.promise } } })
  const opening = openWorkspaceTerminal(f.options)
  await started.promise
  f.store.beginShutdown()
  creation.resolve(terminal("survivor"))
  await opening
  assert.deepEqual(f.calls.close, [])
  const next = fixture({ preference: f.saved()[0], terminals: [terminal("survivor")] })
  await openWorkspaceTerminal({ ...next.options, restore: next.store.getTerminalPreference("session") })
  assert.equal(next.store.getState("session").tabs[0].terminal.terminalId, "survivor")
  assert.deepEqual(next.calls.create, [])
})

test("changing connector/workspace detaches old tabs and ignores an earlier query", async () => {
  const query = deferred()
  const f = fixture({ operations: { list: () => query.promise } })
  const opening = openWorkspaceTerminal(f.options)
  f.store.setContext("session", { ...f.context, connectorId: "device-b", root: "/other" })
  query.resolve([terminal("old")])
  await opening
  assert.equal(f.store.getState("session").tabs.length, 0)
  assert.deepEqual(f.calls.close, [])
  assert.deepEqual(f.calls.create, [])
})

test("queries and saved preferences follow optimistic session ID migration", async () => {
  const query = deferred()
  const f = fixture({ operations: { list: () => query.promise } })
  const opening = openWorkspaceTerminal(f.options)
  f.store.migrateSession("session", "canonical")
  query.resolve([terminal("existing")])
  await opening
  assert.equal(f.store.getState("canonical").tabs[0].terminal.terminalId, "existing")
  assert.equal(f.saved()[0].sessionId, "canonical")
})

test("closing a workspace terminal removes its other session views and rejects late stale query results", async () => {
  const f = fixture({ terminals: [terminal("shared")] })
  await openWorkspaceTerminal(f.options)
  f.store.setContext("second-session", f.context)
  await openWorkspaceTerminal({ ...f.options, sessionId: "second-session" })
  const query = deferred()
  f.store.setContext("third-session", f.context)
  const opening = openWorkspaceTerminal({ ...f.options, sessionId: "third-session", restore: preference, operations: { ...f.options.operations, list: () => query.promise } })
  f.store.removeTerminal("device", "shared")
  query.resolve([terminal("shared")])
  await opening
  for (const sessionId of f.store.getSessionIds()) assert.equal(f.store.getState(sessionId).tabs.length, 0)
})

test("preferences are isolated by server/account and store no credentials, process data or output", async () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const key = terminalPreferenceKey("server-a", "user-a")
  writeTerminalPreferences(storage, key, [preference])
  assert.deepEqual(readTerminalPreferences(storage, key), [preference])
  assert.deepEqual(readTerminalPreferences(storage, terminalPreferenceKey("server-a", "user-b")), [])
  assert.deepEqual(readTerminalPreferences(storage, terminalPreferenceKey("server-b", "user-a")), [])
  storage.setItem(key, JSON.stringify([{ ...preference, accessToken: "secret", output: "private", pid: 100 }]))
  assert.deepEqual(readTerminalPreferences(storage, key), [preference])
  storage.setItem(key, "invalid JSON")
  assert.deepEqual(readTerminalPreferences(storage, key), [])
  const blocked = { getItem() { throw new Error("denied") }, setItem() { throw new Error("denied") } }
  assert.deepEqual(readTerminalPreferences(blocked, key), [])
  assert.doesNotThrow(() => writeTerminalPreferences(blocked, key, [preference]))
})
