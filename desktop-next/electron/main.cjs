const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const APP_NAME = "Agents Anywhere Connector";
const MAX_LOGS = 500;

app.setName(APP_NAME);

let mainWindow = null;
let tray = null;
let rpcProcess = null;
let rpcProcessGroupPid = null;
let rpcReader = null;
let nextRequestId = 1;
let pending = new Map();
let logs = [];

const state = {
  platform: process.platform,
  status: "stopped",
  running: false,
  pairing: false,
  authFailed: false,
  lastError: null,
  hasConfig: false,
  configPath: "",
  settingsPath: "",
  connectorDir: "",
  uvPath: "",
  locale: "system",
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
  if (typeof settings.startConnectorOnLaunch === "boolean") state.startConnectorOnLaunch = settings.startConnectorOnLaunch;
  state.openAtLogin = app.getLoginItemSettings().openAtLogin;
}

function saveDesktopSettings(next = {}) {
  if (typeof next.uvPath === "string") state.uvPath = resolveExecutablePath(next.uvPath) || next.uvPath.trim();
  if (typeof next.locale === "string" && ["system", "en", "zh"].includes(next.locale)) state.locale = next.locale;
  if (typeof next.startConnectorOnLaunch === "boolean") state.startConnectorOnLaunch = next.startConnectorOnLaunch;
  if (typeof next.openAtLogin === "boolean") {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, openAsHidden: true });
    state.openAtLogin = next.openAtLogin;
  }
  writeJson(state.settingsPath, {
    uvPath: state.uvPath,
    locale: state.locale,
    startConnectorOnLaunch: state.startConnectorOnLaunch,
  });
  const nextState = publicState();
  sendToWindow("connector:state", nextState);
  return nextState;
}

function publicState() {
  return { ...state, logs };
}

function appendLog(entry) {
  const log = typeof entry === "string" ? { level: "INFO", message: entry, time: new Date().toISOString() } : entry;
  logs.push(log);
  if (logs.length > MAX_LOGS) logs = logs.slice(logs.length - MAX_LOGS);
  sendToWindow("connector:log", log);
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
  else mainWindow.loadFile(path.join(__dirname, "..", "out", "index.html"));

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function updateNativeIcons() {
  if (tray) tray.setImage(trayIcon());
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(appIconPath());
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(appIconPath());
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`${APP_NAME}: ${state.status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Status: ${state.status}`, enabled: false },
      { type: "separator" },
      { label: "Open", click: () => showWindow() },
      { label: "Start Connector", enabled: !state.running, click: () => rpcRequest("connector.start").catch((error) => appendLog({ level: "ERROR", message: error.message, time: new Date().toISOString() })) },
      { label: "Stop Connector", enabled: state.running, click: () => rpcRequest("connector.stop").catch((error) => appendLog({ level: "ERROR", message: error.message, time: new Date().toISOString() })) },
      { type: "separator" },
      { label: "Quit", click: () => quitApp() },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on("click", () => showWindow());
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
ipcMain.handle("connector:getConfig", () => rpcRequest("connector.getConfig"));
ipcMain.handle("connector:saveConfig", (_event, config) => rpcRequest("connector.saveConfig", config));
ipcMain.handle("connector:start", async (_event, config) => {
  const next = await rpcRequest("connector.start", config);
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:stop", async () => {
  const next = await rpcRequest("connector.stop");
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:restart", async () => {
  const next = await rpcRequest("connector.restart");
  mergeConnectorState(next);
  return publicState();
});
ipcMain.handle("connector:startPairing", (_event, input) => rpcRequest("connector.startPairing", input));
ipcMain.handle("connector:cancelPairing", () => rpcRequest("connector.cancelPairing"));
ipcMain.handle("connector:saveSettings", (_event, settings) => saveDesktopSettings(settings));
ipcMain.handle("connector:openConfigFolder", () => shell.openPath(path.dirname(state.configPath)));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  state.configPath = userDataPath("connector.json");
  state.settingsPath = userDataPath("desktop-settings.json");
  state.connectorDir = resolveConnectorDir();
  loadDesktopSettings();
  createTray();
  createMainWindow();
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

app.on("activate", () => showWindow());
app.on("window-all-closed", (event) => event.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
  stopRpcProcess();
});
