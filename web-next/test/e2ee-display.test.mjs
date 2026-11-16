// Session display envelopes in E2EE mode: sealed with the device's directory key (contracts/e2ee/1.0
// 「加密的存放内容」), opened here with real WebCrypto; and the automatic project assignment that follows
// (「会话归属项目」).
import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

const hooks = registerSource()
const { SessionDisplayDecryptor, trustStoreDisplayKeys, withSessionDisplay } = await import("../src/features/e2ee/display.ts")
const { SessionProjectAssigner, matchSessionProject, normalizeWorkspacePath } = await import("../src/features/e2ee/project-assignment.ts")
const { displayEnvelopeAd, sealDisplay } = await import("../src/lib/e2ee/formats.ts")
const { ClientTrustStore, memoryTrustBackend } = await import("../src/lib/e2ee/trust-store.ts")
const { b64url, utf8 } = await import("../src/lib/e2ee/bytes.ts")
hooks.deregister()

const DEVICE = "dev_display"

async function pairedStore(keyId = "k1", epoch = 1) {
  const store = new ClientTrustStore(memoryTrustBackend())
  const key = crypto.getRandomValues(new Uint8Array(32))
  await store.savePairing({
    deviceId: DEVICE,
    devicePub: b64url(crypto.getRandomValues(new Uint8Array(32))),
    label: "Laptop",
    grantedAt: new Date().toISOString(),
    directoryKey: { deviceId: DEVICE, keyId, epoch, key: b64url(key) },
  })
  return { store, keys: new Map([[keyId, key]]) }
}

async function seal(key, { sessionId, slot, keyId, deviceId = DEVICE }, fields) {
  const payload = await sealDisplay(key, displayEnvelopeAd(deviceId, sessionId, slot, keyId), utf8(JSON.stringify(fields)))
  return { mode: "sealed", keyId, payload }
}

function session(id, extra = {}) {
  return { id, connectorId: DEVICE, title: null, cwd: null, projectId: null, ...extra }
}

const labels = { locked: "加密中，设备上线后显示", untitled: "Untitled session" }

test("list and detail: sealed envelopes open with the paired device's directory key; the user's title wins", async () => {
  const { store, keys } = await pairedStore()
  const key = keys.get("k1")
  const renamed = session("ses_renamed", {
    displayDevice: await seal(key, { sessionId: "ses_renamed", slot: "device", keyId: "k1" }, { title: "Native title", cwd: "/work/app", preview: "last reply", extra: 1 }),
    displayUser: await seal(key, { sessionId: "ses_renamed", slot: "user", keyId: "k1" }, { title: "My title" }),
  })
  const native = session("ses_native", {
    displayDevice: await seal(key, { sessionId: "ses_native", slot: "device", keyId: "k1" }, { title: "Native only", cwd: "/work/other" }),
  })
  const decryptor = new SessionDisplayDecryptor(trustStoreDisplayKeys(store))

  // Before the background decryption finishes, the session reads as locked.
  assert.equal(decryptor.read(renamed).state, "locked")
  const [first, second] = await decryptor.settle([renamed, native])
  assert.deepEqual(first, { title: "My title", cwd: "/work/app", preview: "last reply", state: "decrypted" })
  assert.deepEqual(second, { title: "Native only", cwd: "/work/other", preview: null, state: "decrypted" })

  // What the sidebar and the session header render.
  const shown = withSessionDisplay({ ...renamed, title: "Untitled session" }, first, labels)
  assert.equal(shown.title, "My title")
  assert.equal(shown.cwd, "/work/app")
  assert.equal(shown.displayState, "decrypted")
})

