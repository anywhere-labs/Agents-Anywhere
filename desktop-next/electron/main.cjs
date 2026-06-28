const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, net, protocol, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");

const APP_NAME = "Agents Anywhere Connector";
const DEFAULT_LOG_CHUNK_SIZE_KB = 512;
const DEFAULT_LOG_RETAIN_CHUNKS = 20;
const DEFAULT_LOG_RETENTION_DAYS = 14;
const DEFAULT_LOG_PAGE_SIZE = 100;
const isDev = Boolean(process.env.NEXT_DEV_SERVER_URL);
const APP_PROTOCOL = "app";
const APP_HOST = "desktop";

app.setName(APP_NAME);
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

let mainWindow = null;
let tray = null;
let rpcProcess = null;
let rpcProcessGroupPid = null;
let rpcReader = null;
let nextRequestId = 1;
let nextLogSeq = 1;
let pending = new Map();

const state = {
  platform: process.platform,
  status: "stopped",
  running: false,
  pairing: false,
  authFailed: false,
  lastError: null,
  hasConfig: false,
  serverUrl: "",
  configPath: "",
  settingsPath: "",
  connectorDir: "",
  uvPath: "",
  locale: "system",
  appearance: "system",
  usingTemporaryCredential: false,
  logPath: "",
  logChunkSizeKb: DEFAULT_LOG_CHUNK_SIZE_KB,
  logRetainChunks: DEFAULT_LOG_RETAIN_CHUNKS,
  logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
  openAtLogin: false,
  startConnectorOnLaunch: false,
};

