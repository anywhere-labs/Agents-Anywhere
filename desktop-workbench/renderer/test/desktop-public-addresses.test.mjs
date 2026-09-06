import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

function resolver(file, name, connection, origin = "aa-workbench://web") {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration)
  const code = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return vm.runInNewContext(`${code}\n${name}`, {
    getDesktopServerConnection: () => connection,
    window: origin ? { location: { origin, hostname: new URL(origin).hostname } } : undefined,
    process: { env: {} },
  })
}

const connection = { serverUrl: "https://api.example.test", oauthWebOrigin: "https://web.example.test", apiNamespace: "/api/v2" }

for (const [file, name] of [
  ["components/pair-device-dialog.tsx", "resolvePairingServerUrl"],
  ["components/pages/mobile-signin-panel.tsx", "resolveMobileWebUrl"],
]) {
  test(`${name} uses the selected server in packaged and development Desktop windows`, () => {
    for (const origin of ["aa-workbench://web", "http://localhost:5177", null]) {
      assert.equal(resolver(file, name, connection, origin)(), connection.serverUrl)
    }
    assert.equal(resolver(file, name, null, "https://browser.example.test")(), "https://browser.example.test")
    assert.equal(resolver(file, name, null, null)(), "")
  })
}

test("Desktop service OAuth instructions use the public Web origin instead of the internal renderer URL", () => {
  const file = "components/pages/service-page.tsx"
  assert.equal(resolver(file, "browserPublicUrl", connection)("fallback"), connection.oauthWebOrigin)
  assert.equal(resolver(file, "browserPublicUrl", null, null)("fallback"), "fallback")
})
