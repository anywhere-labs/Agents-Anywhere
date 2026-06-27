const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_LINES = 400;
const APP_NAME = "Agents Anywhere Connector";

app.setName(APP_NAME);

let mainWindow = null;
let tray = null;
let connectorProcess = null;
let connectorProcessGroupPid = null;
let stopping = false;
let logs = [];
let pairingAbort = null;

const state = {
  status: "stopped",
  pid: null,
  exitCode: null,
  authFailed: false,
  configPath: "",
  settingsPath: "",
  connectorDir: "",
  uvCommand: process.platform === "win32" ? "uv.exe" : "uv",
  openAtLogin: false,
  startConnectorOnLaunch: true,
};

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

function connectorEnv() {
  return {
    ...process.env,
    PATH: defaultPathEntries().join(path.delimiter),
    PYTHONUNBUFFERED: "1",
    FORCE_COLOR: "0",
  };
}

function userDataPath(name) {
  return path.join(app.getPath("userData"), name);
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

function currentPromptIconPath() {
  return resolveLogoPath(nativeTheme.shouldUseDarkColors ? "prompt-dark.png" : "prompt-light.png");
}

function appIconPath() {
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolveBuildAssetPath("icon-mac-source.png");
  }
  return resolveLogoPath("icon-light.png");
}

function currentPromptIcon(size) {
  const image = nativeImage.createFromPath(currentPromptIconPath());
  if (image.isEmpty()) return nativeImage.createEmpty();
  return size ? image.resize({ width: size, height: size }) : image;
}

function trayIcon() {
  return currentPromptIcon(process.platform === "darwin" ? 18 : 16);
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

function loadDesktopSettings() {
  const settings = readJson(state.settingsPath, {});
  if (typeof settings.uvCommand === "string" && settings.uvCommand.trim()) {
    state.uvCommand = settings.uvCommand.trim();
  }
  if (typeof settings.startConnectorOnLaunch === "boolean") {
    state.startConnectorOnLaunch = settings.startConnectorOnLaunch;
  }
  state.openAtLogin = app.getLoginItemSettings().openAtLogin;
}

function saveDesktopSettings(next = {}) {
  if (typeof next.uvCommand === "string" && next.uvCommand.trim()) state.uvCommand = next.uvCommand.trim();
  if (typeof next.startConnectorOnLaunch === "boolean") {
    state.startConnectorOnLaunch = next.startConnectorOnLaunch;
  }
  if (typeof next.openAtLogin === "boolean") {
    app.setLoginItemSettings({ openAtLogin: next.openAtLogin, openAsHidden: true });
    state.openAtLogin = next.openAtLogin;
  }
  writeJson(state.settingsPath, {
    uvCommand: state.uvCommand,
    startConnectorOnLaunch: state.startConnectorOnLaunch,
  });
  broadcastState();
  return publicState();
}

function appendLog(line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  for (const part of text.split(/\r?\n/)) {
    const stamped = `[${new Date().toLocaleTimeString()}] ${part}`;
    logs.push(stamped);
    if (logs.length > MAX_LOG_LINES) logs = logs.slice(logs.length - MAX_LOG_LINES);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("connector:log", stamped);
  }
}

function setStatus(status, patch = {}) {
  Object.assign(state, patch, { status });
  updateTrayMenu();
  broadcastState();
}

function publicState() {
  return {
    ...state,
    hasConfig: fs.existsSync(state.configPath),
    logs,
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("connector:state", publicState());
}

function readConnectorConfig() {
  return readJson(state.configPath, {
    serverUrl: "",
    connectorId: "",
    connectorToken: "",
    heartbeatSeconds: 20,
    reconnectSeconds: 3,
    syncExistingOnConnect: true,
    syncIntervalSeconds: 30,
  });
}

function saveConnectorConfig(config) {
  const payload = {
    serverUrl: String(config.serverUrl || "").trim().replace(/\/+$/, ""),
    connectorId: String(config.connectorId || "").trim(),
    connectorToken: String(config.connectorToken || "").trim(),
    heartbeatSeconds: Number(config.heartbeatSeconds || 20),
    reconnectSeconds: Number(config.reconnectSeconds || 3),
    syncExistingOnConnect: config.syncExistingOnConnect !== false,
    syncIntervalSeconds: Number(config.syncIntervalSeconds || 30),
  };
  if (!payload.serverUrl || !payload.connectorId || !payload.connectorToken) {
    throw new Error("Server URL, connector id, and connector token are required.");
  }
  writeJson(state.configPath, payload);
  state.authFailed = false;
  if (!connectorProcess && state.status === "expired credential") state.status = "stopped";
  appendLog(`Saved connector config: ${state.configPath}`);
  broadcastState();
  return payload;
}

function startConnector(runtimeConfig = null) {
  if (connectorProcess) return publicState();
  if (!runtimeConfig && !fs.existsSync(state.configPath)) throw new Error("Connector config has not been saved yet.");
  if (!fs.existsSync(path.join(state.connectorDir, "pyproject.toml"))) {
    throw new Error(`Connector source is missing pyproject.toml: ${state.connectorDir}`);
  }

  const args = ["run", "--project", state.connectorDir, "anywhere-cli", "start"];
  if (runtimeConfig) {
    args.push(
      "--server-url",
      runtimeConfig.serverUrl,
      "--connector-id",
      runtimeConfig.connectorId,
      "--connector-token",
      runtimeConfig.connectorToken,
    );
  } else {
    args.push("--config", state.configPath);
  }
  appendLog(`Starting connector with ${state.uvCommand} run --project ${state.connectorDir}`);
  stopping = false;
  connectorProcess = spawn(state.uvCommand, args, {
    cwd: state.connectorDir,
    env: connectorEnv(),
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  connectorProcessGroupPid = process.platform === "win32" ? null : connectorProcess.pid;

  setStatus("starting", { pid: connectorProcess.pid, exitCode: null, authFailed: false });
  const handleOutput = (chunk) => {
    const text = chunk.toString();
    if (/invalid connector credential|authentication failed/i.test(text) && !state.authFailed) {
      setStatus("expired credential", { authFailed: true });
    }
    appendLog(text);
  };
  connectorProcess.stdout.on("data", handleOutput);
  connectorProcess.stderr.on("data", handleOutput);
  connectorProcess.on("error", (error) => {
    appendLog(`Failed to start connector: ${error.message}`);
    connectorProcess = null;
    connectorProcessGroupPid = null;
    setStatus("error", { pid: null, exitCode: null });
  });
  connectorProcess.on("spawn", () => setStatus("running", { pid: connectorProcess.pid, exitCode: null }));
  connectorProcess.on("exit", (code, signal) => {
    appendLog(`Connector exited${signal ? ` by ${signal}` : ""} with code ${code ?? "null"}`);
    connectorProcess = null;
    connectorProcessGroupPid = null;
    setStatus(state.authFailed ? "expired credential" : stopping ? "stopped" : "exited", { pid: null, exitCode: code });
    stopping = false;
  });
  return publicState();
}

function stopConnector() {
  if (!connectorProcess) {
    setStatus("stopped", { pid: null });
    return publicState();
  }
  stopping = true;
  setStatus("stopping");
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(connectorProcess.pid), "/t", "/f"], { windowsHide: true });
  } else {
    const pid = connectorProcessGroupPid || connectorProcess.pid;
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      appendLog(`Failed to stop connector process group: ${error.message || error}`);
      connectorProcess.kill("SIGTERM");
    }
  }
  return publicState();
}

