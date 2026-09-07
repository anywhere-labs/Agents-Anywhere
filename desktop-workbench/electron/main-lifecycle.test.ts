import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual Main entrypoint functions without loading Electron or
// starting a Connector. Any new shutdown side effects must be accounted for.
const source = ts.createSourceFile(
  "main.ts",
  fs.readFileSync(path.resolve(__dirname, "../../electron/main.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
function loadFunctions(names: string[], globals: Record<string, unknown>) {
  const code = source.statements
    .filter((statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""))
    .map((statement) => statement.getText(source))
    .join("\n");
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${javascript}\n({${names.join(",")}})`, globals);
}

function quitFixture(options: { confirm?: boolean; shutdown?: () => Promise<void>; window?: boolean } = {}) {
  const calls: string[] = [];
  const globals = {
    isQuitting: false,
    shutdownComplete: false,
    shutdownPromise: null,
    confirmQuit: async () => { calls.push("confirm"); return options.confirm ?? true; },
    mainWindow: options.window === false ? null : {
      isDestroyed: () => false,
      destroy: () => calls.push("destroy-renderer"),
    },
    connector: { shutdown: async () => { calls.push("stop-local-connector"); await options.shutdown?.(); } },
    updates: { dispose: () => calls.push("stop-updates") },
    app: { quit: () => calls.push("quit") },
    net: { fetch: () => assert.fail("Desktop quit must not close or renew terminals through the API") },
  };
  const { requestQuit } = loadFunctions(["requestQuit", "quiesceRendererForShutdown"], globals) as {
    requestQuit: (options?: { confirm?: boolean }) => Promise<void>;
  };
  return { calls, globals, requestQuit };
}

test("quit stops the owned local Connector without closing or renewing remote terminals", async () => {
  const fixture = quitFixture();
  await fixture.requestQuit();
  assert.deepEqual(fixture.calls, ["stop-updates", "destroy-renderer", "stop-local-connector", "quit"]);
  assert.equal(fixture.globals.shutdownComplete, true);
});

test("repeated quit requests wait for the same local Connector shutdown", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = quitFixture({ shutdown: () => pending });
  const first = fixture.requestQuit();
  const second = fixture.requestQuit();
  assert.deepEqual(fixture.calls, ["stop-updates", "destroy-renderer", "stop-local-connector"]);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(fixture.calls, ["stop-updates", "destroy-renderer", "stop-local-connector", "quit"]);
});

test("cancelling native quit leaves the renderer and Connector running", async () => {
  const fixture = quitFixture({ confirm: false });
  await fixture.requestQuit({ confirm: true });
  assert.deepEqual(fixture.calls, ["confirm"]);
  assert.equal(fixture.globals.isQuitting, false);
});

test("quit still completes if the window is already gone or local shutdown fails", async () => {
  const fixture = quitFixture({ window: false, shutdown: async () => { throw new Error("already stopped"); } });
  await assert.rejects(fixture.requestQuit(), /already stopped/);
  assert.deepEqual(fixture.calls, ["stop-updates", "stop-local-connector", "quit"]);
  assert.equal(fixture.globals.shutdownComplete, true);
});

test("project API requests reach the Desktop proxy even with an empty API namespace", () => {
  const declaration = source.statements.find((statement) =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.name.getText(source) === "API_ROUTE_PREFIXES"),
  );
  assert.ok(declaration);
  const prefixes = vm.runInNewContext(`${declaration.getText(source)}\nAPI_ROUTE_PREFIXES`);
  for (const namespace of ["", "/api/v2"]) {
    const { shouldProxyApiPath } = loadFunctions(["shouldProxyApiPath"], { API_ROUTE_PREFIXES: prefixes, apiNamespace: () => namespace });
    assert.equal(shouldProxyApiPath(`${namespace}/projects`), true);
    assert.equal(shouldProxyApiPath(`${namespace}/projects/project-id/sessions`), true);
    assert.equal(shouldProxyApiPath("/projects-help.html"), false);
    assert.equal(shouldProxyApiPath("/_next/static/app.js"), false);
  }
});
