import assert from "node:assert/strict"
import test from "node:test"

import { createSessionToolSidebarStore } from "../src/components/session-tool-sidebar-store.ts"
import { createSessionToolTab } from "../src/components/session-tool-tabs.ts"

test("sidebar state is isolated by session and survives collapse", () => {
  const store = createSessionToolSidebarStore()

  store.dispatch("session-a", {
    type: "open-tool",
    tab: createSessionToolTab("review", "review"),
  })
  store.dispatch("session-a", { type: "set-preferred-width", width: 512 })
  store.dispatch("session-a", { type: "collapse-sidebar" })

  store.dispatch("session-b", {
    type: "open-tool",
    tab: createSessionToolTab("files", "files"),
  })

  assert.equal(store.getState("session-a").open, false)
  assert.equal(store.getState("session-a").preferredWidth, 512)
  assert.deepEqual(store.getState("session-a").tabs.map((tab) => tab.id), ["review"])
  assert.equal(store.getState("session-b").open, true)
  assert.deepEqual(store.getState("session-b").tabs.map((tab) => tab.id), ["files"])
})

test("session contexts retain their owning connector", () => {
  const store = createSessionToolSidebarStore()
  store.setContext("session-a", {
    ownerUserId: "user-a",
    connectorId: "connector-a",
    root: "/repo/a",
    terminalLabel: "Terminal",
  })
  store.setContext("session-b", {
    ownerUserId: "user-a",
    connectorId: "connector-b",
    root: "/repo/b",
    terminalLabel: "Terminal",
  })

  assert.equal(store.getContext("session-a")?.connectorId, "connector-a")
  assert.equal(store.getContext("session-b")?.connectorId, "connector-b")
})

test("optimistic session state migrates to the canonical session id", () => {
  const store = createSessionToolSidebarStore()
  store.setContext("session-local", {
    ownerUserId: "user-a",
    connectorId: "connector-a",
    root: "/repo/a",
    terminalLabel: "Terminal",
  })
  store.dispatch("session-local", {
    type: "open-tool",
    tab: createSessionToolTab("terminal-pending", "terminal", "Terminal"),
  })

  store.migrateSession("session-local", "session-real")
  store.dispatch("session-local", {
    type: "set-preferred-width",
    width: 640,
  })

  assert.deepEqual(store.getSessionIds(), ["session-real"])
  assert.equal(store.getContext("session-real")?.root, "/repo/a")
  assert.equal(store.getState("session-real").tabs[0]?.id, "terminal-pending")
  assert.equal(store.getState("session-real").preferredWidth, 640)
  assert.equal(store.getState("session-local"), store.getState("session-real"))
  assert.equal(store.getHostKey("session-real"), "session-local")
})
