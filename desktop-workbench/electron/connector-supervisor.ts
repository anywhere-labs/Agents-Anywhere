import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { DesktopBindingStore } from "./desktop-binding";
import type { DesktopSettingsStore } from "./desktop-settings";
import { removeFile, writeJsonFile } from "./json-store";
import type { ConnectorLogStore } from "./log-store";
import type {
  ConnectorConfigPatch,
  ConnectorLogEntry,
  ConnectorPrivateConfig,
  ConnectorPublicConfig,
  ConnectorState,
  DesktopSettings,
  RpcResponse,
} from "./connector-types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ConnectorSupervisorOptions = {
  configPath: string;
  dataPath: string;
  connectorDir: string;
  resourcesPath: string;
  packaged: boolean;
  homePath: string;
  shellEnvironment: NodeJS.ProcessEnv;
  settings: DesktopSettingsStore;
  binding: DesktopBindingStore;
  logs: ConnectorLogStore;
  onState: (state: ConnectorState) => void;
  onLog: (entry: ConnectorLogEntry) => void;
};

type ConnectorLauncher = {
  executable: string;
  args: string[];
  description: string;
};

export class ConnectorSupervisor {
  private rpcProcess: ChildProcessWithoutNullStreams | null = null;
  private rpcReader: readline.Interface | null = null;
  private processGroupId: number | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private shuttingDown = false;
  private keepRuntimeRunning = false;
  private crashCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private suppressProcessRestart = false;
  private shellEnvironment: NodeJS.ProcessEnv;
  private state: ConnectorState;

  constructor(private readonly options: ConnectorSupervisorOptions) {
    this.shellEnvironment = options.shellEnvironment;
    this.state = {
      platform: process.platform,
      status: "stopped",
      running: false,
      authFailed: false,
      lastError: null,
      hasConfig: false,
      hasCredential: false,
      connectorId: "",
      serverUrl: "",
      manualDisconnected: false,
      setupIssue: "",
      configPath: options.configPath,
      runtimePath: path.join(path.dirname(options.configPath), "connector-runtime.json"),
      dataPath: options.dataPath,
      connectorDir: options.connectorDir,
      resolvedUvPath: "",
      uvMissing: false,
      ...this.publicSettings(),
    };
    this.refreshLocalState();
  }

  setShellEnvironment(environment: NodeJS.ProcessEnv): void {
    this.shellEnvironment = environment;
    this.refreshLocalState();
  }

  async applySettings(previous: DesktopSettings): Promise<ConnectorState> {
    const current = this.options.settings.get();
    const launcherChanged =
      previous.uvPath !== current.uvPath ||
      previous.uvPypiIndexUrl !== current.uvPypiIndexUrl;
    this.refreshLocalState();
    if (!launcherChanged) return this.emitState();
    if (!this.resolveLauncher()) {
      throw new Error(`Connector setup is not ready: ${this.state.setupIssue || "launcherMissing"}`);
    }
    const shouldRun = this.keepRuntimeRunning || this.state.running;
    await this.rebuildRpcProcess(shouldRun);
    return this.emitState();
  }

  bindingChanged(): ConnectorState {
    this.refreshLocalState();
    return this.emitState();
  }

  publicState(): ConnectorState {
    this.refreshBindingState();
    return { ...this.state };
  }

  async getState(): Promise<ConnectorState> {
    this.refreshLocalState();
    if (!this.state.setupIssue || this.state.setupIssue === "configMissing") {
      try {
        const runtimeState = await this.request("connector.getState", undefined, {
          requiresConfig: false,
        });
        this.mergeRuntimeState(runtimeState);
      } catch (error) {
        this.logError(error);
      }
    }
    return this.emitState();
  }

  async preflightProvisioning(): Promise<ConnectorState> {
    fs.mkdirSync(this.options.dataPath, { recursive: true, mode: 0o700 });
    fs.accessSync(this.options.dataPath, fs.constants.R_OK | fs.constants.W_OK);
    const runtimeState = await this.request("connector.getState", undefined, {
      requiresConfig: false,
      timeoutMs: 30_000,
    });
    this.mergeRuntimeState(runtimeState);
    return this.emitState();
  }

  getPublicConfig(): ConnectorPublicConfig {
    const config = this.loadPrivateConfig();
    if (!config) {
      const binding = this.options.binding.get();
      return {
        serverUrl: binding?.serverUrl ?? "",
        connectorId: binding?.connectorId ?? "",
        hasCredential: false,
      };
    }
    return sanitizeConfig(config);
  }

