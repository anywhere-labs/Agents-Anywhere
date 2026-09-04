import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  protocol,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConnectorSupervisor } from "./connector-supervisor";
import { startDesktopConnectorOnLaunch } from "./desktop-connector-launch";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopDeviceService } from "./desktop-device-service";
import { DesktopSettingsStore } from "./desktop-settings";
import {
  resolveDesktopUpdateRuntimeConfig,
  type DesktopUpdateRuntimeConfig,
} from "./desktop-update-config";
import { DesktopUpdateService } from "./desktop-update-service";
import { ConnectorLogStore } from "./log-store";
import { readJsonFile } from "./json-store";
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
  DesktopNotificationInput,
  DesktopNotificationResult,
  DesktopSettingsPatch,
} from "./connector-types";

const APP_NAME = "Agents Anywhere Workbench";
const APP_ID = "dev.agentsanywhere.workbench";
const WEB_PROTOCOL = "aa-workbench";
const WEB_HOST = "web";
const DEFAULT_API_ORIGIN = "https://web.agents-anywhere.com";
const DEFAULT_API_NAMESPACE = "/api/v2";
const LOGIN_ITEM_HIDDEN_ARG = "--hidden";
const RENDERER_QUIT_CLEANUP_TIMEOUT_MS = 20_000;
const TERMINAL_CLEANUP_ATTEMPT_TIMEOUT_MS = 4_000;
const TERMINAL_CLEANUP_ATTEMPTS = 3;
const TERMINAL_LEASE_RENEW_INTERVAL_MS = 20_000;
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
let devOrigin: string | null = null;
let settingsStore: DesktopSettingsStore | null = null;
let bindingStore: DesktopBindingStore | null = null;
let logStore: ConnectorLogStore | null = null;
let connector: ConnectorSupervisor | null = null;
let devices: DesktopDeviceService | null = null;
let updates: DesktopUpdateService | null = null;
let updateRuntimeConfig: DesktopUpdateRuntimeConfig | null = null;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
let quitConfirmationPromise: Promise<boolean> | null = null;
let quitCleanupRequestSequence = 0;
let terminalLeaseRenewTimer: NodeJS.Timeout | null = null;
const trackedTerminals = new Map<string, TrackedTerminal>();
const latestTerminalTokensByUser = new Map<string, string>();
const activeNotifications = new Set<Notification>();

type TrackedTerminal = {
  connectorId: string;
  terminalId: string;
  userId: string;
  token: string;
  closing: boolean;
  closingPromise?: Promise<void>;
};

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
}

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
  if (!app.isPackaged) {
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      const key = input.key.toLowerCase();
      const isToggleDevToolsShortcut = process.platform === "darwin"
        ? input.meta && input.alt && key === "i"
        : (input.control && input.shift && key === "i") || key === "f12";
      if (!isToggleDevToolsShortcut) return;
      event.preventDefault();
      window.webContents.toggleDevTools();
    });
  }
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
    if (process.platform === "darwin") {
      window.hide();
      return;
    }
    void requestQuit({ confirm: true });
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

