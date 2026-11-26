// Agents Anywhere v3 Desktop — main process.
//
// - Serves the bundled web-v3 workbench from `app://aa/` (never a remote URL: the app is a "verified app" in
//   the E2EE model) and proxies control-plane HTTP for it.
// - Supervises the local connector-v3 (Local-First, with its own local meshcall-router) as a background child.
//   Closing the window keeps it running (tray); Quit stops it.
// - Exposes a minimal bridge (`window.aaDesktop`, see `src/preload/preload.ts`): OS-keychain secrets, connector
//   control, settings, openExternal.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, safeStorage, session, shell, Tray, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { IPC, type ConnectorStatus, type RegisterInput } from "../shared/bridge";
import { APP_HOST, APP_ORIGIN, APP_SCHEME, controlProxyTarget, proxyRequest, serveStatic } from "./app-protocol";
import { ConnectorManager } from "./connector-manager";
import { DEEP_LINK_SCHEME, deepLinkFromArgv, deepLinkRoute } from "./deep-link";
import { configPath, connectorDataDir, connectorEntry, iconPath, logDir, webRoot } from "./paths";
import { SecureStore, type SecretCipher } from "./secure-store";
import { SettingsStore } from "./settings-store";
import { loginShellEnv } from "./shell-env";

const APP_NAME = "Agents Anywhere";

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let connectorStopped = false;
let shellEnv: NodeJS.ProcessEnv = { ...process.env };
let pendingRoute: string | null = deepLinkFromArgv(process.argv);
let connector: ConnectorManager;
let settings: SettingsStore;
let secrets: SecureStore;

function readConfig(): { defaultControlUrl: string } {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { defaultControlUrl?: string };
    return { defaultControlUrl: parsed.defaultControlUrl ?? "" };
  } catch {
    return { defaultControlUrl: "" };
  }
}

function keychainCipher(): SecretCipher {
  return {
    isAvailable: async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
      // Linux without a keyring falls back to a hard-coded key: that is not a keychain.
      if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return false;
      return true;
    },
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
  };
}

function appUrl(route = "/"): string {
  return `${APP_ORIGIN}${route.startsWith("/") ? route : `/${route}`}`;
}

function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