async function restartConnector() {
  stopConnector();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return startConnector();
}

function parseConnectorCommand(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("Paste a connector command or enter a server address.");
  const parts = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const commandIndex = parts.findIndex((part) => part === "start" || part === "pair" || part === "login");
  if (commandIndex >= 0) {
    const command = parts[commandIndex];
    const arg = (name) => {
      const index = parts.indexOf(name);
      return index >= 0 ? parts[index + 1] : undefined;
    };
    if (command === "start") {
      const config = {
        serverUrl: arg("--server-url")?.replace(/\/+$/, ""),
        connectorId: arg("--connector-id"),
        connectorToken: arg("--connector-token"),
        heartbeatSeconds: 20,
        reconnectSeconds: 3,
        syncExistingOnConnect: true,
        syncIntervalSeconds: 30,
      };
      if (!config.serverUrl || !config.connectorId || !config.connectorToken) {
        throw new Error("The start command is missing --server-url, --connector-id, or --connector-token.");
      }
      return { kind: "start", config };
    }
    const server = arg("--server-url") || parts[commandIndex + 1];
    return { kind: "pair", server };
  }
  return { kind: "pair", server: text };
}

async function resolvePairServerUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("Missing server address.");
  if (/^https?:\/\//i.test(normalized)) return normalized;
  const candidates = [`https://${normalized}`, `http://${normalized}`];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(5000) });
      if (response.status < 500) return candidate;
      errors.push(`${candidate}: HTTP ${response.status}`);
    } catch (error) {
      errors.push(`${candidate}: ${error.message || error}`);
    }
  }
  throw new Error(`Could not reach server. ${errors.join("; ")}`);
}

