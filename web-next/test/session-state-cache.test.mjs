import assert from "node:assert/strict"
import test from "node:test"
import { createSessionStateCache } from "../src/components/session/session-state-cache.ts"

function entry(id, text = "message") {
  return {
    state: { session: { id }, items: [{ id: "message", content: { text } }], eventCursor: "seq:12" },
    hasSnapshot: true,
    scrollTop: 420, following: false, groupOpen: { tools: true }, itemOpen: {},
  }
}

test("returning to a session retains its immutable timeline, cursor and reading position", () => {
  const cache = createSessionStateCache("server:user")
  const a = entry("a"), b = entry("b")
  cache.set("a", a)
  cache.set("b", b)
  assert.equal(cache.get("a"), a)
  assert.equal(cache.get("a"), a, "render retries must not consume the cached entry")
  assert.equal(cache.get("b"), b)
})

test("account/server caches are independent, including identical session IDs", () => {
  const first = createSessionStateCache("server-a:user-a")
  const second = createSessionStateCache("server-b:user-a")
  const third = createSessionStateCache("server-a:user-b")
  first.set("a", entry("a"))
  assert.equal(second.get("a"), null)
  assert.equal(third.get("a"), null)
})

test("evicts the least recently read session when the entry budget is reached", () => {
  const cache = createSessionStateCache("scope", { maxEntries: 2 })
  cache.set("a", entry("a")); cache.set("b", entry("b"))
  cache.get("a")
  cache.set("c", entry("c"))
  assert.equal(cache.get("b"), null)
  assert.ok(cache.get("a")); assert.ok(cache.get("c"))
})

test("enforces a total size budget and releases the previous size on replacement", () => {
  const a = entry("a"), b = entry("b")
  const size = JSON.stringify(a).length * 2
  const cache = createSessionStateCache("scope", { maxBytes: size * 2 })
  cache.set("a", a); cache.set("b", b)
  cache.set("a", a)
  assert.ok(cache.get("b"), "replacing a value must not double count its storage")
  cache.get("a")
  cache.set("c", entry("c"))
  assert.equal(cache.get("b"), null)
  assert.equal(cache.get("a"), a)
})

test("oversized histories are not retained, including an oversized replacement", () => {
  const small = entry("a")
  const cache = createSessionStateCache("scope", { maxBytes: JSON.stringify(small).length * 2 })
  cache.set("a", small)
  cache.set("a", entry("a", "x".repeat(5000)))
  assert.equal(cache.get("a"), null)
})

test("revoked/deleted sessions can be removed and mismatched IDs are never cached", () => {
  const cache = createSessionStateCache("scope")
  cache.set("a", entry("a")); cache.delete("a")
  assert.equal(cache.get("a"), null)
  cache.set("a", entry("b"))
  assert.equal(cache.get("a"), null)
})
