import assert from "node:assert/strict"
import test from "node:test"
import { createSessionControllerStore } from "../src/components/session/session-controller-store.ts"
import { createSessionStateCache } from "../src/components/session/session-state-cache.ts"

function controller(id) {
  const value = { state: { session: { id }, items: [], eventCursor: "seq:10" }, hasSnapshot: true, invalidated: false }
  return { starts: 0, disposed: false, selectionChanges: { revision: 0, writes: new Map() }, getSnapshot: () => value, start() { this.starts++ }, dispose() { this.disposed = true } }
}

test("leaving closes the subscription without waiting for an idle timeout", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  t.after(() => store.dispose())
  const values = {}
  let release
  for (const id of ["a", "b", "c", "d"]) {
    release?.()
    values[id] = store.get(id, () => controller(id))
    release = store.retain(id, values[id])
    await Promise.resolve()
  }
  for (const id of ["a", "b", "c"]) assert.equal(values[id].disposed, true)
  assert.equal(values.d.disposed, false)
  release()
  await Promise.resolve()
  assert.equal(values.d.disposed, true)
})

test("returning creates a new controller while effect replay retains the mounted one", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  t.after(() => store.dispose())
  const a = store.get("a", () => controller("a"))
  const release = store.retain("a", a)
  release()
  assert.equal(store.get("a", () => assert.fail("must reuse")), a)
  const releaseAgain = store.retain("a", a)
  await Promise.resolve()
  assert.equal(a.disposed, false)
  releaseAgain()
  await Promise.resolve()
  assert.equal(a.disposed, true)
  assert.notEqual(store.get("a", () => controller("a")), a)
})

test("closing saves the final state with the existing reading position", async t => {
  const cache = createSessionStateCache("scope")
  const store = createSessionControllerStore(cache)
  t.after(() => store.dispose())
  const a = store.get("a", () => controller("a"))
  const release = store.retain("a", a)
  cache.set("a", { state: a.getSnapshot().state, scrollTop: 420, following: false, groupOpen: {}, itemOpen: {} })
  a.getSnapshot().state = { ...a.getSnapshot().state, eventCursor: "seq:20", items: [{ id: "new" }] }
  release()
  await Promise.resolve()
  assert.equal(cache.get("a").state.eventCursor, "seq:20")
  assert.equal(cache.get("a").hasSnapshot, true)
  assert.equal(cache.get("a").scrollTop, 420)
})

test("workspace effect replay does not close connections, while leaving closes them", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  const a = store.get("a", () => controller("a"))
  store.retain("a", a)
  store.activate(); store.deactivate(); store.activate()
  await Promise.resolve()
  assert.equal(a.disposed, false)
  store.deactivate()
  await Promise.resolve()
  assert.equal(a.disposed, true)
})

test("revoked controllers cannot repopulate cache and authenticate anew on revisit", t => {
  const cache = createSessionStateCache("scope")
  const store = createSessionControllerStore(cache)
  t.after(() => store.dispose())
  const a = store.get("a", () => controller("a"))
  cache.set("a", { state: a.getSnapshot().state, scrollTop: 0, following: true, groupOpen: {}, itemOpen: {} })
  a.getSnapshot().invalidated = true
  const replacement = store.get("a", () => controller("a"))
  assert.notEqual(replacement, a)
  assert.equal(a.disposed, true)
  assert.equal(cache.get("a"), null)
})

test("pending selection writes survive closing the subscription and are shared on return", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  t.after(() => store.dispose())
  const a = store.get("a", () => controller("a"))
  const release = store.retain("a", a)
  let finish
  const write = new Promise(resolve => { finish = resolve })
  const selections = a.selectionChanges
  selections.revision = 2
  selections.writes.set("a", write)
  release()
  await Promise.resolve()
  assert.equal(a.disposed, true)
  const replacement = store.get("a", () => controller("a"))
  assert.notEqual(replacement, a)
  assert.equal(replacement.selectionChanges, selections)
  assert.equal(replacement.selectionChanges.writes.get("a"), write)
  selections.writes.delete("a")
  finish()
})

test("settled writes do not retain an inactive session's selection queue", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  t.after(() => store.dispose())
  const a = store.get("a", () => controller("a"))
  const release = store.retain("a", a)
  let finish
  const write = new Promise(resolve => { finish = resolve })
  a.selectionChanges.writes.set("a", write)
  release()
  await Promise.resolve()
  a.selectionChanges.writes.delete("a")
  finish()
  await Promise.allSettled([write])
  await Promise.resolve()
  assert.notEqual(store.get("a", () => controller("a")).selectionChanges, a.selectionChanges)
})

test("credential refresh replaces only the transport and preserves pending selections", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  t.after(() => store.dispose())
  const a = store.get("a", () => controller("a"), "old-token")
  const release = store.retain("a", a)
  let finish
  const write = new Promise(resolve => { finish = resolve })
  a.selectionChanges.revision = 2
  a.selectionChanges.writes.set("a", write)
  const replacement = store.get("a", () => controller("a"), "new-token")
  assert.notEqual(replacement, a)
  assert.equal(a.disposed, true)
  assert.equal(replacement.selectionChanges, a.selectionChanges)
  const releaseReplacement = store.retain("a", replacement)
  release()
  await Promise.resolve()
  assert.equal(replacement.disposed, false, "old effect cleanup cannot dispose its replacement")
  assert.equal(store.get("a", () => assert.fail("must reuse"), "new-token"), replacement)
  replacement.selectionChanges.writes.delete("a")
  finish()
  releaseReplacement()
})

test("local sessions share effect replay and departure cleanup without starting a transport", async t => {
  const store = createSessionControllerStore(createSessionStateCache("scope"))
  t.after(() => store.dispose())
  const a = store.get("local", () => controller("local"))
  const release = store.retain("local", a, { start: false })
  release()
  const releaseAgain = store.retain("local", a, { start: false })
  await Promise.resolve()
  assert.equal(a.starts, 0)
  assert.equal(a.disposed, false)
  releaseAgain()
  await Promise.resolve()
  assert.equal(a.disposed, true)
  assert.notEqual(store.get("local", () => controller("local")), a)
})