test("results are cached per envelope: re-renders do not decrypt again, a new payload does", async () => {
  const { store, keys } = await pairedStore()
  let lookups = 0
  const resolve = trustStoreDisplayKeys(store)
  const decryptor = new SessionDisplayDecryptor(async (...args) => {
    lookups += 1
    return resolve(...args)
  })
  let notified = 0
  decryptor.subscribe(() => notified++)
  const target = { sessionId: "ses_cache", slot: "device", keyId: "k1" }
  const first = session("ses_cache", { displayDevice: await seal(keys.get("k1"), target, { title: "One" }) })
  await decryptor.settle([first])
  for (let index = 0; index < 5; index++) assert.equal(decryptor.read({ ...first }).title, "One")
  assert.equal(lookups, 1)
  assert.equal(notified, 1)

  const resealed = session("ses_cache", { displayDevice: await seal(keys.get("k1"), target, { title: "Two" }) })
  const [next] = await decryptor.settle([resealed])
  assert.equal(next.title, "Two")
  assert.equal(lookups, 2)
})

test("an unknown keyId shows the locked placeholder and never the Server's plaintext fields", async () => {
  const { store } = await pairedStore()
  const otherKey = crypto.getRandomValues(new Uint8Array(32))
  const locked = session("ses_locked", {
    title: "server says this", cwd: "/server/path",
    displayDevice: await seal(otherKey, { sessionId: "ses_locked", slot: "device", keyId: "k9" }, { title: "secret", cwd: "/secret" }),
  })
  const decryptor = new SessionDisplayDecryptor(trustStoreDisplayKeys(store))
  const [display] = await decryptor.settle([locked])
  assert.deepEqual(display, { title: null, cwd: null, preview: null, state: "locked" })
  const shown = withSessionDisplay(locked, display, labels)
  assert.equal(shown.title, "加密中，设备上线后显示")
  assert.equal(shown.cwd, null)
  assert.equal(shown.displayState, "locked")

  // An unpaired device (no pin at all) reads the same way.
  const unpaired = { ...locked, id: "ses_unpaired", connectorId: "dev_other" }
  assert.equal((await decryptor.settle([unpaired]))[0].state, "locked")
})

test("tampered payloads and envelopes moved to another session stay locked", async () => {
  const { store, keys } = await pairedStore()
  const key = keys.get("k1")
  const good = await seal(key, { sessionId: "ses_a", slot: "device", keyId: "k1" }, { title: "A", cwd: "/a" })
  const bytes = Buffer.from(good.payload, "base64url")
  bytes[bytes.length - 1] ^= 0x01
  const tampered = session("ses_a", { displayDevice: { ...good, payload: bytes.toString("base64url") } })
  const moved = session("ses_b", { displayDevice: good })
  const wrongSlot = session("ses_a", { displayUser: good })
  const garbage = session("ses_c", { displayDevice: { mode: "sealed", keyId: "k1", payload: "not-base64!" } })
  const decryptor = new SessionDisplayDecryptor(trustStoreDisplayKeys(store))
  const results = await decryptor.settle([tampered, moved, wrongSlot, garbage])
  for (const display of results) assert.equal(display.state, "locked")
  assert.ok(results.every((display) => display.title === null && display.cwd === null))
})

test("a user title that cannot be opened is not replaced by the device's original title", async () => {
  const { store, keys } = await pairedStore()
  const unreadableUser = session("ses_u", {
    displayDevice: await seal(keys.get("k1"), { sessionId: "ses_u", slot: "device", keyId: "k1" }, { title: "Native", cwd: "/w" }),
    displayUser: await seal(crypto.getRandomValues(new Uint8Array(32)), { sessionId: "ses_u", slot: "user", keyId: "k0" }, { title: "Renamed" }),
  })
  const [display] = await new SessionDisplayDecryptor(trustStoreDisplayKeys(store)).settle([unreadableUser])
  assert.deepEqual(display, { title: null, cwd: "/w", preview: null, state: "locked" })
  assert.equal(withSessionDisplay(unreadableUser, display, labels).title, labels.locked)
})

test("a directory key that arrives later (rotation) unlocks the session on retry", async () => {
  const { store } = await pairedStore("k1", 1)
  const rotated = crypto.getRandomValues(new Uint8Array(32))
  const later = session("ses_rotated", {
    displayDevice: await seal(rotated, { sessionId: "ses_rotated", slot: "device", keyId: "k2" }, { title: "After rotation", cwd: "/r" }),
  })
  const decryptor = new SessionDisplayDecryptor(trustStoreDisplayKeys(store))
  store.onChange(() => decryptor.retryLocked())
  assert.equal((await decryptor.settle([later]))[0].state, "locked")
  let notified = 0
  decryptor.subscribe(() => notified++)
  await store.addDirectoryKey({ deviceId: DEVICE, keyId: "k2", epoch: 2, key: b64url(rotated) })
  assert.ok(notified >= 1, "subscribers re-read after the key arrives")
  assert.deepEqual((await decryptor.settle([later]))[0], { title: "After rotation", cwd: "/r", preview: null, state: "decrypted" })
})

