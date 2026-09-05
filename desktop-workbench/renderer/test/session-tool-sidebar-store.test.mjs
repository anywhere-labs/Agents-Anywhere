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

test("review timeline snapshots are isolated and notify subscribers on meaningful changes", () => {
  const store = createSessionToolSidebarStore()
  const items = [{ id: "change-a" }]
  const snapshot = { items, hasMore: true, nextSeq: 12 }
  let notifications = 0
  const unsubscribe = store.subscribeReviewTimeline("session-a", () => {
    notifications += 1
  })

  store.setReviewTimeline("session-a", snapshot)
  store.setReviewTimeline("session-a", { items, hasMore: true, nextSeq: 12 })

  assert.equal(store.getReviewTimeline("session-a"), snapshot)
  assert.equal(store.getReviewTimeline("session-b"), null)
  assert.deepEqual(store.getSessionIds(), [])
  assert.equal(notifications, 1)

  const nextSnapshot = { items: [...items], hasMore: false, nextSeq: 13 }
  store.setReviewTimeline("session-a", nextSnapshot)
  assert.equal(store.getReviewTimeline("session-a"), nextSnapshot)
  assert.equal(notifications, 2)

  store.setReviewTimeline("session-a", null)
  store.setReviewTimeline("session-a", null)
  assert.equal(store.getReviewTimeline("session-a"), null)
  assert.equal(notifications, 3)

  unsubscribe()
})

test("review timeline follows optimistic session migration and aliases", () => {
  const store = createSessionToolSidebarStore()
  const localSnapshot = { items: [{ id: "local-change" }], hasMore: true, nextSeq: 8 }
  const canonicalSnapshot = { items: [{ id: "remote-change" }], hasMore: false, nextSeq: 7 }
  let canonicalNotifications = 0

  store.setContext("session-local", {
    ownerUserId: "user-a",
    connectorId: "connector-a",
    root: "/repo/a",
    terminalLabel: "Terminal",
  })
  store.setReviewTimeline("session-local", localSnapshot)
  store.setReviewTimeline("session-real", canonicalSnapshot)
  store.subscribeReviewTimeline("session-real", () => {
    canonicalNotifications += 1
  })

  store.migrateSession("session-local", "session-real")

  assert.deepEqual(store.getSessionIds(), ["session-real"])
  assert.equal(store.getReviewTimeline("session-real"), localSnapshot)
  assert.equal(store.getReviewTimeline("session-local"), localSnapshot)
  assert.equal(canonicalNotifications, 1)

  const nextSnapshot = { items: [{ id: "next-change" }], hasMore: false, nextSeq: 9 }
  store.setReviewTimeline("session-local", nextSnapshot)
  assert.equal(store.getReviewTimeline("session-real"), nextSnapshot)
  assert.equal(canonicalNotifications, 2)
})