  loadPrivateConfig(): ConnectorPrivateConfig | null {
    try {
      return parsePrivateConfig(JSON.parse(fs.readFileSync(this.options.configPath, "utf8")));
    } catch {
      return null;
    }
  }

  hasCredential(): boolean {
    return Boolean(this.loadPrivateConfig()?.connectorToken);
  }

  async saveCredentials(config: ConnectorPrivateConfig): Promise<ConnectorPublicConfig> {
    const normalized = parsePrivateConfig(config);
    // Persist first so a sidecar crash after the Server creates a device does
    // not lose the only copy of its one-time Connector token.
    writeJsonFile(this.options.configPath, normalized);
    this.mergeRuntimeState({
      hasConfig: true,
      authFailed: false,
      lastError: null,
    });
    this.refreshLocalState();
    this.emitState();
    try {
      const result = await this.request("connector.saveConfig", normalized, {
        requiresConfig: false,
      });
      return sanitizeConfig(parsePrivateConfig(result));
    } catch (error) {
      this.log({
        level: "WARNING",
        message: `Connector credentials were stored for recovery, but the RPC sidecar did not acknowledge them: ${errorMessage(error)}`,
      });
      throw error;
    }
  }

  async saveConfig(patch: ConnectorConfigPatch): Promise<ConnectorState> {
    const current = this.loadPrivateConfig();
    if (!current) throw new Error("This Desktop does not have Connector credentials yet.");
    const next: ConnectorPrivateConfig = { ...current };
    if (patch.heartbeatSeconds != null) next.heartbeatSeconds = positiveNumber(patch.heartbeatSeconds, "heartbeatSeconds");
    if (patch.reconnectSeconds != null) next.reconnectSeconds = positiveNumber(patch.reconnectSeconds, "reconnectSeconds");
    if (patch.syncIntervalSeconds != null) next.syncIntervalSeconds = positiveNumber(patch.syncIntervalSeconds, "syncIntervalSeconds");
    if (typeof patch.syncExistingOnConnect === "boolean") next.syncExistingOnConnect = patch.syncExistingOnConnect;
    if (patch.statePath === null || typeof patch.statePath === "string") next.statePath = patch.statePath;
    const shouldRestart = this.keepRuntimeRunning || this.state.running;
    await this.saveCredentials(next);
    if (shouldRestart) return this.restart();
    return this.emitState();
  }

  async start(): Promise<ConnectorState> {
    this.keepRuntimeRunning = true;
    this.clearRestartTimer();
    const result = await this.request("connector.start", undefined, { requiresConfig: true });
    this.mergeRuntimeState(result);
    return this.emitState();
  }

  async stop(): Promise<ConnectorState> {
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    if (this.rpcProcess) {
      const result = await this.request("connector.stop", undefined, {
        requiresConfig: false,
        timeoutMs: 10_000,
      });
      this.mergeRuntimeState(result);
    } else {
      this.mergeRuntimeState({ running: false, status: "stopped" });
    }
    return this.emitState();
  }

  async restart(): Promise<ConnectorState> {
    this.keepRuntimeRunning = true;
    this.clearRestartTimer();
    const result = await this.request("connector.restart", undefined, { requiresConfig: true });
    this.mergeRuntimeState(result);
    return this.emitState();
  }

  async clearCredentials(): Promise<ConnectorState> {
    try {
      await this.stop();
    } catch (error) {
      this.log({ level: "WARNING", message: errorMessage(error) });
    }
    removeFile(this.options.configPath);
    removeFile(this.state.runtimePath);
    this.mergeRuntimeState({
      status: "stopped",
      running: false,
      authFailed: false,
      lastError: null,
      hasConfig: false,
    });
    this.refreshLocalState();
    return this.emitState();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    if (this.rpcProcess) {
      try {
        await this.request("connector.stop", undefined, {
          requiresConfig: false,
          timeoutMs: 4_000,
        });
      } catch {
        // Process-tree termination below is the final shutdown fallback.
      }
    }
    await this.terminateRpcProcess();
  }

