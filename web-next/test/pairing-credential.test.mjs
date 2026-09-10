import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
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
const { preparePairingCredential } = await import("../src/features/dashboard/pairing-credential.ts")
hooks.deregister()

function credential(name = "My device") {
  return { connector: { id: "existing-device", name }, connectorToken: "test-token" }
}

test("naming a new device creates it once with a trimmed name", async (t) => {
  const result = credential()
  const create = t.mock.method(dashboardApi, "createConnector", async () => result)
  const update = t.mock.method(dashboardApi, "updateConnector", () => assert.fail("new devices are not renamed"))
  assert.equal(await preparePairingCredential("session", "  My device  ", null), result)
  assert.deepEqual(create.mock.calls.map((call) => call.arguments), [["session", "My device"]])
  assert.equal(update.mock.callCount(), 0)
})

test("returning from the method chooser reuses the same device and token", async (t) => {
  const existing = credential()
  t.mock.method(dashboardApi, "createConnector", () => assert.fail("must not create a duplicate device"))
  t.mock.method(dashboardApi, "updateConnector", () => assert.fail("unchanged name needs no update"))
  assert.equal(await preparePairingCredential("session", "  My device ", existing), existing)
})

test("editing the name after going back renames the existing device and preserves its token", async (t) => {
  const existing = credential()
  const renamed = { ...existing.connector, name: "Workstation" }
  t.mock.method(dashboardApi, "createConnector", () => assert.fail("must not create a duplicate device"))
  const update = t.mock.method(dashboardApi, "updateConnector", async () => ({ connector: renamed }))
  const result = await preparePairingCredential("session", " Workstation ", existing)
  assert.deepEqual(update.mock.calls[0].arguments, ["session", existing.connector.id, { name: "Workstation" }])
  assert.deepEqual(result, { connector: renamed, connectorToken: existing.connectorToken })
  assert.equal(existing.connector.name, "My device")
})

test("reconfiguring a device keeps its rotated credential", async (t) => {
  const rotated = { ...credential(), connectorToken: "rotated-test-token", revokedTokenCount: 1 }
  t.mock.method(dashboardApi, "createConnector", () => assert.fail("must reuse the rotated token"))
  assert.equal(await preparePairingCredential("session", rotated.connector.name, rotated), rotated)
})

test("blank names never send a device request", async (t) => {
  t.mock.method(dashboardApi, "createConnector", () => assert.fail("blank names cannot create devices"))
  t.mock.method(dashboardApi, "updateConnector", () => assert.fail("blank names cannot rename devices"))
  await assert.rejects(preparePairingCredential("session", "  ", null), /name is required/)
  await assert.rejects(preparePairingCredential("session", "  ", credential()), /name is required/)
})

test("a failed rename preserves the credential so the user can retry", async (t) => {
  const existing = credential()
  t.mock.method(dashboardApi, "createConnector", () => assert.fail("rename retries must not create devices"))
  const update = t.mock.method(dashboardApi, "updateConnector", async () => { throw new Error("offline") })
  await assert.rejects(preparePairingCredential("session", "Workstation", existing), /offline/)
  assert.deepEqual(existing, credential())
  update.mock.mockImplementation(async () => ({ connector: { ...existing.connector, name: "Workstation" } }))
  assert.equal((await preparePairingCredential("session", "Workstation", existing)).connectorToken, existing.connectorToken)
  assert.equal(update.mock.callCount(), 2)
})