function userDataPath(name) {
  return path.join(app.getPath("userData"), name);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function exportedAppDir() {
  return path.resolve(__dirname, "..", "out");
}

function exportedAppUrl(route = "/") {
  return `${APP_PROTOCOL}://${APP_HOST}${route}`;
}

function registerExportedAppProtocol() {
  if (isDev) return;
  protocol.handle(APP_PROTOCOL, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) return new Response("Not found", { status: 404 });

    const rawPath = decodeURIComponent(url.pathname);
    const relativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
    const filePath = path.resolve(exportedAppDir(), relativePath);
    const appDir = exportedAppDir();

    if (filePath !== appDir && !filePath.startsWith(`${appDir}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function clampNumber(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, Math.round(next)));
}

function defaultPathEntries() {
  const entries = [];
  if (process.env.PATH) entries.push(...process.env.PATH.split(path.delimiter));
  if (process.platform === "darwin") {
    entries.push(
      path.join(app.getPath("home"), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    );
  }
  return [...new Set(entries.filter(Boolean))];
}

function resolveExecutablePath(command) {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) return "";
  if (path.isAbsolute(trimmed)) return trimmed;
  for (const entry of defaultPathEntries()) {
    const candidate = path.join(entry, trimmed);
    if (fs.existsSync(candidate)) return candidate;
    if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe") && fs.existsSync(`${candidate}.exe`)) {
      return `${candidate}.exe`;
    }
  }
  return "";
}

function defaultUvPath() {
  return resolveExecutablePath(process.platform === "win32" ? "uv.exe" : "uv");
}

function connectorEnv() {
  return {
    ...process.env,
    PATH: defaultPathEntries().join(path.delimiter),
    PYTHONUNBUFFERED: "1",
    FORCE_COLOR: "0",
  };
}

function resolveConnectorDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "connector");
  return path.resolve(__dirname, "..", "..", "connector");
}

function resolveLogoPath(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, "logo", name);
  return path.resolve(__dirname, "..", "..", "logo", name);
}

function resolveBuildAssetPath(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, "build", name);
  return path.resolve(__dirname, "..", "build", name);
}

function appIconPath() {
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolveBuildAssetPath("icon-mac-source.png");
  }
  return resolveLogoPath(nativeTheme.shouldUseDarkColors ? "icon-dark.png" : "icon-light.png");
}

function promptIcon(size) {
  const image = nativeImage.createFromPath(resolveLogoPath(nativeTheme.shouldUseDarkColors ? "prompt-dark.png" : "prompt-light.png"));
  if (image.isEmpty()) return nativeImage.createEmpty();
  return size ? image.resize({ width: size, height: size }) : image;
}

function trayIcon() {
  return promptIcon(process.platform === "darwin" ? 18 : 16);
}

function loadDesktopSettings() {
  const settings = readJson(state.settingsPath, {});
  state.uvPath = resolveExecutablePath(settings.uvPath) || resolveExecutablePath(settings.uvCommand) || defaultUvPath();
  if (typeof settings.locale === "string" && ["system", "en", "zh"].includes(settings.locale)) state.locale = settings.locale;
  if (typeof settings.appearance === "string" && ["system", "light", "dark"].includes(settings.appearance)) state.appearance = settings.appearance;
  state.logChunkSizeKb = clampNumber(settings.logChunkSizeKb, DEFAULT_LOG_CHUNK_SIZE_KB, 64, 10240);
  state.logRetainChunks = clampNumber(settings.logRetainChunks, DEFAULT_LOG_RETAIN_CHUNKS, 1, 200);
  state.logRetentionDays = clampNumber(settings.logRetentionDays, DEFAULT_LOG_RETENTION_DAYS, 1, 365);
  if (typeof settings.startConnectorOnLaunch === "boolean") state.startConnectorOnLaunch = settings.startConnectorOnLaunch;
  state.openAtLogin = app.getLoginItemSettings().openAtLogin;
  pruneLogChunks();
}

function saveDesktopSettings(next = {}) {
  if (typeof next.uvPath === "string") state.uvPath = resolveExecutablePath(next.uvPath) || next.uvPath.trim();
  if (typeof next.locale === "string" && ["system", "en", "zh"].includes(next.locale)) state.locale = next.locale;
  if (typeof next.appearance === "string" && ["system", "light", "dark"].includes(next.appearance)) state.appearance = next.appearance;
  if (next.logChunkSizeKb != null) state.logChunkSizeKb = clampNumber(next.logChunkSizeKb, state.logChunkSizeKb, 64, 10240);
  if (next.logRetainChunks != null) state.logRetainChunks = clampNumber(next.logRetainChunks, state.logRetainChunks, 1, 200);
  if (next.logRetentionDays != null) state.logRetentionDays = clampNumber(next.logRetentionDays, state.logRetentionDays, 1, 365);
  if (typeof next.startConnectorOnLaunch === "boolean") state.startConnectorOnLaunch = next.startConnectorOnLaunch;
  if (typeof next.openAtLogin === "boolean") {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, openAsHidden: true });
    state.openAtLogin = next.openAtLogin;
  }
  writeJson(state.settingsPath, {
    uvPath: state.uvPath,
    locale: state.locale,
    appearance: state.appearance,
    logChunkSizeKb: state.logChunkSizeKb,
    logRetainChunks: state.logRetainChunks,
    logRetentionDays: state.logRetentionDays,
    startConnectorOnLaunch: state.startConnectorOnLaunch,
  });
  pruneLogChunks();
  const nextState = publicState();
  sendToWindow("connector:state", nextState);
  return nextState;
}

function publicState() {
  return { ...state };
}

function appendLog(entry) {
  const log = typeof entry === "string" ? { level: "INFO", message: entry, time: new Date().toISOString() } : entry;
  if (!log.time) log.time = new Date().toISOString();
  if (!Number.isInteger(log.seq)) log.seq = nextLogSeq++;
  writeLogEntry(log);
  sendToWindow("connector:log", log);
}

function logDir() {
  return state.logPath || userDataPath("logs");
}

function logChunkPrefix() {
  return "connector-";
}

function logChunkFiles() {
  try {
    return fs.readdirSync(logDir())
      .filter((name) => name.startsWith(logChunkPrefix()) && name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(logDir(), name));
  } catch {
    return [];
  }
}

function initLogSeq() {
  let maxSeq = 0;
  for (const row of readAllLogRows()) {
    if (Number.isInteger(row.seq)) maxSeq = Math.max(maxSeq, row.seq);
  }
  nextLogSeq = maxSeq + 1;
}

function activeLogChunkPath() {
  fs.mkdirSync(logDir(), { recursive: true });
  const files = logChunkFiles();
  const latest = files.at(-1);
  const maxBytes = state.logChunkSizeKb * 1024;
  if (latest) {
    try {
      if (fs.statSync(latest).size < maxBytes) return latest;
    } catch {
      // Create a new chunk below.
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(logDir(), `${logChunkPrefix()}${stamp}.jsonl`);
}

function writeLogEntry(log) {
  try {
    fs.appendFileSync(activeLogChunkPath(), `${JSON.stringify(log)}\n`, "utf8");
    pruneLogChunks();
  } catch (error) {
    console.error("Failed to write connector log", error);
  }
}

function pruneLogChunks() {
  const files = logChunkFiles();
  const now = Date.now();
  const maxAgeMs = state.logRetentionDays * 24 * 60 * 60 * 1000;
  const removable = new Set();
  files.forEach((file) => {
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > maxAgeMs) removable.add(file);
    } catch {
      removable.add(file);
    }
  });
  files.slice(0, Math.max(0, files.length - state.logRetainChunks)).forEach((file) => removable.add(file));
  removable.forEach((file) => {
    try {
      fs.unlinkSync(file);
    } catch {
      // Ignore cleanup failures; logging must not break the connector.
    }
  });
}

function readAllLogRows() {
  const files = logChunkFiles();
  const rows = [];
  let fallbackSeq = 1;
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (!text) continue;
      for (const line of text.split(/\r?\n/)) {
        try {
          const row = JSON.parse(line);
          if (!Number.isInteger(row.seq)) row.seq = fallbackSeq;
          fallbackSeq = Math.max(fallbackSeq + 1, row.seq + 1);
          rows.push(row);
        } catch {
          rows.push({ seq: fallbackSeq++, level: "WARNING", message: line, time: new Date(fs.statSync(file).mtimeMs).toISOString() });
        }
      }
    } catch {
      // Skip unreadable chunks.
    }
  }
  return rows.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
}

function readLogPage(options = {}) {
  const pageSize = clampNumber(options.pageSize, DEFAULT_LOG_PAGE_SIZE, 20, 5000);
  const rows = readAllLogRows();
  let windowRows;
  if (Number.isInteger(options.afterSeq)) {
    windowRows = rows.filter((row) => Number(row.seq || 0) > options.afterSeq).slice(-pageSize);
  } else if (Number.isInteger(options.beforeSeq)) {
    windowRows = rows.filter((row) => Number(row.seq || 0) < options.beforeSeq).slice(-pageSize);
  } else {
    windowRows = rows.slice(-pageSize);
  }
  const firstSeq = rows[0]?.seq ?? null;
  const lastSeq = rows.at(-1)?.seq ?? null;
  return {
    items: windowRows,
    firstSeq,
    lastSeq,
    hasMoreBefore: windowRows.length > 0 && firstSeq != null && Number(windowRows[0].seq) > Number(firstSeq),
    total: rows.length,
  };
}

function clearLogFiles() {
  for (const file of logChunkFiles()) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Ignore per-file cleanup failures.
    }
  }
  sendToWindow("connector:logsCleared", null);
  return readLogPage();
}

function appendStderrLog(chunk) {
  const text = chunk.toString().trimEnd();
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    appendLog(parseStderrLogLine(line));
  }
}

function parseStderrLogLine(line) {
  const match = line.match(/\|\s*(TRACE|DEBUG|INFO|SUCCESS|WARNING|ERROR|CRITICAL)\s*\|/);
  return {
    level: match ? match[1] : "ERROR",
    message: line,
    time: new Date().toISOString(),
  };
}

function mergeConnectorState(next) {
  Object.assign(state, next);
  updateTrayMenu();
  sendToWindow("connector:state", publicState());
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startRpcProcess() {
  if (rpcProcess) return;
  if (!fs.existsSync(path.join(state.connectorDir, "pyproject.toml"))) {
    appendLog({ level: "ERROR", message: `Connector source is missing pyproject.toml: ${state.connectorDir}`, time: new Date().toISOString() });
    return;
  }

  const args = ["run", "--project", state.connectorDir, "anywhere-cli", "rpc", "--config", state.configPath];
  const uvPath = resolveExecutablePath(state.uvPath);
  if (!uvPath || !path.isAbsolute(uvPath)) {
    appendLog({ level: "ERROR", message: "uv executable path is not configured.", time: new Date().toISOString() });
    return;
  }
  state.uvPath = uvPath;
  rpcProcess = spawn(uvPath, args, {
    cwd: state.connectorDir,
    env: connectorEnv(),
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  rpcProcessGroupPid = process.platform === "win32" ? null : rpcProcess.pid;
  appendLog(`Starting connector RPC with ${uvPath} run --project ${state.connectorDir}`);

  rpcReader = readline.createInterface({ input: rpcProcess.stdout });
  rpcReader.on("line", handleRpcLine);
  rpcProcess.stderr.on("data", appendStderrLog);
  rpcProcess.on("error", (error) => {
    appendLog({ level: "ERROR", message: `Connector RPC failed to start: ${error.message}`, time: new Date().toISOString() });
    rejectAllPending(error);
    rpcProcess = null;
    rpcProcessGroupPid = null;
  });
  rpcProcess.on("exit", (code, signal) => {
    appendLog(`Connector RPC exited${signal ? ` by ${signal}` : ""} with code ${code ?? "null"}`);
    rejectAllPending(new Error("Connector RPC exited"));
    rpcProcess = null;
    rpcProcessGroupPid = null;
    rpcReader = null;
    mergeConnectorState({ status: "stopped", running: false, pairing: false });
  });
}

function stopRpcProcess() {
  if (!rpcProcess) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(rpcProcess.pid), "/t", "/f"], { windowsHide: true });
  } else {
    const pid = rpcProcessGroupPid || rpcProcess.pid;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      rpcProcess.kill("SIGTERM");
    }
  }
}

function handleRpcLine(line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    appendLog({ level: "WARNING", message: `Connector RPC emitted non-json line: ${line}`, time: new Date().toISOString() });
    return;
  }

  if (payload.id != null && pending.has(payload.id)) {
    const { resolve, reject } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) reject(new Error(payload.error.message || "Connector RPC error"));
    else resolve(payload.result);
    return;
  }

  if (payload.method === "connector/state") {
    mergeConnectorState(payload.params || {});
    return;
  }
  if (payload.method === "connector/log") {
    appendLog(payload.params || {});
    return;
  }
  if (payload.method === "connector/pairing") {
    if (payload.params && typeof payload.params.status === "string") {
      state.pairing = payload.params.status === "starting" || payload.params.status === "waiting";
    }
    sendToWindow("connector:pairing", payload.params || {});
    return;
  }
}

function rejectAllPending(error) {
  for (const { reject } of pending.values()) reject(error);
  pending = new Map();
}

function rpcRequest(method, params) {
  startRpcProcess();
  if (!rpcProcess || !rpcProcess.stdin) return Promise.reject(new Error("Connector RPC is not available."));
  const id = nextRequestId++;
  const payload = { jsonrpc: "2.0", id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    rpcProcess.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: appIconPath(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServer = process.env.NEXT_DEV_SERVER_URL;
  if (devServer) mainWindow.loadURL(devServer);
  else mainWindow.loadURL(exportedAppUrl("/"));

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    appendLog({
      level: "ERROR",
      message: `Desktop UI failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`,
      time: new Date().toISOString(),
    });
  });

  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      hideDockIfIdle();
    }
  });
}

async function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  showDockForWindow();
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  mainWindow.show();
  mainWindow.focus();
}

function hasVisibleWindow() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function hideDockIfIdle() {
  if (!isDev && process.platform === "darwin" && !hasVisibleWindow()) {
    app.setActivationPolicy("accessory");
  }
}

function showDockForWindow() {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy("regular");
  if (app.dock && !app.dock.isVisible()) void app.dock.show();
}

function updateNativeIcons() {
  if (tray) tray.setImage(trayIcon());
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(appIconPath());
  if (process.platform === "darwin" && app.dock && app.dock.isVisible()) app.dock.setIcon(appIconPath());
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`${APP_NAME}: ${state.status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Status: ${state.status}`, enabled: false },
      { type: "separator" },
      { label: "Open", click: () => void showWindow() },
      { label: "Start Connector", enabled: !state.running, click: () => rpcRequest("connector.start").catch((error) => appendLog({ level: "ERROR", message: error.message, time: new Date().toISOString() })) },
      { label: "Stop Connector", enabled: state.running, click: () => rpcRequest("connector.stop").catch((error) => appendLog({ level: "ERROR", message: error.message, time: new Date().toISOString() })) },
      { type: "separator" },
      { label: "Quit", click: () => quitApp() },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on("click", () => void showWindow());
  updateTrayMenu();
}

function quitApp() {
  app.isQuitting = true;
  stopRpcProcess();
  app.quit();
}

ipcMain.handle("connector:getState", async () => {
  const next = await rpcRequest("connector.getState");
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:getConfig", async () => {
  const config = await rpcRequest("connector.getConfig");
  if (config && typeof config.serverUrl === "string") state.serverUrl = config.serverUrl;
  return config;
});
ipcMain.handle("connector:saveConfig", async (_event, config) => {
  const saved = await rpcRequest("connector.saveConfig", config);
  mergeConnectorState({ hasConfig: true, authFailed: false, usingTemporaryCredential: false, serverUrl: saved?.serverUrl || config?.serverUrl || "" });
  return saved;
});
ipcMain.handle("connector:start", async (_event, config) => {
  state.usingTemporaryCredential = Boolean(config);
  if (config && typeof config.serverUrl === "string") state.serverUrl = config.serverUrl;
  const next = await rpcRequest("connector.start", config);
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:stop", async () => {
  state.usingTemporaryCredential = false;
  const next = await rpcRequest("connector.stop");
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:restart", async () => {
  state.usingTemporaryCredential = false;
  const next = await rpcRequest("connector.restart");
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:startPairing", (_event, input) => rpcRequest("connector.startPairing", input));
ipcMain.handle("connector:cancelPairing", () => rpcRequest("connector.cancelPairing"));
ipcMain.handle("connector:saveSettings", (_event, settings) => saveDesktopSettings(settings));
ipcMain.handle("connector:openConfigFolder", () => shell.openPath(path.dirname(state.configPath)));
ipcMain.handle("connector:openServer", async (_event, serverUrl) => {
  const url = String(serverUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Server URL is not configured.");
  return shell.openExternal(url);
});
ipcMain.handle("connector:getLogs", (_event, options) => readLogPage(options));
ipcMain.handle("connector:clearLogs", () => clearLogFiles());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (!isDev && process.platform === "darwin") app.setActivationPolicy("accessory");
  registerExportedAppProtocol();
  state.configPath = userDataPath("connector.json");
  state.settingsPath = userDataPath("desktop-settings.json");
  state.logPath = userDataPath("logs");
  state.connectorDir = resolveConnectorDir();
  loadDesktopSettings();
  initLogSeq();
  createTray();
  if (isDev) void showWindow();
  updateNativeIcons();
  startRpcProcess();
  rpcRequest("connector.getState")
    .then((next) => {
      mergeConnectorState(next);
      if (state.startConnectorOnLaunch && state.hasConfig) {
        return rpcRequest("connector.start").then(mergeConnectorState);
      }
      return null;
    })
    .catch((error) => appendLog({ level: "ERROR", message: error.message, time: new Date().toISOString() }));
  nativeTheme.on("updated", updateNativeIcons);
});

app.on("activate", () => {
  void showWindow();
});
app.on("window-all-closed", (event) => event.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
  stopRpcProcess();
});
