import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve, dirname } from "node:path"
import ts from "typescript"

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url))
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : ""
    if (specifier.startsWith("@/") || (parent.startsWith(sourceRoot) && specifier.startsWith("."))) {
      const base = specifier.startsWith("@/") ? resolve(sourceRoot, specifier.slice(2)) : resolve(dirname(parent), specifier)
      const found = [base, `${base}.ts`, `${base}/index.ts`].find((path) => existsSync(path) && path.endsWith(".ts"))
      if (found) return { url: pathToFileURL(found).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith(".ts")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText }
    }
    return nextLoad(url, context)
  },
})
const { dashboardApi } = await import("../src/features/dashboard/api.ts")
const { ApiError } = await import("../src/lib/api/errors.ts")
const { watchPairingConnector } = await import("../src/features/dashboard/pairing-watcher.ts")
hooks.deregister()

function harness(t, load) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const calls = []
  const online = []
  const unavailable = []
  t.mock.method(dashboardApi, "getConnector", (token, id) => {
    calls.push({ token, id })
    return load(id)
  })
  return {
    calls, online, unavailable,
    watch(connectorId) {
      const dispose = watchPairingConnector({
        token: "session", connectorId,
        onOnline: (connector) => online.push(connector),
        onUnavailable: (id) => unavailable.push(id),
      })
      t.after(dispose)
      return dispose
    },
    async advance(ms) {
      t.mock.timers.tick(ms)
      await Promise.resolve()
    },
  }
}

test("a delayed Linux connection prompts once using the actual online device name", async (t) => {
  let connector = { id: "linux", name: "pending-name", status: "offline" }
  const h = harness(t, async () => ({ connector }))
  h.watch("linux")
  await h.advance(1500)
  await h.advance(2000)
  assert.deepEqual(h.online, [])

  connector = { ...connector, name: "Linux workstation", status: "online" }
  await h.advance(2000)
  assert.deepEqual(h.online, [connector])
  await h.advance(60000)
  assert.equal(h.online.length, 1)
  assert.equal(h.calls.length, 3)
  assert.ok(h.calls.every((call) => call.token === "session" && call.id === "linux"))
})

test("temporary network and server errors do not lose a pending pairing", async (t) => {
  const responses = [0, 503, 429, 409, null]
  const h = harness(t, async () => {
    const status = responses.shift()
    if (status !== null) throw new ApiError({ status, detail: "not ready", kind: "http" })
    return { connector: { id: "linux", name: "Linux", status: "online" } }
  })
  h.watch("linux")
  await h.advance(1500)
  for (let attempt = 0; attempt < 4; attempt += 1) await h.advance(3000)
  assert.equal(h.online.length, 1)
  assert.deepEqual(h.unavailable, [])
})

test("a second pairing can finish while the first device is still offline", async (t) => {
  const h = harness(t, async (id) => ({ connector: { id, name: id, status: id === "second" ? "online" : "offline" } }))
  h.watch("first")
  h.watch("second")
  await h.advance(1500)
  assert.deepEqual(h.online.map((connector) => connector.id), ["second"])
  await h.advance(2000)
  assert.equal(h.calls.filter((call) => call.id === "first").length, 2)
  assert.equal(h.calls.filter((call) => call.id === "second").length, 1)
})

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} removes a pairing that can no longer be completed`, async (t) => {
    const h = harness(t, async () => { throw new ApiError({ status, detail: "unavailable", kind: "http" }) })
    h.watch("linux")
    await h.advance(1500)
    await h.advance(60000)
    assert.deepEqual(h.unavailable, ["linux"])
    assert.deepEqual(h.online, [])
    assert.equal(h.calls.length, 1)
  })
}

test("app teardown prevents an in-flight response from opening a stale prompt", async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => { resolveResponse = resolve })
  const h = harness(t, () => response)
  const dispose = h.watch("linux")
  await h.advance(1500)
  dispose()
  resolveResponse({ connector: { id: "linux", name: "Linux", status: "online" } })
  await h.advance(60000)
  assert.deepEqual(h.online, [])
  assert.equal(h.calls.length, 1)
})

test("app teardown cancels retries even if an in-flight request fails later", async (t) => {
  let rejectResponse
  const response = new Promise((_resolve, reject) => { rejectResponse = reject })
  const h = harness(t, () => response)
  const dispose = h.watch("linux")
  await h.advance(1500)
  dispose()
  rejectResponse(new Error("network interrupted"))
  await h.advance(60000)
  assert.deepEqual(h.online, [])
  assert.deepEqual(h.unavailable, [])
  assert.equal(h.calls.length, 1)
})

test("a slow status request does not start overlapping polls", async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => { resolveResponse = resolve })
  const h = harness(t, () => response)
  h.watch("linux")
  await h.advance(1500)
  await h.advance(60000)
  assert.equal(h.calls.length, 1)
  resolveResponse({ connector: { id: "linux", name: "Linux", status: "online" } })
  await h.advance(0)
  assert.equal(h.online.length, 1)
})