function appWindowIcon(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "build", "icon-mac-source.png");
  return path.join(app.getAppPath(), "build", "icon-mac-source.png");
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
  ipcMain.handle("workbench:lifecycle:trackTerminal", (event, input: unknown) => {
    assertTrustedRenderer(event);
    const terminal = parseTrackedTerminal(input);
    latestTerminalTokensByUser.set(terminal.userId, terminal.token);
    trackedTerminals.set(trackedTerminalKey(terminal), terminal);
    startTerminalLeaseRenewal();
    void renewTrackedTerminalLease(terminal).catch(() => undefined);
  });
  ipcMain.handle("workbench:lifecycle:closeTerminal", async (event, input: unknown) => {
    assertTrustedRenderer(event);
    const terminal = parseTrackedTerminal(input, { requireToken: false });
    const tracked = trackedTerminals.get(trackedTerminalKey(terminal));
    if (!tracked) return { handled: false };
    await closeTrackedTerminal(tracked);
    return { handled: true };
  });
  ipcMain.handle("workbench:lifecycle:untrackTerminal", (event, input: unknown) => {
    assertTrustedRenderer(event);
    const terminal = parseTrackedTerminal(input, { requireToken: false });
    trackedTerminals.delete(trackedTerminalKey(terminal));
    if (trackedTerminals.size === 0) stopTerminalLeaseRenewal();
  });
  ipcMain.handle("workbench:lifecycle:updateTerminalAuth", (event, input: unknown) => {
    assertTrustedRenderer(event);
    const auth = parseTerminalAuth(input);
    latestTerminalTokensByUser.set(auth.userId, auth.token);
  });
  ipcMain.handle("workbench:openExternal", async (event, url: string) => {
    assertTrustedRenderer(event);
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be opened externally.");
    await shell.openExternal(url);
  });
  ipcMain.handle("workbench:development:clearCache", async (event) => {
    assertTrustedRenderer(event);
    if (app.isPackaged) throw new Error("Cache clearing is only available in development mode.");
    await event.sender.session.clearCache();
    event.sender.reloadIgnoringCache();
  });
  ipcMain.handle("workbench:updates:getState", (event) => {
    assertTrustedRenderer(event);
    return requireUpdates().getState();
  });
  ipcMain.handle("workbench:updates:checkNow", async (event) => {
    assertTrustedRenderer(event);
    return requireUpdates().checkNow();
  });
  ipcMain.handle("workbench:updates:install", async (event) => {
    assertTrustedRenderer(event);
    return requireUpdates().install();
  });
  ipcMain.handle("workbench:updates:defer", (event) => {
    assertTrustedRenderer(event);
    return requireUpdates().defer();
  });
  ipcMain.handle(
    "workbench:notifications:show",
    (event, input: DesktopNotificationInput): DesktopNotificationResult => {
      assertTrustedRenderer(event);
      if (!requireSettings().get().notificationsEnabled) {
        return { shown: false, reason: "disabled" };
      }
      if (!Notification.isSupported()) {
        return { shown: false, reason: "unsupported" };
      }
      const title = normalizeNotificationText(input?.title, 120);
      const body = normalizeNotificationText(input?.body, 500);
      if (!title || !body) return { shown: false, reason: "invalid" };

      const notification = new Notification({ title, body });
      activeNotifications.add(notification);
      notification.once("close", () => activeNotifications.delete(notification));
      notification.once("click", () => {
        activeNotifications.delete(notification);
        showMainWindow();
        sendToRenderer("workbench:notifications:click", {
          sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
        });
      });
      notification.show();
      return { shown: true };
    },
  );
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
    isQuitting = true;
    updates?.dispose();
    stopTerminalLeaseRenewal();
    await prepareRendererForQuit();
    quiesceRendererForShutdown();
    await closeTrackedTerminals();
    await requireConnector().shutdown();
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    fs.rmSync(connectorDataPath(), { recursive: true, force: true });
    fs.rmSync(connectorLogsPath(), { recursive: true, force: true });
    fs.rmSync(desktopSettingsPath(), { force: true });
    const updateConfig = requireUpdateRuntimeConfig();
    fs.rmSync(updateConfig.statePath, { force: true });
    fs.rmSync(updateConfig.downloadDirectory, { recursive: true, force: true });
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

function normalizeNotificationText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maximumLength);
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

function requireUpdates(): DesktopUpdateService {
  if (!updates) throw new Error("Desktop updates are not ready.");
  return updates;
}

function requireUpdateRuntimeConfig(): DesktopUpdateRuntimeConfig {
  if (!updateRuntimeConfig) throw new Error("Desktop update configuration is not ready.");
  return updateRuntimeConfig;
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
  updateRuntimeConfig = resolveDesktopUpdateRuntimeConfig({
    packaged: app.isPackaged,
    packageMetadata: readJsonFile<unknown>(path.join(app.getAppPath(), "package.json"), null),
    environment: process.env,
    userDataPath: app.getPath("userData"),
    tempPath: app.getPath("temp"),
  });
  const product = requireUpdateRuntimeConfig();
  updates = new DesktopUpdateService({
    currentVersion: product.productVersion,
    currentVersionCode: product.versionCode,
    platform: process.platform,
    apiOrigin,
    apiNamespace,
    statePath: product.statePath,
    downloadDirectory: product.downloadDirectory,
    fetcher: (input, init) => net.fetch(String(input), init),
    openPath: (filePath) => shell.openPath(filePath),
    automaticCheckDelayMs: product.automaticCheckDelayMs,
    allowInsecureHttp: !app.isPackaged,
    onState: (state) => sendToRenderer("workbench:updates:state", state),
    onLog: (message) => appendMainLog({ level: "WARNING", message }),
  });
  applyLoginItemSettings();
}