function sendPairing(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("connector:pairing", payload);
}

async function startPairing(input) {
  const parsed = parseConnectorCommand(input);
  if (parsed.kind === "start") {
    return { kind: "start-command", config: parsed.config };
  }
  if (pairingAbort) pairingAbort.abort();
  pairingAbort = new AbortController();
  const serverUrl = await resolvePairServerUrl(parsed.server);
  const startResponse = await fetch(`${serverUrl}/pairing/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverUrl, ttlSeconds: 600 }),
    signal: pairingAbort.signal,
  });
  if (!startResponse.ok) throw new Error(`Pairing start failed: HTTP ${startResponse.status}`);
  const pairing = await startResponse.json();
  const payload = {
    status: "waiting",
    serverUrl,
    pairingId: pairing.pairingId,
    code: pairing.code,
  };
  sendPairing(payload);
  pollPairing(serverUrl, pairing.pairingId, pairingAbort.signal).catch((error) => {
    if (error.name !== "AbortError") sendPairing({ status: "error", error: error.message || String(error) });
  });
  return payload;
}

async function pollPairing(serverUrl, pairingId, signal) {
  while (!signal.aborted) {
    const response = await fetch(`${serverUrl}/pairing/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId }),
      signal,
    });
    if (!response.ok) throw new Error(`Pairing poll failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.status === "claimed" && payload.config) {
      const config = {
        serverUrl: payload.config.serverUrl,
        connectorId: payload.config.connectorId,
        connectorToken: payload.config.connectorToken,
        heartbeatSeconds: Number(payload.config.heartbeatSeconds || 20),
        reconnectSeconds: Number(payload.config.reconnectSeconds || 3),
        syncExistingOnConnect: payload.config.syncExistingOnConnect !== false,
        syncIntervalSeconds: Number(payload.config.syncIntervalSeconds || 30),
      };
      saveConnectorConfig(config);
      sendPairing({ status: "claimed", config });
      startConnector();
      return;
    }
    if (payload.status === "expired" || payload.status === "consumed") {
      sendPairing({ status: payload.status });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function cancelPairing() {
  if (pairingAbort) pairingAbort.abort();
  pairingAbort = null;
  sendPairing({ status: "cancelled" });
}

function startFromCommand(input, options = {}) {
  const parsed = parseConnectorCommand(input);
  if (parsed.kind === "pair") return startPairing(input);
  if (options.save) {
    saveConnectorConfig(parsed.config);
    return startConnector();
  }
  return startConnector(parsed.config);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 740,
    minWidth: 780,
    minHeight: 620,
    show: false,
    title: "Agents Anywhere Connector",
    icon: appIconPath(),
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

function updateNativeIcons() {
  if (tray) {
    tray.setImage(trayIcon());
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(appIconPath());
  }
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIconPath());
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`Agents Anywhere Connector: ${state.status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Status: ${state.status}`, enabled: false },
      { type: "separator" },
      { label: "Open", click: () => showWindow() },
      { label: "Start Connector", enabled: !connectorProcess, click: () => safeRun(startConnector) },
      { label: "Stop Connector", enabled: !!connectorProcess, click: () => safeRun(stopConnector) },
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

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function quitApp() {
  app.isQuitting = true;
  stopConnector();
  app.quit();
}

function safeRun(fn) {
  try {
    return fn();
  } catch (error) {
    appendLog(error.message || String(error));
    setStatus("error");
    throw error;
  }
}

ipcMain.handle("connector:getState", () => publicState());
ipcMain.handle("connector:getConfig", () => readConnectorConfig());
ipcMain.handle("connector:saveConfig", (_event, config) => saveConnectorConfig(config));
ipcMain.handle("connector:start", () => safeRun(startConnector));
ipcMain.handle("connector:stop", () => safeRun(stopConnector));
ipcMain.handle("connector:restart", () => safeRun(restartConnector));
ipcMain.handle("connector:startPairing", (_event, input) => safeRun(() => startPairing(input)));
ipcMain.handle("connector:cancelPairing", () => cancelPairing());
ipcMain.handle("connector:startFromCommand", (_event, input, options) => safeRun(() => startFromCommand(input, options)));
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
  appendLog(`Connector source: ${state.connectorDir}`);
  appendLog(`Connector config: ${state.configPath}`);
  if (state.startConnectorOnLaunch && fs.existsSync(state.configPath)) safeRun(startConnector);
  nativeTheme.on("updated", updateNativeIcons);
});

app.on("activate", () => showWindow());
app.on("window-all-closed", (event) => event.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
  if (connectorProcess) stopConnector();
});