test("normal mode: no envelopes renders exactly as before; plain envelopes use the same fields", async () => {
  const decryptor = new SessionDisplayDecryptor(async () => assert.fail("plain sessions never look up keys"))
  const legacy = session("ses_plain", { title: "Server title", cwd: "/srv" })
  const display = decryptor.read(legacy)
  assert.deepEqual(display, { title: "Server title", cwd: "/srv", preview: null, state: "plain" })
  assert.equal(withSessionDisplay(legacy, display, labels), legacy, "untouched object")

  const plain = session("ses_plain2", {
    title: "Old", cwd: "/old",
    displayDevice: { mode: "plain", keyId: null, payload: { title: "Device", cwd: "/dev", preview: "p", ignored: true } },
    displayUser: { mode: "plain", keyId: null, payload: { title: "User" } },
  })
  assert.deepEqual(decryptor.read(plain), { title: "User", cwd: "/dev", preview: "p", state: "plain" })
  const fallback = session("ses_plain3", { title: "Legacy", cwd: "/legacy", displayDevice: { mode: "plain", keyId: null, payload: {} } })
  assert.deepEqual(decryptor.read(fallback), { title: "Legacy", cwd: "/legacy", preview: null, state: "plain" })
  assert.equal(withSessionDisplay(fallback, decryptor.read(fallback), labels).displayState, "plain")
})

test("reset forgets decrypted titles (sign-out)", async () => {
  const { store, keys } = await pairedStore()
  const sealed = session("ses_reset", { displayDevice: await seal(keys.get("k1"), { sessionId: "ses_reset", slot: "device", keyId: "k1" }, { title: "T" }) })
  let available = true
  const decryptor = new SessionDisplayDecryptor(async (...args) => (available ? trustStoreDisplayKeys(store)(...args) : null))
  assert.equal((await decryptor.settle([sealed]))[0].title, "T")
  available = false
  decryptor.reset()
  assert.equal((await decryptor.settle([sealed]))[0].state, "locked")
})

const projects = [
  { id: "prj_root", connectorId: DEVICE, workspacePath: "/work" },
  { id: "prj_app", connectorId: DEVICE, workspacePath: "/work/app/" },
  { id: "prj_app_web", connectorId: DEVICE, workspacePath: "/work/app/web" },
  { id: "prj_other_device", connectorId: "dev_other", workspacePath: "/work/app/api" },
  { id: "prj_win", connectorId: DEVICE, workspacePath: "C:\\Users\\Me\\Repo\\" },
]

test("project matching: exact path, else the longest containing project on the same device", () => {
  const on = { connectorId: DEVICE }
  assert.equal(matchSessionProject(on, "/work/app", projects)?.id, "prj_app", "exact, trailing slash ignored")
  assert.equal(matchSessionProject(on, "  /work/app/  ", projects)?.id, "prj_app", "trimmed")
  assert.equal(matchSessionProject(on, "/work/app/api", projects)?.id, "prj_app", "the other device's exact project is not used")
  assert.equal(matchSessionProject(on, "/work/app/web/src", projects)?.id, "prj_app_web", "longest prefix")
  assert.equal(matchSessionProject(on, "/work/apple", projects)?.id, "prj_root", "prefix only on path boundaries")
  assert.equal(matchSessionProject(on, "/elsewhere", projects), null, "no project")
  assert.equal(matchSessionProject(on, "/Work/App", projects)?.id, undefined, "POSIX paths are case-sensitive")
  assert.equal(matchSessionProject({ connectorId: "dev_other" }, "/work/app/api/x", projects)?.id, "prj_other_device")
  assert.equal(matchSessionProject({ connectorId: "dev_none" }, "/work/app", projects), null, "other device")
  assert.equal(matchSessionProject(on, "c:\\users\\me\\repo", projects)?.id, "prj_win", "Windows paths ignore case")
  assert.equal(matchSessionProject(on, "C:/Users/me/Repo/sub", projects)?.id, "prj_win", "Windows prefix")
  assert.equal(normalizeWorkspacePath("/"), "/")
  assert.equal(normalizeWorkspacePath("D:\\Code\\\\"), "d:\\code")
})