  private async request(
    method: string,
    params?: unknown,
    options: { requiresConfig?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    this.ensureRpcProcess(options.requiresConfig !== false);
    const child = this.rpcProcess;
    if (!child?.stdin.writable) throw new Error("Connector RPC is not available.");
    const id = this.nextRequestId++;
    const payload = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Connector RPC request timed out: ${method}`));
      }, options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.reject(error);
      });
    });
  }

  private ensureRpcProcess(requiresConfig: boolean): void {
    if (this.rpcProcess) return;
    this.refreshLocalState();
    if (this.state.setupIssue && (requiresConfig || this.state.setupIssue !== "configMissing")) {
      throw new Error(`Connector setup is not ready: ${this.state.setupIssue}`);
    }
    const launcher = this.resolveLauncher();
    if (!launcher) throw new Error(`Connector setup is not ready: ${this.state.setupIssue || "launcherMissing"}`);
    const child = spawn(launcher.executable, launcher.args, {
      cwd: this.options.connectorDir,
      env: this.connectorEnvironment(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rpcProcess = child;
    this.processGroupId = process.platform === "win32" ? null : child.pid ?? null;
    this.log(`Starting Connector RPC with ${launcher.description}`);
    this.rpcReader = readline.createInterface({ input: child.stdout });
    this.rpcReader.on("line", (line) => this.handleRpcLine(line));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
    child.once("error", (error) => {
      this.finalizeRpcProcess(child, error, `Connector RPC failed to start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.finalizeRpcProcess(
        child,
        new Error("Connector RPC exited."),
        `Connector RPC exited${signal ? ` by ${signal}` : ""} with code ${code ?? "null"}`,
      );
    });
    child.once("close", (code, signal) => {
      this.finalizeRpcProcess(
        child,
        new Error("Connector RPC closed."),
        `Connector RPC closed${signal ? ` by ${signal}` : ""} with code ${code ?? "null"}`,
      );
    });
  }

  private handleRpcLine(line: string): void {
    let payload: RpcResponse;
    try {
      payload = JSON.parse(line) as RpcResponse;
    } catch {
      this.log({ level: "WARNING", message: `Connector RPC emitted a non-JSON line: ${line}` });
      return;
    }
    if (typeof payload.id === "number") {
      const request = this.pending.get(payload.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(payload.id);
      if (payload.error) request.reject(new Error(payload.error.message || "Connector RPC error"));
      else request.resolve(payload.result);
      return;
    }
    if (payload.method === "connector/state") {
      this.mergeRuntimeState(payload.params);
      this.emitState();
      return;
    }
    if (payload.method === "connector/log") {
      const entry = payload.params && typeof payload.params === "object"
        ? payload.params as Partial<ConnectorLogEntry>
        : { message: String(payload.params ?? "") };
      this.log(entry);
    }
  }

  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8").trimEnd();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const plain = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
      const match = plain.match(/\|\s*(TRACE|DEBUG|INFO|SUCCESS|WARNING|ERROR|CRITICAL)\s*\|/);
      const uvMessage = /^(Using CPython|Creating virtual environment|Building |Built |Downloading |Downloaded |Installed |Resolved |Prepared |Audited )/.test(plain);
      this.log({ level: match?.[1] ?? (uvMessage ? "INFO" : "ERROR"), message: plain });
    }
  }

  private finalizeRpcProcess(
    child: ChildProcessWithoutNullStreams,
    error: Error,
    message: string,
  ): void {
    if (this.rpcProcess !== child) return;
    this.log(message);
    this.rpcReader?.close();
    this.rpcReader = null;
    this.rpcProcess = null;
    this.processGroupId = null;
    this.rejectPending(error);
    this.mergeRuntimeState({ running: false, status: "stopped" });
    this.emitState();
    if (
      this.keepRuntimeRunning &&
      !this.shuttingDown &&
      !this.suppressProcessRestart &&
      !this.state.authFailed &&
      this.hasCredential()
    ) {
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.state.authFailed) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.crashCount++, 5));
    this.log({ level: "WARNING", message: `Connector RPC will restart in ${delay}ms.` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error) => {
        this.logError(error);
        if (this.keepRuntimeRunning && !this.shuttingDown && !this.state.authFailed) this.scheduleRestart();
      });
    }, delay);
  }

  private async rebuildRpcProcess(shouldRun: boolean): Promise<void> {
    this.clearRestartTimer();
    this.keepRuntimeRunning = shouldRun;
    if (this.rpcProcess) {
      try {
        await this.request("connector.stop", undefined, {
          requiresConfig: false,
          timeoutMs: 10_000,
        });
      } catch (error) {
        this.log({ level: "WARNING", message: `Failed to stop Connector before rebuilding RPC: ${errorMessage(error)}` });
      }
      await this.terminateRpcProcess(true);
    }
    this.refreshLocalState();
    if (shouldRun) await this.start();
  }

  private async terminateRpcProcess(suppressRestart = false): Promise<void> {
    const child = this.rpcProcess;
    if (!child) return;
    const groupId = this.processGroupId ?? child.pid ?? null;
    const previousSuppression = this.suppressProcessRestart;
    this.suppressProcessRestart = this.suppressProcessRestart || suppressRestart;
    const exited = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("error", done);
      child.once("exit", done);
      child.once("close", done);
    });
    child.stdin.end();
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else if (child.pid) {
      try {
        process.kill(-groupId!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    const completed = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!completed && child.pid && process.platform !== "win32") {
      try {
        process.kill(-groupId!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (this.rpcProcess === child) {
      this.finalizeRpcProcess(child, new Error("Connector RPC was terminated."), "Connector RPC was terminated.");
    }
    this.suppressProcessRestart = previousSuppression;
  }

  private resolveLauncher(): ConnectorLauncher | null {
    const direct = this.resolveDirectConnectorCli();
    if (direct) {
      this.state.uvMissing = false;
      this.state.resolvedUvPath = "";
      return {
        executable: direct,
        args: ["rpc", "--config", this.options.configPath],
        description: `${direct} rpc`,
      };
    }
    if (!fs.existsSync(path.join(this.options.connectorDir, "pyproject.toml"))) {
      this.state.setupIssue = "connectorSourceMissing";
      return null;
    }
    const uv = this.resolveUvPath();
    if (!uv) {
      this.state.uvMissing = true;
      this.state.setupIssue = "uvMissing";
      return null;
    }
    this.state.uvMissing = false;
    this.state.resolvedUvPath = uv;
    return {
      executable: uv,
      args: ["run", "--project", this.options.connectorDir, "anywhere-cli", "rpc", "--config", this.options.configPath],
      description: `${uv} run --project ${this.options.connectorDir}`,
    };
  }

  private resolveDirectConnectorCli(): string {
    const executableName = process.platform === "win32" ? "anywhere-cli.exe" : "anywhere-cli";
    const candidates = [
      process.env.WORKBENCH_CONNECTOR_CLI,
      this.options.packaged
        ? path.join(this.options.resourcesPath, "connector-bin", `${process.platform}-${process.arch}`, executableName)
        : undefined,
      this.options.packaged ? path.join(this.options.resourcesPath, "connector", executableName) : undefined,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const resolved = this.resolveExecutable(candidate);
      if (resolved) return resolved;
    }
    return "";
  }

  private resolveUvPath(): string {
    const executableName = process.platform === "win32" ? "uv.exe" : "uv";
    const configured = this.options.settings.get().uvPath;
    const bundled = this.options.packaged
      ? path.join(this.options.resourcesPath, "uv", `${process.platform}-${process.arch}`, executableName)
      : "";
    for (const candidate of [configured, bundled, executableName]) {
      const resolved = this.resolveExecutable(candidate);
      if (resolved) return resolved;
    }
    return "";
  }

  private resolveExecutable(command: string | undefined): string {
    const trimmed = command?.trim();
    if (!trimmed) return "";
    if (path.isAbsolute(trimmed)) {
      if (fs.existsSync(trimmed)) return trimmed;
      if (process.platform === "win32" && !trimmed.toLowerCase().endsWith(".exe") && fs.existsSync(`${trimmed}.exe`)) return `${trimmed}.exe`;
      return "";
    }
    for (const directory of this.pathEntries()) {
      const candidate = path.join(directory, trimmed);
      if (fs.existsSync(candidate)) return candidate;
      if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe") && fs.existsSync(`${candidate}.exe`)) return `${candidate}.exe`;
    }
    return "";
  }

  private connectorEnvironment(): NodeJS.ProcessEnv {
    const entries = this.pathEntries();
    if (this.state.resolvedUvPath) entries.unshift(path.dirname(this.state.resolvedUvPath));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.shellEnvironment,
      PATH: [...new Set(entries)].join(path.delimiter),
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      FORCE_COLOR: "0",
    };
    if (this.options.packaged) {
      environment.UV_PROJECT_ENVIRONMENT = path.join(this.options.dataPath, ".venv");
      environment.UV_CACHE_DIR = path.join(this.options.dataPath, "uv-cache");
    }
    const pypiIndexUrl = this.options.settings.get().uvPypiIndexUrl;
    if (pypiIndexUrl) {
      environment.UV_INDEX_URL = pypiIndexUrl;
      environment.PIP_INDEX_URL = pypiIndexUrl;
    }
    if (process.platform === "win32") {
      delete environment.Path;
      delete environment.path;
      environment.Path = environment.PATH;
    }
    return environment;
  }

  private pathEntries(): string[] {
    const entries: string[] = [];
    for (const environment of [process.env, this.shellEnvironment]) {
      const value = environment.PATH || environment.Path || environment.path;
      if (value) entries.push(...value.split(path.delimiter));
    }
    if (process.platform === "darwin") {
      entries.push(
        path.join(this.options.homePath, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      );
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA || path.join(this.options.homePath, "AppData", "Roaming");
      const localAppData = process.env.LOCALAPPDATA || path.join(this.options.homePath, "AppData", "Local");
      entries.push(
        path.join(this.options.homePath, "scoop", "shims"),
        path.join(localAppData, "Microsoft", "WinGet", "Packages"),
        path.join(appData, "npm"),
      );
    }
    return [...new Set(entries.filter(Boolean))];
  }

  private refreshLocalState(): void {
    const config = this.loadPrivateConfig();
    const launcher = this.resolveLauncher();
    this.state.hasConfig = Boolean(config);
    this.state.hasCredential = Boolean(config?.connectorToken);
    if (!launcher) {
      // resolveLauncher sets the concrete issue.
    } else if (!config) {
      this.state.setupIssue = "configMissing";
    } else {
      this.state.setupIssue = "";
    }
    this.state = { ...this.state, ...this.publicSettings() };
    this.refreshBindingState();
  }

  private refreshBindingState(): void {
    const config = this.loadPrivateConfig();
    const binding = this.options.binding.get();
    this.state.connectorId = binding?.connectorId ?? config?.connectorId ?? "";
    this.state.serverUrl = binding?.serverUrl ?? config?.serverUrl ?? "";
    this.state.manualDisconnected = Boolean(binding?.manualDisconnected);
    this.state.hasCredential = Boolean(config?.connectorToken);
  }

  private publicSettings(): Pick<
    ConnectorState,
    | "openAtLogin"
    | "startConnectorOnLaunch"
    | "silentLaunch"
    | "notificationsEnabled"
    | "uvPath"
    | "uvPypiIndexUrl"
    | "logChunkSizeKb"
    | "logRetainChunks"
    | "logRetentionDays"
  > {
    const settings = this.options.settings.get();
    return {
      openAtLogin: settings.openAtLogin,
      startConnectorOnLaunch: settings.startConnectorOnLaunch,
      silentLaunch: settings.silentLaunch,
      notificationsEnabled: settings.notificationsEnabled,
      uvPath: settings.uvPath,
      uvPypiIndexUrl: settings.uvPypiIndexUrl,
      logChunkSizeKb: settings.logChunkSizeKb,
      logRetainChunks: settings.logRetainChunks,
      logRetentionDays: settings.logRetentionDays,
    };
  }

  private mergeRuntimeState(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const next = value as Record<string, unknown>;
    if (typeof next.status === "string") this.state.status = next.status;
    if (typeof next.running === "boolean") this.state.running = next.running;
    if (typeof next.authFailed === "boolean") this.state.authFailed = next.authFailed;
    if (typeof next.lastError === "string" || next.lastError === null) this.state.lastError = next.lastError;
    if (typeof next.hasConfig === "boolean") this.state.hasConfig = next.hasConfig;
    if (typeof next.configPath === "string") this.state.configPath = next.configPath;
    if (typeof next.runtimePath === "string") this.state.runtimePath = next.runtimePath;
    if (this.state.authFailed) this.clearRestartTimer();
    if (this.state.running) this.crashCount = 0;
    this.refreshBindingState();
  }

  private emitState(): ConnectorState {
    const state = this.publicState();
    this.options.onState(state);
    return state;
  }

  private log(entry: string | Partial<ConnectorLogEntry>): ConnectorLogEntry {
    const normalized = this.options.logs.append(entry);
    this.options.onLog(normalized);
    return normalized;
  }

  private logError(error: unknown): void {
    this.log({ level: "ERROR", message: errorMessage(error) });
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

function parsePrivateConfig(value: unknown): ConnectorPrivateConfig {
  if (!value || typeof value !== "object") throw new Error("Connector config is invalid.");
  const candidate = value as Partial<ConnectorPrivateConfig>;
  if (
    typeof candidate.serverUrl !== "string" ||
    !/^https?:\/\//i.test(candidate.serverUrl) ||
    typeof candidate.connectorId !== "string" ||
    !candidate.connectorId.trim() ||
    typeof candidate.connectorToken !== "string" ||
    !candidate.connectorToken.trim()
  ) {
    throw new Error("Connector config is incomplete.");
  }
  return {
    ...candidate,
    serverUrl: candidate.serverUrl.trim().replace(/\/+$/, ""),
    connectorId: candidate.connectorId.trim(),
    connectorToken: candidate.connectorToken.trim(),
  };
}

function sanitizeConfig(config: ConnectorPrivateConfig): ConnectorPublicConfig {
  const { connectorToken: _connectorToken, ...publicConfig } = config;
  return { ...publicConfig, hasCredential: true };
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
