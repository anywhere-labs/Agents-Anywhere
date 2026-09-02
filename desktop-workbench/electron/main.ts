import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConnectorSupervisor } from "./connector-supervisor";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopDeviceService } from "./desktop-device-service";
import { DesktopSettingsStore } from "./desktop-settings";
import { ConnectorLogStore } from "./log-store";
import { readShellEnvironment } from "./shell-environment";
import type {
  ConnectorConfigPatch,
  ConnectorLogEntry,
  ConnectorLogQuery,
  DesktopDeviceAuthInput,
  DesktopFactoryResetInput,
  DesktopDeviceNameInput,
  DesktopDeviceProvisionInput,
  DesktopDeviceReconnectInput,
  DesktopSettingsPatch,
} from "./connector-types";

const APP_NAME = "Agents Anywhere Workbench";
const WEB_PROTOCOL = "aa-workbench";
const WEB_HOST = "web";
const DEFAULT_API_ORIGIN = "https://web.agents-anywhere.com";
const DEFAULT_API_NAMESPACE = "/api/v2";
const LOGIN_ITEM_HIDDEN_ARG = "--hidden";
const API_ROUTE_PREFIXES = [
  "/admin",
  "/agents",
  "/auth",
  "/connector",
  "/connectors",
  "/health",
  "/oauth",
  "/pairing",
  "/sessions",
  "/.well-known",
];

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let devOrigin: string | null = null;
let settingsStore: DesktopSettingsStore | null = null;
let bindingStore: DesktopBindingStore | null = null;
let logStore: ConnectorLogStore | null = null;
let connector: ConnectorSupervisor | null = null;
let devices: DesktopDeviceService | null = null;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([
  {
    scheme: WEB_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function webOutDir(): string {
  if (process.env.WORKBENCH_WEB_OUT_DIR?.trim()) {
    return path.resolve(process.env.WORKBENCH_WEB_OUT_DIR.trim());
  }
  return path.resolve(app.getAppPath(), "renderer", "out");
}

function staticWorkbenchUrl(route = "/"): string {
  return `${WEB_PROTOCOL}://${WEB_HOST}${route}`;
}

function apiOrigin(): string {
  return (
    process.env.WORKBENCH_API_ORIGIN ||
    process.env.AGENTS_ANYWHERE_API ||
    DEFAULT_API_ORIGIN
  ).replace(/\/+$/, "");
}

function apiNamespace(): string {
  return normalizeApiNamespace(
    process.env.WORKBENCH_API_NAMESPACE ??
      process.env.AGENTS_ANYWHERE_API_NAMESPACE ??
      DEFAULT_API_NAMESPACE,
  );
}

function normalizeApiNamespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function shouldProxyApiPath(pathname: string): boolean {
  const namespace = apiNamespace();
  if (namespace) return pathname === namespace || pathname.startsWith(`${namespace}/`);
  return API_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function registerStaticWebProtocol(): void {
  protocol.handle(WEB_PROTOCOL, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== WEB_HOST) return new Response("Not found", { status: 404 });

    if (shouldProxyApiPath(url.pathname)) {
      return net.fetch(`${apiOrigin()}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    const outDir = webOutDir();
    const filePath = resolveStaticFile(outDir, url.pathname);
    if (filePath) return net.fetch(pathToFileURL(filePath).toString());
    if (!fs.existsSync(outDir)) {
      return new Response(missingWebBuildHtml(outDir), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  });
}

function resolveStaticFile(outDir: string, pathname: string): string | null {
  const rawPath = decodeURIComponent(pathname);
  const relativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const candidates = [
    path.resolve(outDir, relativePath),
    path.resolve(outDir, relativePath, "index.html"),
    path.resolve(outDir, `${relativePath}.html`),
  ];
  for (const candidate of candidates) {
    if (!isInside(candidate, outDir)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next static-export candidate.
    }
  }
  return null;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function missingWebBuildHtml(outDir: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${APP_NAME}</title>
    <style>
      html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0b; color: #f4f4f5; }
      body { display: grid; place-items: center; }
      main { width: min(560px, calc(100vw - 48px)); line-height: 1.5; }
      code { border: 1px solid #333; border-radius: 6px; background: #171717; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Web workbench build not found</h1>
      <p>Build the web app first, then start this Electron shell.</p>
      <p><code>yarn build:web</code></p>
      <p>Expected output directory: <code>${escapeHtml(outDir)}</code></p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createMainWindow(showOnReady = true): BrowserWindow {
  const devUrl = process.env.WORKBENCH_WEB_URL?.trim();
  devOrigin = devUrl ? new URL(devUrl).origin : null;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    icon: appWindowIcon(),
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 17, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => {
    if (showOnReady) showMainWindow();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWorkbenchUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isWorkbenchUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      appendMainLog({
        level: "ERROR",
        message: `Desktop UI failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`,
      });
    },
  );
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    window.hide();
    hideDockIfIdle();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(devUrl || staticWorkbenchUrl("/"));
  return window;
}

function showMainWindow(): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow(false);
  showDockForWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.moveTop();
  if (process.platform === "darwin") app.focus({ steal: true });
  window.focus();
}

function hideDockIfIdle(): void {
  if (process.platform === "darwin" && !process.env.WORKBENCH_WEB_URL) {
    app.setActivationPolicy("accessory");
  }
}

function showDockForWindow(): void {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy("regular");
  if (app.dock && !app.dock.isVisible()) void app.dock.show();
}

function isWorkbenchUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === `${WEB_PROTOCOL}:` && url.hostname === WEB_HOST) return true;
    return Boolean(devOrigin && url.origin === devOrigin);
  } catch {
    return false;
  }
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isWorkbenchUrl(senderUrl)) {
    throw new Error("Desktop IPC is only available to the Workbench renderer.");
  }
}

function sendToRenderer(channel: string, value?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, value);
}

function connectorDataPath(): string {
  return path.join(app.getPath("userData"), "connector");
}

function connectorLogsPath(): string {
  return path.join(app.getPath("userData"), "logs");
}

function desktopSettingsPath(): string {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function resolveConnectorDir(): string {
  if (process.env.WORKBENCH_CONNECTOR_DIR?.trim()) {
    return path.resolve(process.env.WORKBENCH_CONNECTOR_DIR.trim());
  }
  if (app.isPackaged) return path.join(process.resourcesPath, "connector");
  return path.resolve(app.getAppPath(), "..", "connector");
}

function trayImage() {
  const filename = nativeTheme.shouldUseDarkColors ? "prompt-dark.png" : "prompt-light.png";
  const logoPath = app.isPackaged
    ? path.join(process.resourcesPath, "logo", filename)
    : path.resolve(app.getAppPath(), "..", "logo", filename);
  let image = nativeImage.createFromPath(logoPath);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(app.getAppPath(), "renderer", "public", "icon-192.png"));
  }
  const size = process.platform === "darwin" ? 18 : 16;
  image = image.resize({ width: size, height: size });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function appWindowIcon(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "build", "icon-mac-source.png");
  return path.join(app.getAppPath(), "build", "icon-mac-source.png");
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.on("click", () => showMainWindow());
  updateTray();
}

function updateTray(): void {
  if (!tray) return;
  const state = connector?.publicState();
  const status = state?.status ?? "stopped";
  tray.setImage(trayImage());
  tray.setToolTip(`${APP_NAME}: ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Connector: ${status}`, enabled: false },
      { type: "separator" },
      { label: "Open Agents Anywhere", click: () => showMainWindow() },
      {
        label: "Start Connector",
        enabled: Boolean(state?.hasCredential && !state.running),
        click: () => void connector?.start().catch((error) => appendMainLog({ level: "ERROR", message: errorMessage(error) })),
      },
      {
        label: "Stop Connector",
        enabled: Boolean(state?.running),
        click: () => void connector?.stop().catch((error) => appendMainLog({ level: "ERROR", message: errorMessage(error) })),
      },
      {
        label: "Restart Connector",
        enabled: Boolean(state?.hasCredential),
        click: () => void connector?.restart().catch((error) => appendMainLog({ level: "ERROR", message: errorMessage(error) })),
      },
      { type: "separator" },
      { label: "Quit", click: () => void requestQuit() },
    ]),
  );
}

function launchedAsLoginItem(): boolean {
  const login = app.getLoginItemSettings(loginItemOptions());
  return Boolean(
    login.wasOpenedAtLogin ||
      login.wasOpenedAsHidden ||
      process.argv.includes(LOGIN_ITEM_HIDDEN_ARG) ||
      process.argv.includes("--background") ||
      process.argv.includes("--squirrel-firstrun"),
  );
}

function loginItemOptions(): { path?: string; args?: string[] } {
  if (process.platform !== "win32") return {};
  return {
    path: process.execPath,
    args: settingsStore?.get().silentLaunch ? [LOGIN_ITEM_HIDDEN_ARG] : [],
  };
}

function applyLoginItemSettings(): void {
  const settings = settingsStore?.get();
  if (!settings) return;
  app.setLoginItemSettings({
    openAtLogin: settings.openAtLogin,
    openAsHidden: settings.silentLaunch,
    ...loginItemOptions(),
  });
}

function appendMainLog(entry: string | Partial<ConnectorLogEntry>): void {
  if (!logStore) return;
  const normalized = logStore.append(entry);
  sendToRenderer("workbench:connector:log", normalized);
}

function registerIpcHandlers(): void {
  ipcMain.handle("workbench:openExternal", async (event, url: string) => {
    assertTrustedRenderer(event);
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be opened externally.");
    await shell.openExternal(url);
  });
  ipcMain.handle("workbench:connector:getState", async (event) => {
    assertTrustedRenderer(event);
    return requireConnector().getState();
  });
  ipcMain.handle("workbench:connector:getConfig", (event) => {
    assertTrustedRenderer(event);
    return requireConnector().getPublicConfig();
  });
  ipcMain.handle("workbench:connector:saveConfig", (event, patch: ConnectorConfigPatch) => {
    assertTrustedRenderer(event);
    return requireConnector().saveConfig(patch ?? {});
  });
  ipcMain.handle("workbench:connector:start", (event) => {
    assertTrustedRenderer(event);
    return requireConnector().start();
  });
  ipcMain.handle("workbench:connector:stop", (event) => {
    assertTrustedRenderer(event);
    return requireConnector().stop();
  });
  ipcMain.handle("workbench:connector:restart", (event) => {
    assertTrustedRenderer(event);
    return requireConnector().restart();
  });
  ipcMain.handle("workbench:connector:getLogs", (event, query: ConnectorLogQuery) => {
    assertTrustedRenderer(event);
    return requireLogs().read(query ?? {});
  });
  ipcMain.handle("workbench:connector:clearLogs", (event) => {
    assertTrustedRenderer(event);
    const page = requireLogs().clear();
    sendToRenderer("workbench:connector:logsCleared");
    return page;
  });
  ipcMain.handle("workbench:connector:saveSettings", async (event, patch: DesktopSettingsPatch) => {
    assertTrustedRenderer(event);
    const previous = requireSettings().get();
    const saved = requireSettings().save(patch ?? {});
    try {
      const state = await requireConnector().applySettings(previous);
      applyLoginItemSettings();
      requireLogs().updateSettings(() => requireSettings().get());
      updateTray();
      return state;
    } catch (error) {
      requireSettings().save(previous);
      try {
        await requireConnector().applySettings(saved);
      } catch (rollbackError) {
        appendMainLog({ level: "ERROR", message: `Failed to restore Connector settings: ${errorMessage(rollbackError)}` });
      }
      applyLoginItemSettings();
      requireLogs().updateSettings(() => requireSettings().get());
      throw error;
    }
  });
  ipcMain.handle("workbench:connector:openDataFolder", async (event) => {
    assertTrustedRenderer(event);
    fs.mkdirSync(connectorDataPath(), { recursive: true, mode: 0o700 });
    return shell.openPath(connectorDataPath());
  });
  ipcMain.handle("workbench:connector:openLogsFolder", async (event) => {
    assertTrustedRenderer(event);
    fs.mkdirSync(connectorLogsPath(), { recursive: true, mode: 0o700 });
    return shell.openPath(connectorLogsPath());
  });
  ipcMain.handle("workbench:connector:exportLogs", async (event) => {
    assertTrustedRenderer(event);
    const stamp = new Date().toISOString().slice(0, 10);
    const options = {
      title: "Export Connector logs",
      defaultPath: path.join(app.getPath("documents"), `agents-anywhere-connector-${stamp}.jsonl`),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true, filePath: null, count: 0 };
    const count = requireLogs().exportTo(result.filePath);
    return { canceled: false, filePath: result.filePath, count };
  });
  ipcMain.handle("workbench:connector:factoryReset", async (event, input: DesktopFactoryResetInput) => {
    assertTrustedRenderer(event);
    const forceLocal = input?.forceLocal === true;
    if (requireDevices().getLocalBinding() && !forceLocal) {
      // Server revoke happens first. If it fails, local credentials and binding
      // remain untouched so the user can retry instead of creating an orphan.
      await requireDevices().disconnectLocal({
        userToken: input?.userToken ?? "",
        userId: input?.userId ?? "",
        serverUrl: input?.serverUrl,
      });
    }
    await requireConnector().shutdown();
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    fs.rmSync(connectorDataPath(), { recursive: true, force: true });
    fs.rmSync(connectorLogsPath(), { recursive: true, force: true });
    fs.rmSync(desktopSettingsPath(), { force: true });
    app.relaunch();
    shutdownComplete = true;
    app.exit(0);
  });
  ipcMain.handle("workbench:device:createAndConnect", (event, input: DesktopDeviceProvisionInput) => {
    assertTrustedRenderer(event);
    return requireDevices().createAndConnect(input);
  });
  ipcMain.handle("workbench:device:reconnectAndConnect", (event, input: DesktopDeviceReconnectInput) => {
    assertTrustedRenderer(event);
    return requireDevices().reconnectAndConnect(input);
  });
  ipcMain.handle("workbench:device:disconnectLocal", (event, input: DesktopDeviceAuthInput) => {
    assertTrustedRenderer(event);
    return requireDevices().disconnectLocal(input);
  });
  ipcMain.handle("workbench:device:getLocalBinding", (event) => {
    assertTrustedRenderer(event);
    return requireDevices().getLocalBinding();
  });
  ipcMain.handle("workbench:device:updateLocalBindingName", (event, input: DesktopDeviceNameInput) => {
    assertTrustedRenderer(event);
    return requireDevices().updateLocalBindingName(input?.name ?? "");
  });
}

function requireConnector(): ConnectorSupervisor {
  if (!connector) throw new Error("Connector supervisor is not ready.");
  return connector;
}

function requireDevices(): DesktopDeviceService {
  if (!devices) throw new Error("Desktop device service is not ready.");
  return devices;
}

function requireSettings(): DesktopSettingsStore {
  if (!settingsStore) throw new Error("Desktop settings are not ready.");
  return settingsStore;
}

function requireLogs(): ConnectorLogStore {
  if (!logStore) throw new Error("Connector logs are not ready.");
  return logStore;
}

async function initializeDesktopServices(): Promise<void> {
  const dataPath = connectorDataPath();
  fs.mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  settingsStore = new DesktopSettingsStore(desktopSettingsPath());
  logStore = new ConnectorLogStore(connectorLogsPath(), () => requireSettings().get());
  bindingStore = new DesktopBindingStore(path.join(dataPath, "desktop-binding.json"));
  const shellEnvironment = await readShellEnvironment();
  connector = new ConnectorSupervisor({
    configPath: path.join(dataPath, "connector.json"),
    dataPath,
    connectorDir: resolveConnectorDir(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    homePath: app.getPath("home"),
    shellEnvironment,
    settings: settingsStore,
    binding: bindingStore,
    logs: logStore,
    onState: (state) => {
      sendToRenderer("workbench:connector:state", state);
      updateTray();
    },
    onLog: (entry) => sendToRenderer("workbench:connector:log", entry),
  });
  const config = connector.loadPrivateConfig();
  if (config && !bindingStore.get()) bindingStore.adoptConfig(config);
  connector.bindingChanged();
  devices = new DesktopDeviceService({
    binding: bindingStore,
    connector,
    fetcher: (input, init) => net.fetch(String(input), init),
    defaultServerUrl: apiOrigin,
    apiNamespace,
  });
  applyLoginItemSettings();
}

async function requestQuit(): Promise<void> {
  if (shutdownComplete) {
    app.quit();
    return;
  }
  if (shutdownPromise) return shutdownPromise;
  isQuitting = true;
  shutdownPromise = (async () => {
    try {
      await connector?.shutdown();
    } finally {
      tray?.destroy();
      tray = null;
      shutdownComplete = true;
      app.quit();
    }
  })();
  return shutdownPromise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (hasSingleInstanceLock) {
  registerIpcHandlers();
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerStaticWebProtocol();
    await initializeDesktopServices();
    createTray();
    const settings = requireSettings().get();
    const showOnLaunch = !settings.silentLaunch || !launchedAsLoginItem() || Boolean(process.env.WORKBENCH_WEB_URL);
    createMainWindow(showOnLaunch);
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(appWindowIcon());
    if (!showOnLaunch) hideDockIfIdle();
    nativeTheme.on("updated", updateTray);

    const state = await requireConnector().getState();
    if (settings.startConnectorOnLaunch && state.hasCredential && !state.manualDisconnected) {
      void requireConnector().start().catch((error) => appendMainLog({ level: "ERROR", message: errorMessage(error) }));
    }
  }).catch((error) => {
    console.error("Failed to initialize Desktop Workbench", error);
    void requestQuit();
  });

  app.on("activate", () => showMainWindow());
  app.on("second-instance", () => showMainWindow());
  app.on("window-all-closed", () => {
    // The tray owns the application lifetime. Explicit Quit performs cleanup.
  });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void requestQuit();
  });
}