function resolveControlUrl(raw: string): string {
  const value = raw.trim();
  if (/^https?:\/\//u.test(value)) return value.replace(/\/+$/u, "");
  return settings.get().controlUrl.replace(/\/+$/u, "");
}

// ── Window ──────────────────────────────────────────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    backgroundColor: "#000000",
    ...(process.platform === "linux" ? { icon: iconPath() } : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (quitting) return;
    // Keep the connector (and its running sessions) alive: closing only hides the window.
    event.preventDefault();
    window.hide();
    if (process.platform === "darwin") app.dock?.hide();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  void window.loadURL(appUrl(pendingRoute ?? "/"));
  pendingRoute = null;
  return window;
}

function showWindow(route?: string): void {
  if (process.platform === "darwin") void app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (route) pendingRoute = route;
    mainWindow = createWindow();
    return;
  }
  if (route) void mainWindow.loadURL(appUrl(route));
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── Tray & menu ─────────────────────────────────────────────────────────────────────────────────────────────────

function connectorLabel(status: ConnectorStatus): string {
  const state = status.connector.state;
  const text: Record<string, string> = { running: "运行中", starting: "启动中", backoff: "等待重启", failed: "已停止（出错）", stopped: "已停止" };
  return `本机 Connector：${text[state] ?? state}${status.registered ? "" : "（未注册）"}`;
}

async function refreshTray(status?: ConnectorStatus): Promise<void> {
  if (!tray) return;
  const s = status ?? (await connector.status());
  const running = s.connector.state === "running" || s.connector.state === "starting" || s.connector.state === "backoff";
  tray.setToolTip(`${APP_NAME} — ${connectorLabel(s)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `打开 ${APP_NAME}`, click: () => showWindow() },
      { type: "separator" },
      { label: connectorLabel(s), enabled: false },
      ...(s.localRouter ? [{ label: `本地 Router：${s.localRouter.url}`, enabled: false }] : []),
      running
        ? { label: "停止 Connector", click: () => void connector.stop() }
        : { label: "启动 Connector", click: () => connector.start() },
      { label: "打开日志目录", click: () => void shell.openPath(logDir()) },
      { type: "separator" },
      { label: `退出 ${APP_NAME}`, click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.on("click", () => {
    if (process.platform !== "darwin") showWindow();
  });
  void refreshTray();
}

function createMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "设置…", accelerator: "Cmd+,", click: () => showWindow("/settings") },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { label: `退出 ${APP_NAME}`, accelerator: "Cmd+Q", click: () => app.quit() },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "关闭窗口", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.close() },
        ...(isMac ? [] : [{ type: "separator" as const }, { label: "退出", click: () => app.quit() }]),
      ],
    },
    { role: "editMenu" },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "帮助",
      submenu: [
        { label: "打开日志目录", click: () => void shell.openPath(logDir()) },
        { label: "打开 Connector 数据目录", click: () => void shell.openPath(connectorDataDir()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Protocol, network, IPC ──────────────────────────────────────────────────────────────────────────────────────

function installProtocol(): void {
  const root = webRoot();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });
    let target: string | null;
    try {
      target = controlProxyTarget(url, settings.get().controlUrl);
    } catch (error) {
      return new Response(JSON.stringify({ code: "bad_proxy", detail: (error as Error).message }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (target) return proxyRequest(request, target, (input, init) => net.fetch(input, init as RequestInit));
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return serveStatic(root, url.pathname);
  });

  // MeshCall Routers refuse cross-origin WebSocket upgrades from origins they don't list; a native client sends
  // no Origin, and neither does this app (its renderer only ever runs the bundled workbench).
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["ws://*/*", "wss://*/*"] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "origin") delete headers[key];
    callback({ requestHeaders: headers });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-sanitized-write" || permission === "notifications" || permission === "fullscreen");
  });
}

function trusted(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url ?? "";
  return isAppUrl(frameUrl);
}

function handle<T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    return fn(...args);
  });
}

function installIpc(): void {
  handle(IPC.secureAvailable, () => secrets.available());
  handle(IPC.secureGet, (key) => secrets.get(key as string));
  handle(IPC.secureSet, (key, value) => secrets.set(key as string, value as string));
  handle(IPC.secureDelete, (key) => secrets.delete(key as string));

  handle(IPC.connectorStatus, () => connector.status());
  handle(IPC.connectorStart, async () => {
    connector.start();
    return connector.status();
  });
  handle(IPC.connectorStop, async () => {
    await connector.stop();
    return connector.status();
  });
  handle(IPC.connectorRegister, (input) => connector.register(input as RegisterInput));
  handle(IPC.connectorPair, (input) => connector.pair((input ?? {}) as { label?: string; ttlSeconds?: number }));
  handle(IPC.connectorLogs, (lines) => connector.logs(typeof lines === "number" ? lines : 200));

  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsSetControlUrl, (url) => settings.update({ controlUrl: String(url ?? "") }));
  handle(IPC.openExternal, async (url) => {
    const value = String(url ?? "");
    if (!/^https?:\/\//u.test(value)) throw new Error("only http(s) links can be opened");
    await shell.openExternal(value);
  });

  connector.on("status", (status: ConnectorStatus) => {
    void refreshTray(status);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.connectorStatusEvent, status);
    }
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────────

function openDeepLink(raw: string): void {
  const route = deepLinkRoute(raw);
  if (route) showWindow(route);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  app.on("second-instance", (_event, argv) => {
    const route = deepLinkFromArgv(argv);
    showWindow(route ?? undefined);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady()) openDeepLink(url);
    else pendingRoute = deepLinkRoute(url) ?? pendingRoute;
  });

  app.whenReady().then(async () => {
    const config = readConfig();
    settings = new SettingsStore(path.join(app.getPath("userData"), "desktop-settings.json"), {
      controlUrl: process.env.AA_DESKTOP_CONTROL_URL || config.defaultControlUrl,
    });
    secrets = new SecureStore(path.join(app.getPath("userData"), "secure-store.json"), keychainCipher());
    connector = new ConnectorManager({
      entry: connectorEntry(),
      execPath: process.execPath,
      dataDir: connectorDataDir(),
      logDir: logDir(),
      env: () => shellEnv,
      resolveControlUrl,
      ...(process.env.AA_DESKTOP_LOCAL_ROUTER_PORT ? { localRouterPort: Number(process.env.AA_DESKTOP_LOCAL_ROUTER_PORT) } : {}),
      ...(process.env.AA_CONNECTOR_PRESETS ? { presetsFile: process.env.AA_CONNECTOR_PRESETS } : {}),
    });

    installProtocol();
    installIpc();
    createMenu();
    createTray();
    mainWindow = createWindow();

    shellEnv = await loginShellEnv();
    if (process.env.AA_DESKTOP_NO_CONNECTOR !== "1") connector.start();
  });

  app.on("activate", () => showWindow());
  // Closing every window keeps the app (and the connector) running in the tray.
  app.on("window-all-closed", () => undefined);

  app.on("before-quit", (event) => {
    quitting = true;
    if (connectorStopped || !connector) return;
    event.preventDefault();
    void connector
      .stop()
      .catch(() => undefined)
      .finally(() => {
        connectorStopped = true;
        app.quit();
      });
  });
}