async function confirmQuit(): Promise<boolean> {
  if (quitConfirmationPromise) return quitConfirmationPromise;
  quitConfirmationPromise = (async () => {
    const options = {
      type: "warning" as const,
      title: "退出 Agents Anywhere？",
      message: "退出 Agents Anywhere？",
      detail: "退出后，本机将离线，其他设备将无法在本机发起 Agent 会话。",
      buttons: ["取消", "退出程序"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  })().finally(() => {
    quitConfirmationPromise = null;
  });
  return quitConfirmationPromise;
}

async function requestQuit({ confirm = false }: { confirm?: boolean } = {}): Promise<void> {
  if (shutdownComplete) {
    app.quit();
    return;
  }
  if (shutdownPromise) return shutdownPromise;
  if (confirm && !(await confirmQuit())) return;
  if (shutdownPromise) return shutdownPromise;
  isQuitting = true;
  updates?.dispose();
  stopTerminalLeaseRenewal();
  shutdownPromise = (async () => {
    try {
      await prepareRendererForQuit();
      quiesceRendererForShutdown();
      await closeTrackedTerminals();
      await connector?.shutdown();
    } finally {
      shutdownComplete = true;
      app.quit();
    }
  })();
  return shutdownPromise;
}

async function closeTrackedTerminals(): Promise<void> {
  const terminals = Array.from(trackedTerminals.values());
  const results = await Promise.allSettled(
    terminals.map(async (terminal) => {
      await closeTrackedTerminal(terminal);
    }),
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const terminal = terminals[index];
    appendMainLog({
      level: "ERROR",
      message: terminal
        ? `Failed to close terminal ${terminal.terminalId} on Connector ${terminal.connectorId} during quit: ${errorMessage(result.reason)}`
        : `Failed to close a terminal during quit: ${errorMessage(result.reason)}`,
    });
  });
}

async function closeTrackedTerminalWithRetry(terminal: TrackedTerminal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TERMINAL_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const token = latestTerminalTokensByUser.get(terminal.userId) ?? terminal.token;
      const response = await net.fetch(
        `${apiOrigin()}${apiNamespace()}/connectors/${encodeURIComponent(terminal.connectorId)}/terminals-v2/${encodeURIComponent(terminal.terminalId)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(TERMINAL_CLEANUP_ATTEMPT_TIMEOUT_MS),
        },
      );
      if (response.ok || response.status === 404) return;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < TERMINAL_CLEANUP_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("Terminal cleanup failed.");
}

function startTerminalLeaseRenewal(): void {
  if (terminalLeaseRenewTimer || isQuitting || trackedTerminals.size === 0) return;
  terminalLeaseRenewTimer = setInterval(() => {
    void renewTrackedTerminalLeases();
  }, TERMINAL_LEASE_RENEW_INTERVAL_MS);
  terminalLeaseRenewTimer.unref();
}

function stopTerminalLeaseRenewal(): void {
  if (!terminalLeaseRenewTimer) return;
  clearInterval(terminalLeaseRenewTimer);
  terminalLeaseRenewTimer = null;
}

async function renewTrackedTerminalLeases(): Promise<void> {
  if (isQuitting) return;
  await Promise.allSettled(
    Array.from(trackedTerminals.values())
      .filter((terminal) => !terminal.closing)
      .map((terminal) => renewTrackedTerminalLease(terminal)),
  );
}

function closeTrackedTerminal(terminal: TrackedTerminal): Promise<void> {
  if (terminal.closingPromise) return terminal.closingPromise;
  terminal.closing = true;
  const key = trackedTerminalKey(terminal);
  const closingPromise = (async () => {
    try {
      await closeTrackedTerminalWithRetry(terminal);
    } catch (error) {
      if (trackedTerminals.get(key) === terminal) {
        terminal.closing = false;
        terminal.closingPromise = undefined;
      }
      throw error;
    }
    if (trackedTerminals.get(key) !== terminal) return;
    trackedTerminals.delete(key);
    if (trackedTerminals.size === 0) stopTerminalLeaseRenewal();
  })();
  terminal.closingPromise = closingPromise;
  return closingPromise;
}

async function renewTrackedTerminalLease(terminal: TrackedTerminal): Promise<void> {
  if (isQuitting || terminal.closing) return;
  const key = trackedTerminalKey(terminal);
  if (trackedTerminals.get(key) !== terminal) return;
  const token = latestTerminalTokensByUser.get(terminal.userId) ?? terminal.token;
  const response = await net.fetch(
    `${apiOrigin()}${apiNamespace()}/connectors/${encodeURIComponent(terminal.connectorId)}/terminals-v2/${encodeURIComponent(terminal.terminalId)}/persistence`,
    {
      method: "PATCH",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ persistent: true }),
      signal: AbortSignal.timeout(TERMINAL_CLEANUP_ATTEMPT_TIMEOUT_MS),
    },
  );
  if (response.status === 404) {
    trackedTerminals.delete(key);
    if (trackedTerminals.size === 0) stopTerminalLeaseRenewal();
    return;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

function trackedTerminalKey(terminal: Pick<TrackedTerminal, "connectorId" | "terminalId">): string {
  return `${terminal.connectorId}:${terminal.terminalId}`;
}

function parseTrackedTerminal(
  input: unknown,
  options: { requireToken?: boolean } = {},
): TrackedTerminal {
  if (!input || typeof input !== "object") throw new Error("Terminal registration is required.");
  const value = input as Partial<TrackedTerminal>;
  const connectorId = typeof value.connectorId === "string" ? value.connectorId.trim() : "";
  const terminalId = typeof value.terminalId === "string" ? value.terminalId.trim() : "";
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (
    !connectorId ||
    !terminalId ||
    (options.requireToken !== false && (!userId || !token))
  ) {
    throw new Error("Terminal registration is invalid.");
  }
  return { connectorId, terminalId, userId, token, closing: false };
}

function parseTerminalAuth(input: unknown): Pick<TrackedTerminal, "userId" | "token"> {
  if (!input || typeof input !== "object") throw new Error("Terminal auth is required.");
  const value = input as Partial<TrackedTerminal>;
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!userId || !token) throw new Error("Terminal auth is invalid.");
  return { userId, token };
}

function quiesceRendererForShutdown(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  window.destroy();
}

async function prepareRendererForQuit(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;

  quitCleanupRequestSequence += 1;
  const requestId = quitCleanupRequestSequence;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ipcMain.removeListener("workbench:lifecycle:quitReady", handleReady);
      resolve();
    };
    const handleReady = (event: IpcMainEvent, input: { requestId?: number }) => {
      if (event.sender !== window.webContents || input?.requestId !== requestId) return;
      finish();
    };
    ipcMain.on("workbench:lifecycle:quitReady", handleReady);
    timer = setTimeout(finish, RENDERER_QUIT_CLEANUP_TIMEOUT_MS);
    window.webContents.send("workbench:lifecycle:beforeQuit", { requestId });
  });
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
    const settings = requireSettings().get();
    const showOnLaunch = !settings.silentLaunch || !launchedAsLoginItem() || Boolean(process.env.WORKBENCH_WEB_URL);
    const updateStartup = requireUpdates().start();
    createMainWindow(showOnLaunch);
    if (process.platform === "darwin" && app.dock) app.dock.setIcon(appWindowIcon());
    if (!showOnLaunch) hideDockIfIdle();

    const updateState = await updateStartup;
    if (updateState.forced) showMainWindow();
    await startDesktopConnectorOnLaunch({
      updateForced: updateState.forced,
      enabled: settings.startConnectorOnLaunch,
      getState: () => requireConnector().getState(),
      start: () => requireConnector().start(),
      onStartError: (error) => appendMainLog({ level: "ERROR", message: errorMessage(error) }),
    });
  }).catch((error) => {
    console.error("Failed to initialize Desktop Workbench", error);
    void requestQuit();
  });

  app.on("activate", () => showMainWindow());
  app.on("second-instance", () => showMainWindow());
  app.on("window-all-closed", () => {
    // Connector cleanup is handled by the explicit quit flow.
  });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void requestQuit({ confirm: true });
  });
}
