import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function loginFixture(platform: string) {
  const windows: LoginWindow[] = [];
  class LoginWindow extends EventEmitter {
    closed = false;
    styles: string[] = [];
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => {},
      insertCSS: async (css: string) => { this.styles.push(css); return "style"; },
    });
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super();
      windows.push(this);
    }
    isDestroyed() { return this.closed; }
    destroy() { this.closed = true; }
    close() { this.closed = true; }
    show() {}
    setTitle() {}
    async loadURL() { this.webContents.emit("dom-ready"); }
  }
  const source = fs.readFileSync(path.resolve(__dirname, "../../electron/development-login.ts"), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {} as {
    openDevelopmentLoginWindow: (options: { parent: null; authorizeUrl: string; onCallback: (url: string) => void }) => Promise<string>;
  };
  vm.runInNewContext(javascript, {
    exports,
    process: { platform },
    URL,
    console,
    require: (name: string) => {
      if (name === "electron") return { BrowserWindow: LoginWindow };
      if (name === "./desktop-oauth") return { DESKTOP_OAUTH_PROTOCOL: "agents-anywhere-desktop" };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { windows, open: exports.openDevelopmentLoginWindow };
}

test("Windows login hides native branding while retaining controls, dragging and sandboxing", async () => {
  const fixture = loginFixture("win32");
  const callbacks: string[] = [];
  await fixture.open({ parent: null, authorizeUrl: "https://example.com/authorize", onCallback: url => callbacks.push(url) });
  const window = fixture.windows[0];
  assert.equal(window.options.titleBarStyle, "hidden");
  assert.equal((window.options.titleBarOverlay as Electron.TitleBarOverlay).height, 32);
  assert.equal(window.options.webPreferences?.sandbox, true);
  assert.equal(window.options.webPreferences?.nodeIntegration, false);
  assert.match(window.styles[0], /-webkit-app-region: drag/);
  assert.match(window.styles[0], /padding-top: 32px/);
  assert.match(window.styles[0], /titlebar-area-width/);
  window.webContents.emit("dom-ready");
  assert.equal(window.styles.length, 2);
  const callbackUrl = "agents-anywhere-desktop://callback?code=test";
  let prevented = false;
  window.webContents.emit("will-redirect", { preventDefault: () => { prevented = true; } }, callbackUrl);
  assert.equal(prevented, true);
  assert.deepEqual(callbacks, [callbackUrl]);
  assert.equal(window.closed, true);
});

test("other platforms retain their existing login title bar", async () => {
  for (const platform of ["darwin", "linux"]) {
    const fixture = loginFixture(platform);
    await fixture.open({ parent: null, authorizeUrl: "https://example.com/authorize", onCallback() {} });
    const window = fixture.windows[0];
    assert.equal(window.options.titleBarStyle, "default");
    assert.equal(window.options.titleBarOverlay, undefined);
    assert.equal(window.styles.length, 0);
  }
});