function displays(map) {
  return (item) => map[item.id] ?? { title: null, cwd: null, preview: null, state: "plain" }
}

test("assignment: each unassigned decrypted session is patched once, failures stay silent", async () => {
  const calls = []
  const logged = []
  let fail = true
  const assigner = new SessionProjectAssigner({
    assign: async (sessionId, projectId) => {
      calls.push([sessionId, projectId])
      if (fail && sessionId === "ses_fail") throw Object.assign(new Error("project_workspace_mismatch"), { status: 422 })
    },
    debug: (message, detail) => logged.push([message, detail]),
  })
  const sessions = [
    session("ses_ok"),
    session("ses_fail"),
    session("ses_assigned", { projectId: "prj_root" }),
    session("ses_plain"),
    session("ses_locked"),
    session("ses_nomatch"),
    session("local:pending"),
  ]
  const display = displays({
    ses_ok: { title: "a", cwd: "/work/app/web", preview: null, state: "decrypted" },
    ses_fail: { title: "b", cwd: "/work/app", preview: null, state: "decrypted" },
    ses_assigned: { title: "c", cwd: "/work/app", preview: null, state: "decrypted" },
    ses_plain: { title: "d", cwd: "/work/app", preview: null, state: "plain" },
    ses_locked: { title: null, cwd: null, preview: null, state: "locked" },
    ses_nomatch: { title: "e", cwd: "/nowhere", preview: null, state: "decrypted" },
    "local:pending": { title: "f", cwd: "/work/app", preview: null, state: "decrypted" },
  })
  await Promise.all(assigner.consider(sessions, projects, display))
  assert.deepEqual(calls, [["ses_ok", "prj_app_web"], ["ses_fail", "prj_app"]])
  assert.equal(logged.length, 1, "the failure is only logged")
  assert.match(logged[0][0], /ses_fail/)

  // Later renders (the patch failed, or the list has not refreshed yet) do not try again in this run.
  fail = false
  await Promise.all(assigner.consider(sessions, projects, display))
  assert.equal(calls.length, 2)

  // A session with no matching project is not used up: a project created later still claims it.
  const withNew = [...projects, { id: "prj_new", connectorId: DEVICE, workspacePath: "/nowhere" }]
  await Promise.all(assigner.consider(sessions, withNew, display))
  assert.deepEqual(calls.at(-1), ["ses_nomatch", "prj_new"])
  assert.equal(calls.length, 3)
})

test("assignment from real decryption: a locked session is assigned once its key arrives", async () => {
  const { store } = await pairedStore("k1", 1)
  const rotated = crypto.getRandomValues(new Uint8Array(32))
  const found = session("ses_found", {
    displayDevice: await seal(rotated, { sessionId: "ses_found", slot: "device", keyId: "k2" }, { title: "Imported", cwd: "/work/app/web/pkg" }),
  })
  const decryptor = new SessionDisplayDecryptor(trustStoreDisplayKeys(store))
  store.onChange(() => decryptor.retryLocked())
  const calls = []
  const assigner = new SessionProjectAssigner({ assign: async (...args) => calls.push(args) })
  await decryptor.settle([found])
  await Promise.all(assigner.consider([found], projects, (item) => decryptor.read(item)))
  assert.deepEqual(calls, [])
  await store.addDirectoryKey({ deviceId: DEVICE, keyId: "k2", epoch: 2, key: b64url(rotated) })
  await decryptor.settle([found])
  await Promise.all(assigner.consider([found], projects, (item) => decryptor.read(item)))
  assert.deepEqual(calls, [["ses_found", "prj_app_web"]])
})
