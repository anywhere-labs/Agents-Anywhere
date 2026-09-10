import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { normalizeServerOrigin, resolveDesktopServer, type DesktopServerConnection } from "./desktop-server";

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
    tray: null as { destroy: () => void } | null,
    confirmQuit: async () => { calls.push("confirm"); return options.confirm ?? true; },
    mainWindow: options.window === false ? null : {
      isDestroyed: () => false,
      destroy: () => calls.push("destroy-renderer"),
    },
    backend: { shutdown: async () => { calls.push("stop-local-connector"); await options.shutdown?.(); } },
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

test("Windows close hides the window without confirming quit, and reopening restores it", () => {
  const calls: string[] = [];
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {} });
    loadURL = async () => {};
    hide = () => calls.push("hide");
    isDestroyed = () => false;
    isMinimized = () => true;
    restore = () => calls.push("restore");
    show = () => calls.push("show");
    moveTop = () => {};
    focus = () => calls.push("focus");
  }
  const globals = {
    process: { platform: "win32", env: {} },
    app: { isPackaged: true },
    BrowserWindow: Window,
    APP_NAME: "Agents Anywhere",
    path,
    __dirname,
    mainWindow: null,
    devOrigin: null,
    isQuitting: false,
    windowMaterialOptions: () => ({}),
    appWindowIcon: () => "icon.png",
    staticWorkbenchUrl: () => "aa-workbench://web/",
    showDockForWindow: () => {},
    requestQuit: () => assert.fail("Closing the Windows window must not request quit"),
  };
  const { createMainWindow, showMainWindow } = loadFunctions(["createMainWindow", "showMainWindow"], globals);
  const window = createMainWindow(false) as Window;
  window.emit("ready-to-show");
  assert.equal(calls.length, 0, "silent launch leaves the window hidden");
  window.emit("close", { preventDefault: () => calls.push("prevent-close") });
  assert.deepEqual(calls, ["prevent-close", "hide"]);
  showMainWindow();
  assert.deepEqual(calls.slice(2), ["restore", "show", "focus"]);
  calls.length = 0;
  globals.isQuitting = true;
  window.emit("close", { preventDefault: () => assert.fail("Confirmed quit must allow closing") });
  showMainWindow();
  assert.deepEqual(calls, [], "shutdown must not reopen the window");
});

test("Windows tray opens the app, cancels exit, and shuts down only after confirmation", async () => {
  for (const packaged of [false, true]) {
    let confirm = false;
    const fixture = quitFixture();
    const appPath = path.resolve(__dirname, "../..");
    const resourcesPath = path.join(appPath, "test-resources");
    type TrayItem = { label?: string; click?: () => void };
    class TestTray extends EventEmitter {
      menu: TrayItem[] = [];
      constructor(readonly icon: string) { super(); }
      setToolTip = (name: string) => assert.equal(name, "Agents Anywhere");
      setContextMenu = (menu: TrayItem[]) => { this.menu = menu; };
      destroy = () => fixture.calls.push("destroy-tray");
    }
    const globals = Object.assign(fixture.globals, {
      tray: null as TestTray | null,
      process: { platform: "win32", resourcesPath },
      app: { ...fixture.globals.app, isPackaged: packaged, getAppPath: () => appPath },
      path,
      APP_NAME: "Agents Anywhere",
      Tray: TestTray,
      Menu: { buildFromTemplate: (items: TrayItem[]) => items },
      showMainWindow: () => fixture.calls.push("show"),
      confirmQuit: async () => { fixture.calls.push("confirm"); return confirm; },
      requestQuit: fixture.requestQuit,
    });
    const { createWindowsTray } = loadFunctions(["createWindowsTray"], globals);
    createWindowsTray();
    const tray = globals.tray!;
    assert.equal(tray.icon, path.join(packaged ? resourcesPath : appPath, "build", "icon.ico"));
    createWindowsTray();
    assert.equal(globals.tray, tray, "initialization must retain a single tray instance");
    tray.emit("click");
    tray.menu.find((item) => item.label === "打开 Agents Anywhere")!.click!();
    assert.deepEqual(fixture.calls, ["show", "show"]);
    fixture.calls.length = 0;
    const exit = tray.menu.find((item) => item.label === "退出")!.click!;
    exit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fixture.calls, ["confirm"]);
    assert.equal(globals.tray, tray);
    assert.equal(globals.isQuitting, false);
    confirm = true;
    exit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fixture.calls, ["confirm", "confirm", "stop-updates", "destroy-tray", "destroy-renderer", "stop-local-connector", "quit"]);
    assert.equal(globals.tray, null);
  }
});

test("tray quit confirmation stays accessible when the main window is hidden or destroyed", async () => {
  for (const state of ["visible", "hidden", "destroyed", "absent"]) {
    const window = state === "absent" ? null : {
      isDestroyed: () => state === "destroyed",
      isVisible: () => state === "visible",
    };
    const { confirmQuit } = loadFunctions(["confirmQuit"], {
      quitConfirmationPromise: null,
      mainWindow: window,
      dialog: { showMessageBox: async (...args: unknown[]) => {
        assert.equal(args.length, state === "visible" ? 2 : 1);
        if (state === "visible") assert.equal(args[0], window);
        return { response: 0 };
      } },
    });
    assert.equal(await confirmQuit(), false);
  }
});

test("the Windows tray ICO is included in packaged resources", () => {
  const root = path.resolve(__dirname, "../..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const resource = manifest.build.extraResources.find((item: { to: string }) => item.to === "build/icon.ico");
  assert.ok(resource, "the tray icon must be available outside app.asar");
  const icon = fs.readFileSync(path.join(root, resource.from));
  assert.equal(icon.readUInt16LE(2), 1, "the bundled asset must be an ICO");
  assert.ok(icon.readUInt16LE(4) > 0, "the ICO must contain images");
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

test("updates require an authenticated server matching a saved server and never use defaults", () => {
  const server = resolveDesktopServer("https://saved.example");
  let saved: DesktopServerConnection | null = null;
  const calls: Array<DesktopServerConnection | null> = [];
  const { syncDesktopUpdateSession } = loadFunctions(["syncDesktopUpdateSession"], {
    serverStore: { getSaved: () => saved, get: () => assert.fail("Update checks must not use fallback settings") },
    normalizeServerOrigin,
    updates: { check: (connection: DesktopServerConnection | null) => { calls.push(connection); } },
  });
  syncDesktopUpdateSession(server.serverUrl);
  assert.equal(calls.pop(), null, "a missing server record cannot trigger a check");
  saved = server;
  for (const input of [null, undefined, "", "  ", {}, "file:///tmp/server", "https://other.example"]) {
    syncDesktopUpdateSession(input);
    assert.equal(calls.pop(), null, "signed-out and mismatched sessions clear updates");
  }
  syncDesktopUpdateSession(server.serverUrl);
  assert.deepEqual(calls.pop(), server);
});
