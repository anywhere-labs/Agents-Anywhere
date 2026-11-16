import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { createSessionStateCache, sessionCacheScope } = await import("../src/components/session/session-state-cache.ts")
const { createMemorySessionStore, sessionDiskCacheAllowed, setSessionDiskCacheAllowed, SESSION_DISK_RECORD_VERSION } = await import("../src/components/session/session-disk-store.ts")

const item = (id, source = {}) => ({ id, source, content: { text: id }, updatedSeq: 1 })
function entry(id, { items = [item("m1"), item("optimistic-message:x", { optimistic: true })], hasSnapshot = true } = {}) {
  return {
    state: {
      session: { id }, items, eventCursor: "seq:12", nextSeq: 12, hasMore: true,
      state: { status: "running" }, notices: [{ noticeId: "n" }], deviceOffline: true, historySource: "unavailable",
    },
    hasSnapshot, scrollTop: 420, following: false, groupOpen: { tools: true }, itemOpen: {},
  }
}

test("a saved session survives a reload without live state or local optimistic messages", async () => {
  const disk = createMemorySessionStore()
  const scope = sessionCacheScope("https://aa.example", "u1")
  const first = createSessionStateCache(scope, { persistent: disk })
  first.set("a", entry("a"))
  await first.flush()

  const reloaded = createSessionStateCache(scope, { persistent: disk })
  assert.equal(reloaded.get("a"), null, "disk content is loaded asynchronously")
  const restored = await reloaded.load("a")
  assert.deepEqual(restored.state.items.map(value => value.id), ["m1"])
  assert.equal(restored.state.eventCursor, "seq:12")
  assert.equal(restored.state.state, null)
  assert.deepEqual(restored.state.notices, [])
  assert.equal(restored.state.deviceOffline, undefined)
  assert.equal(restored.hasSnapshot, true)
  assert.equal(restored.scrollTop, 420)
  assert.equal(reloaded.has("a"), true, "a disk hit is kept in memory for the visit")
})

test("content without an authoritative snapshot never reaches the disk", async () => {
  const disk = createMemorySessionStore()
  const cache = createSessionStateCache("s", { persistent: disk })
  cache.set("a", entry("a", { hasSnapshot: false }))
  await cache.flush()
  assert.equal(disk.records.size, 0)
})

test("accounts and servers stay isolated on disk and clearing one leaves the others", async () => {
  const disk = createMemorySessionStore()
  const mine = createSessionStateCache(sessionCacheScope("server", "u1"), { persistent: disk })
  const other = createSessionStateCache(sessionCacheScope("server", "u2"), { persistent: disk })
  mine.set("a", entry("a"))
  other.set("a", entry("a"))
  await mine.flush(); await other.flush()
  await mine.clear()
  assert.equal(await createSessionStateCache(sessionCacheScope("server", "u1"), { persistent: disk }).load("a"), null)
  assert.notEqual(await createSessionStateCache(sessionCacheScope("server", "u2"), { persistent: disk }).load("a"), null)
  await disk.retainOnly(sessionCacheScope("server", "u1"))
  assert.equal(disk.records.size, 0)
})

test("a deletion wins over a write still queued for the same session", async () => {
  const disk = createMemorySessionStore()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = { ...disk, async write(record) { await gate; return disk.write(record) } }
  const cache = createSessionStateCache("s", { persistent: slow })
  cache.set("a", entry("a"))
  cache.delete("a")
  release()
  await cache.flush()
  assert.equal(disk.records.size, 0)
})

test("the disk keeps the most recently used sessions within its limits", async () => {
  const disk = createMemorySessionStore()
  let clock = 0
  const cache = createSessionStateCache("s", { persistent: disk, maxDiskEntries: 2, now: () => ++clock })
  for (const id of ["a", "b", "c"]) cache.set(id, entry(id))
  await cache.flush()
  assert.deepEqual([...disk.records.values()].map(record => record.sessionId).sort(), ["b", "c"])
})

test("records of another version are ignored", async () => {
  const disk = createMemorySessionStore()
  await disk.write({ scope: "s", sessionId: "a", version: SESSION_DISK_RECORD_VERSION + 1, accessedAt: 1, bytes: 1, value: entry("a") })
  assert.equal(await createSessionStateCache("s", { persistent: disk }).load("a"), null)
})

test("the shared-computer preference turns disk caching off", () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  assert.equal(sessionDiskCacheAllowed(storage), true)
  setSessionDiskCacheAllowed(false, storage)
  assert.equal(sessionDiskCacheAllowed(storage), false)
  setSessionDiskCacheAllowed(true, storage)
  assert.equal(sessionDiskCacheAllowed(storage), true)
})

test("a view closing after sign-out does not write its session back", async () => {
  const { forgetSessionDiskCache } = await import("../src/components/session/session-disk-store.ts")
  const disk = createMemorySessionStore()
  const scope = sessionCacheScope("server", "signed-out")
  const cache = createSessionStateCache(scope, { persistent: disk })
  await forgetSessionDiskCache(scope)
  cache.set("a", entry("a"))
  await cache.flush()
  assert.equal(disk.records.size, 0)
  const next = createSessionStateCache(scope, { persistent: disk })
  next.set("a", entry("a"))
  await next.flush()
  assert.equal(disk.records.size, 1, "signing in again starts a new cache that may persist")
})
