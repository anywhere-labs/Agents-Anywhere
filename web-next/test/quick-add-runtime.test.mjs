import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve, dirname } from "node:path"
import ts from "typescript"

// Resolve the same source aliases as the app and transpile TypeScript for the
// headless Node runner, including constructor parameter properties in ApiClient.
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
const { quickAddRuntime } = await import("../src/features/dashboard/quick-add-runtime.ts")
hooks.deregister()

const runtimeType = {
  runtimeType: "codex",
  displayName: "Codex",
  defaults: { codexHome: "/custom/home", modelGateway: { url: "https://custom.example" } },
}
const runtime = {
  connectorId: "device",
  runtimeId: "codex",
  runtimeType: "codex",
  name: "Codex",
  displayName: "Codex",
  configured: false,
  active: false,
  status: "stopped",
  config: null,
}

function harness(t, initialRuntimes = []) {
  let inventory = initialRuntimes
  const calls = []
  const updates = []
  t.mock.method(dashboardApi, "getConnectorRuntimes", async () => ({ runtimes: inventory }))
  t.mock.method(dashboardApi, "createConnectorRuntime", async (token, connectorId, payload) => {
    calls.push({ action: "create", token, connectorId, payload })
    const created = { ...runtime, runtimeId: "rti-new", ...payload, configured: true, status: "running" }
    inventory = [...inventory, created]
    return created
  })
  t.mock.method(dashboardApi, "putConnectorRuntimeConfig", async (_token, _connectorId, runtimeId, config) => {
    calls.push({ action: "configure", runtimeId, config })
    const saved = { ...inventory.find((item) => item.runtimeId === runtimeId), config, configured: true }
    inventory = inventory.map((item) => item.runtimeId === runtimeId ? saved : item)
    return saved
  })
  t.mock.method(dashboardApi, "setConnectorRuntimeActive", async (_token, _connectorId, runtimeId, active) => {
    calls.push({ action: "activate", runtimeId, active })
    const started = { ...inventory.find((item) => item.runtimeId === runtimeId), active, status: "running" }
    inventory = inventory.map((item) => item.runtimeId === runtimeId ? started : item)
    return started
  })
  return {
    calls,
    updates,
    setInventory: (value) => { inventory = value },
    add: () => quickAddRuntime({
      token: "session",
      connectorId: "device",
      runtimeType,
      onRuntimeUpdated: (value) => updates.push(value),
    }),
  }
}

test("quick add generates a name and sends empty config without descriptor defaults", async (t) => {
  const h = harness(t)
  const result = await h.add()
  assert.deepEqual(h.calls, [{
    action: "create",
    token: "session",
    connectorId: "device",
    payload: { runtimeType: "codex", name: "Codex", config: {}, active: true },
  }])
  assert.equal(result.active, true)
  assert.deepEqual(h.updates, [result])
})

test("generated Agent names skip names already used on the device", async (t) => {
  const h = harness(t, [
    { ...runtime, runtimeId: "other-1", runtimeType: "claude", name: "Codex", configured: true },
    { ...runtime, runtimeId: "other-2", runtimeType: "claude", name: "Codex 2", configured: true },
  ])
  await h.add()
  assert.equal(h.calls[0].payload.name, "Codex 3")
})

test("quick add configures an existing unconfigured Agent with empty fields, then starts it", async (t) => {
  const h = harness(t, [{ ...runtime, config: { codexHome: "/old/draft" } }])
  await h.add()
  assert.deepEqual(h.calls, [
    { action: "configure", runtimeId: "codex", config: {} },
    { action: "activate", runtimeId: "codex", active: true },
  ])
  assert.equal(h.updates[0].configured, true)
  assert.equal(h.updates[0].active, false)
  assert.equal(h.updates[1].active, true)
})

test("retrying a creation that persisted before startup failed reuses the server instance", async (t) => {
  const h = harness(t)
  let creates = 0
  t.mock.method(dashboardApi, "createConnectorRuntime", async () => {
    creates += 1
    h.setInventory([{ ...runtime, runtimeId: "rti-created", configured: true, active: true, config: {}, status: "error" }])
    throw new Error("start failed")
  })
  await assert.rejects(h.add(), /start failed/)
  assert.deepEqual(h.updates, [])
  const started = await h.add()
  assert.equal(creates, 1)
  assert.equal(started.runtimeId, "rti-created")
  assert.equal(started.status, "running")
  assert.deepEqual(h.calls, [{ action: "activate", runtimeId: "rti-created", active: true }])
})

test("an Agent configured by another client is not recreated or reset by a stale quick-add button", async (t) => {
  const existing = { ...runtime, configured: true, active: true, status: "running", config: { codexHome: "/keep/home" } }
  const h = harness(t, [existing])
  assert.deepEqual(await h.add(), existing)
  assert.deepEqual(h.calls, [])
})

test("a failed config save does not start the Agent or report success", async (t) => {
  const h = harness(t, [runtime])
  t.mock.method(dashboardApi, "putConnectorRuntimeConfig", async () => { throw new Error("config failed") })
  await assert.rejects(h.add(), /config failed/)
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.updates, [])
})
