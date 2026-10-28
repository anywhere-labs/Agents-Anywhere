import { ConnectorEnvironment, type ConnectorEnvironmentState } from "./connector-environment";
import { terminateConnectorProcess } from "./connector-process";
import { localRuntimePath } from "./local-runtime";
import type { OwnershipState, RuntimeOwner } from "./local-runtime";
import { ConnectorRpcError, CONNECTOR_CONFLICT_MESSAGE } from "./connector-rpc-error";
import { materializeConnectorProject } from "./connector-project";
import { bundledPythonExecutable } from "./connector-python";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Mesh as MeshConnection, Router as RouterEndpoint } from "meshcall" with { "resolution-mode": "import" };
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
  ConnectorLogQuery,
  ConnectorLogPage,
  ConnectorLogSource,
  ConnectorPrivateConfig,
  ConnectorPublicConfig,
  ConnectorState,
  DesktopSettings,
} from "./connector-types";
import {
  ControlServiceClient,
  type ConnectorSettings as ControlSettings,
} from "./generated/connector-control";
import { LogsServiceClient, type LogEntry, type LogPage } from "./generated/connector-logs";

/** The Connector restarts its Router within a couple of seconds; wait it out. */
const CONTROL_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const PYTHON_BUILDS_GITHUB = "https://github.com/astral-sh/python-build-standalone/releases/download";
const PYPI_SIMPLE = "https://pypi.org/simple";
const UV_HTTP_TIMEOUT_SECONDS = "60";
/** `exit` can arrive before stderr delivers the lines that explain it. */
const OUTPUT_DRAIN_MS = 250;
/** How much stderr a failed request quotes; uv and Python explain a failed launch there. */
const RECENT_OUTPUT_LINES = 12;
const RECENT_OUTPUT_LINE_LENGTH = 500;

type RpcOutput = { lines: string[]; closed: Promise<void> };

/** The control surface of one Connector process; tests substitute their own. */
export interface ConnectorChannel {
  control: {
    getState(options?: { timeoutMs?: number }): Promise<{ running: boolean; authFailed: boolean }>;
    acquireOwnership(options?: { timeoutMs?: number }): Promise<{ running: boolean; authFailed: boolean }>;
    saveConfig(config: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    start(config: unknown | null, options?: { timeoutMs?: number }): Promise<{ running: boolean; authFailed: boolean }>;
    stop(options?: { timeoutMs?: number }): Promise<{ running: boolean; authFailed: boolean }>;
    restart(config: unknown | null, options?: { timeoutMs?: number }): Promise<{ running: boolean; authFailed: boolean }>;
    events(since: number | null, options?: { signal?: AbortSignal }): AsyncIterable<{ seq: number; kind: string; state?: unknown }>;
  };
  logs: {
    tail(since: number | null, source?: ConnectorLogSource | null, options?: { signal?: AbortSignal }): AsyncIterable<LogEntry>;
    read(source?: ConnectorLogSource | null, beforeSeq?: number | null, afterSeq?: number | null, limit?: number): Promise<LogPage & { logsPath?: string }>;
    clear(): Promise<LogPage & { logsPath?: string }>;
  };
  close?(): Promise<void>;
}

type ConnectorSupervisorOptions = {
  onEnvironment?: (state: ConnectorEnvironmentState) => void;
  onOwnership?: (state: OwnershipState) => void;
  configPath: string;
  dataPath: string;
  connectorDir: string;
  resourcesPath: string;
  /** Directory holding `<platform>-<arch>/uv[.exe]`; packaged resources or `build/uv`. */
  uvBundleDir: string;
  /** Directory holding `<platform>-<arch>/` CPython installs; packaged resources or `build/python`. */
  pythonBundleDir: string;
  packaged: boolean;
  homePath: string;
  shellEnvironment: NodeJS.ProcessEnv;
  settings: DesktopSettingsStore;
  binding: DesktopBindingStore;
  logs: ConnectorLogStore;
  onState: (state: ConnectorState) => void;
  onLog: (entry: ConnectorLogEntry) => void;
  onRuntimeLog?: (entry: ConnectorLogEntry) => void;
  onLogSourceChanged?: () => void;
  /** Test seam; production connects a Mesh to the Connector's Router. */
  connectControl?: (rendezvous: Rendezvous) => Promise<ConnectorChannel>;
};

type ConnectorLauncher = {
  executable: string;
  args: string[];
  description: string;
};

export class ConnectorSupervisor {
  private readonly environment: ConnectorEnvironment;
  private acquisition: Promise<void> | null = null;
  private maintenance: Promise<unknown> | null = null;
  private generation = 0;
  private rpcProcess: ChildProcessWithoutNullStreams | null = null;
  private rpcReader: readline.Interface | null = null;
  /** The current RPC process's recent stderr, quoted when a request fails. */
  private rpcOutput: RpcOutput | null = null;
  private termination: Promise<void> | null = null;
  private mesh: MeshConnection | null = null;
  private channel: ConnectorChannel | null = null;
  private ready: { promise: Promise<ConnectorChannel>; resolve: (channel: ConnectorChannel) => void; reject: (error: Error) => void } | null = null;
  private streams: AbortController | null = null;
  private shuttingDown = false;
  private keepRuntimeRunning = false;
  /** The directory `uv run --project` uses; a writable copy when packaged. */
  private projectDir: string | null = null;
  private crashCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private suppressProcessRestart = false;
  /** Processes this supervisor is stopping on purpose; their exit is not an error. */
  private readonly terminating = new WeakSet<ChildProcessWithoutNullStreams>();
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
      runtimePath: localRuntimePath(),
      dataPath: options.dataPath,
      connectorDir: options.connectorDir,
      resolvedUvPath: "",
      uvMissing: false,
      resolvedPythonPath: "",
      ...this.publicSettings(),
    };
    this.environment = new ConnectorEnvironment({
      dataPath: options.dataPath,
      resolve: (materialize = false) => {
        const launcher = this.resolveLauncher(materialize);
        if (!launcher) throw new Error(`Connector setup is not ready: ${this.state.setupIssue}`);
        return { project: this.projectDir ?? options.connectorDir, environment: this.projectEnvironmentPath(),
          uv: launcher.executable, python: this.resolvePythonPath(), env: this.connectorEnvironment(), direct: this.resolveDirectConnectorCli() };
      },
      onState: state => options.onEnvironment?.(state),
      log: message => this.log({ level: "INFO", message }),
    });
    this.refreshLocalState();
  }

  environmentState(): ConnectorEnvironmentState { return this.environment.getState(); }

  prepareEnvironment(): Promise<void> {
    if (this.shuttingDown || this.maintenance) return Promise.reject(new Error("Connector environment is stopping."));
    return this.rpcProcess ? Promise.resolve() : this.environment.prepare();
  }

  cancelEnvironment(stopOwned = false): Promise<ConnectorEnvironmentState> {
    if (!stopOwned && !this.acquisition && !["checking", "preparing"].includes(this.environmentState().status)) return Promise.resolve(this.environmentState());
    if (this.maintenance) return this.maintenance.then(() => this.environmentState());
    this.generation++;
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    this.maintenance = (async () => {
      await this.environment.cancel();
      await this.terminateRpcProcess(true);
      await this.acquisition?.catch(() => undefined);
      return this.environmentState();
    })().finally(() => { this.maintenance = null; });
    return this.maintenance as Promise<ConnectorEnvironmentState>;
  }

  setShellEnvironment(environment: NodeJS.ProcessEnv): void {
    this.shellEnvironment = environment;
    this.refreshLocalState();
  }

  async applySettings(previous: DesktopSettings): Promise<ConnectorState> {
    const current = this.options.settings.get();
    const launcherChanged =
      previous.uvPath !== current.uvPath ||
      previous.pythonPath !== current.pythonPath ||
      previous.uvPypiIndexUrl !== current.uvPypiIndexUrl ||
      previous.uvPythonInstallMirror !== current.uvPythonInstallMirror;
    this.refreshLocalState();
    if (!launcherChanged) return this.emitState();
    if (!this.resolveLauncher()) {
      throw new Error(`Connector setup is not ready: ${this.state.setupIssue || "launcherMissing"}`);
    }
    const shouldRun = this.keepRuntimeRunning || this.state.running;
    await this.cancelEnvironment(true);
    await this.environment.shutdown();
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

  hasRuntimeLogs(): boolean { return this.channel !== null }

  async readLogs(query: ConnectorLogQuery = {}): Promise<ConnectorLogPage> {
    if (!this.channel) return this.options.logs.read(query);
    const page = await this.channel.logs.read(query.source ?? null, query.beforeSeq ?? null, query.afterSeq ?? null,
      Math.max(1, Math.min(1000, query.pageSize ?? 200)));
    if (typeof page.logsPath === "string" && page.logsPath.trim()) this.state.logsPath = page.logsPath;
    return { ...page, items: page.items.map(entry => ({ ...entry })) };
  }

  async clearLogs(): Promise<ConnectorLogPage> {
    if (!this.channel) return this.options.logs.clear();
    const page = await this.channel.logs.clear();
    if (typeof page.logsPath === "string" && page.logsPath.trim()) this.state.logsPath = page.logsPath;
    return { ...page, items: page.items.map(entry => ({ ...entry })) };
  }

  async exportLogs(filePath: string): Promise<number> {
    const channel = this.channel;
    if (!channel) return this.options.logs.exportTo(filePath);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const file = await fs.promises.open(temporary, "wx", 0o600);
    let count = 0;
    try {
      let cursor = 0;
      let upper: number | null = null;
      for (;;) {
        const page = await channel.logs.read(null, null, cursor, 1000);
        if (upper === null) upper = page.lastSeq ?? 0;
        const entries = page.items.filter(entry => entry.seq <= upper!);
        if (!entries.length) break;
        await file.write(entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
        count += entries.length;
        cursor = entries.at(-1)!.seq;
        if (cursor >= upper || !page.hasMoreAfter) break;
      }
      await file.close();
      await fs.promises.rename(temporary, filePath);
      return count;
    } catch (error) {
      await file.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch(() => undefined);
      throw error;
    }
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
    const runtimeState = await this.request("connector.acquireOwnership", undefined, {
      requiresConfig: false,
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
    });
    this.mergeRuntimeState(runtimeState);
    return this.emitState();
  }

  acquireOwnership(): Promise<void> {
    if (this.acquisition) return this.acquisition;
    if (this.maintenance || this.shuttingDown) return Promise.reject(new Error("Connector environment is stopping."));
    this.acquisition = this.acquire().finally(() => { this.acquisition = null; });
    return this.acquisition;
  }

  private async acquire(): Promise<void> {
    try {
      this.options.onOwnership?.({ status: "checking" });
      await this.request("connector.acquireOwnership", undefined, { requiresConfig: false, timeoutMs: CONTROL_CONNECT_TIMEOUT_MS });
      this.options.onOwnership?.({ status: "owned" });
    } catch (error) {
      const conflict = error instanceof ConnectorRpcError && error.ownershipConflict;
      const message = errorMessage(error);
      this.log({ level: conflict ? "WARNING" : "ERROR", message: `Could not acquire Connector ownership: ${message}` });
      // Environment failures are owned by their own state machine.
      if (!conflict && !["failed", "cancelled"].includes(this.environmentState().status)) {
        this.options.onOwnership?.({ status: "error", message });
      }
      throw error;
    }
  }

  /**
   * Deletes what `uv run` downloaded and built for this Desktop, so the next
   * launch fetches everything again: the project environment and, when
   * packaged, the uv cache and the project copy holding uv.lock. Development
   * keeps the developer's own uv cache.
   */
  async resetEnvironment(): Promise<ConnectorState> {
    if (this.resolveDirectConnectorCli()) throw new Error("This Connector runs without a Python environment, so there is nothing to clear.");
    await this.cancelEnvironment(true);
    if (this.maintenance) { await this.maintenance; return this.emitState(); }
    this.maintenance = this.environment.reset(context => {
      // A configured path can be outside userData. Only remove a virtualenv.
      if (fs.existsSync(path.join(context.environment, "pyvenv.cfg"))) {
        fs.rmSync(context.environment, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      if (this.options.packaged) {
        for (const name of ["uv-cache", "connector-source"]) fs.rmSync(path.join(this.options.dataPath, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        this.projectDir = null;
      }
    }).finally(() => { this.maintenance = null; });
    await this.maintenance;
    this.options.onOwnership?.({ status: "checking" });
    return this.emitState();
  }

  /** A failure outside any Connector request, such as the launch auto-start, still belongs in `lastError`. */
  reportError(message: string): ConnectorState {
    this.state.lastError = message;
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
    await this.acquireOwnership();
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
    const result = await this.request("connector.start", undefined, {
      requiresConfig: true,
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
    });
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
    const result = await this.request("connector.restart", undefined, {
      requiresConfig: true,
      timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
    });
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
    this.generation++;
    await this.environment.cancel();
    if (this.acquisition) await this.terminateRpcProcess(true);
    await this.acquisition?.catch(() => undefined);
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    if (this.rpcProcess && this.channel) {
      try {
        await this.request("connector.stop", undefined, {
          requiresConfig: false,
          timeoutMs: 1_000,
        });
      } catch {
        // Process-tree termination below is the final shutdown fallback.
      }
    }
    await this.terminateRpcProcess();
    await this.environment.shutdown();
  }

  /** Call one method of `aa.local.v2.Control`; the first call also waits out provisioning. */
  private async request(
    method: string,
    params?: unknown,
    options: { requiresConfig?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const generation = this.generation;
    if (this.maintenance) throw new Error("Connector environment is stopping.");
    if (!this.rpcProcess) await this.prepareEnvironment();
    if (generation !== this.generation) throw new Error("Connector startup was cancelled.");
    this.ensureRpcProcess(options.requiresConfig !== false);
    const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const control = (await this.awaitControl(CONTROL_CONNECT_TIMEOUT_MS, method)).control;
    const call = { timeoutMs };
    try {
      switch (method) {
        case "connector.getState": return await control.getState(call);
        case "connector.acquireOwnership": return await control.acquireOwnership(call);
        case "connector.saveConfig": return await control.saveConfig(params as ControlSettings, call);
        case "connector.start": return await control.start(null, call);
        case "connector.stop": return await control.stop(call);
        case "connector.restart": return await control.restart(null, call);
        default: throw new Error(`Unsupported Connector method: ${method}`);
      }
    } catch (error) {
      throw this.connectorError(error);
    }
  }

  private awaitControl(timeoutMs: number, method: string): Promise<ConnectorChannel> {
    const ready = this.ready;
    if (!ready) return Promise.reject(new Error("Connector RPC is not available."));
    const output = this.rpcOutput;
    const child = this.rpcProcess;
    return new Promise<ConnectorChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        const message = `Connector RPC request timed out after ${Math.round(timeoutMs / 1_000)}s: ${method}`;
        const failure = new Error(withRecentOutput(message, output?.lines));
        reject(failure);
      }, timeoutMs);
      ready.promise.then(
        client => { clearTimeout(timer); resolve(client); },
        error => {
          clearTimeout(timer);
          // The process finalizer quotes the last stderr itself; a connection error is already final.
          reject(error);
        },
      );
    }).catch(async error => {
      if (this.rpcProcess === child) await this.terminateRpcProcess(true);
      throw error;
    });
  }

  private connectorError(error: unknown): Error {
    const value = error as { code?: unknown; message?: unknown; details?: Record<string, unknown> } | null;
    const code = value && typeof value.code === "string" ? value.code : "";
    if (!code) return error instanceof Error ? error : new Error(String(error));
    const details = value?.details;
    if (code === "connector_already_running") {
      this.keepRuntimeRunning = false;
      this.clearRestartTimer();
      const ownerRecord = details?.owner && typeof details.owner === "object" && !Array.isArray(details.owner)
        ? details.owner as Record<string, unknown>
        : undefined;
      const rawMessage = typeof value?.message === "string" ? value.message.trim() : "";
      const ownerParts = [
        typeof ownerRecord?.kind === "string" && ownerRecord.kind.trim() ? ownerRecord.kind.trim() : "",
        typeof ownerRecord?.pid === "number" && Number.isFinite(ownerRecord.pid) ? `PID ${ownerRecord.pid}` : "",
      ].filter(Boolean);
      const detailLine = rawMessage && rawMessage !== CONNECTOR_CONFLICT_MESSAGE
        ? rawMessage
        : ownerParts.length > 0
          ? `Another Connector is running (${ownerParts.join(", ")}).`
          : "";
      const conflictMessage = detailLine ? `${CONNECTOR_CONFLICT_MESSAGE}\n${detailLine}` : CONNECTOR_CONFLICT_MESSAGE;
      this.options.onOwnership?.({
        status: "conflict",
        message: conflictMessage,
        ...(ownerRecord ? { owner: ownerRecord as unknown as RuntimeOwner } : {}),
      });
      return new ConnectorRpcError(-32009, conflictMessage, { reason: "connector_already_running", ...(details ?? {}) });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ConnectorRpcError(-32000, message || "Connector RPC error", details ?? { reason: code });
  }

  private ensureRpcProcess(requiresConfig: boolean): void {
    if (this.rpcProcess) return;
    this.refreshLocalState();
    if (this.state.setupIssue && (requiresConfig || this.state.setupIssue !== "configMissing")) {
      throw new Error(`Connector setup is not ready: ${this.state.setupIssue}`);
    }
    const launcher = this.resolveLauncher(true);
    if (!launcher) throw new Error(`Connector setup is not ready: ${this.state.setupIssue || "launcherMissing"}`);
    const child = spawn(launcher.executable, launcher.args, {
      cwd: this.projectDir ?? this.options.connectorDir,
      env: this.connectorEnvironment(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rpcProcess = child;
    this.environment.recordProcess(child.pid);
    this.log(`Starting Connector RPC with ${launcher.description}`);
    this.ready = deferredControl();
    this.rpcReader = readline.createInterface({ input: child.stdout });
    this.rpcReader.on("line", (line) => this.handleRpcLine(line));
    // Whole lines only: uv writes one message in several chunks.
    const lines: string[] = [];
    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (line) => this.handleStderrLine(line, lines));
    this.rpcOutput = { lines, closed: new Promise((resolve) => stderr.once("close", () => resolve())) };
    child.once("error", (error) => {
      this.finalizeRpcProcess(child, `Connector RPC failed to start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.finalizeRpcProcess(child, `Connector RPC exited${signal ? ` by ${signal}` : ""} with code ${code ?? "null"}`);
    });
    child.once("close", (code, signal) => {
      this.finalizeRpcProcess(child, `Connector RPC closed${signal ? ` by ${signal}` : ""} with code ${code ?? "null"}`);
    });
  }

  private handleRpcLine(line: string): void {
    const ready = this.ready;
    if (!ready) return;
    const rendezvous = parseRendezvous(line);
    if (!rendezvous) {
      // stdout carries exactly one line: the ready message. Anything else is a
      // protocol error with no recovery path, so restart the process.
      ready.reject(new Error(`Connector RPC emitted an unexpected line: ${line.slice(0, RECENT_OUTPUT_LINE_LENGTH)}`));
      void this.terminateRpcProcess();
      return;
    }
    this.log({ level: "INFO", message: `Connector ready (${rendezvous.instanceId})` });
    void this.connect(rendezvous, ready).then(
      channel => ready.resolve(channel),
      error => {
        ready.reject(error);
        void this.terminateRpcProcess();
      },
    );
  }

  private async connect(rendezvous: Rendezvous, ready: { promise: Promise<ConnectorChannel> }): Promise<ConnectorChannel> {
    const fresh = () => this.ready === ready && this.rpcProcess !== null;
    if (this.options.connectControl) {
      const channel = await this.options.connectControl(rendezvous);
      if (!fresh()) { await channel.close?.().catch(() => undefined); throw new Error("Connector 进程在连接期间已退出。"); }
      this.channel = channel;
      this.watchStreams(channel);
      return channel;
    }
    const { Mesh, Router } = await import("meshcall");
    const mesh = new Mesh(new Router(rendezvous.endpoint), { token: rendezvous.key, peerId: `desktop-workbench-${rendezvous.instanceId}` });
    const deadline = Date.now() + CONTROL_CONNECT_TIMEOUT_MS;
    let backoff = 200;
    for (;;) {
      try { await mesh.connect(); break; } catch (error) {
        // The Connector owns the Router and restarts it; the endpoint and key stay the same.
        if (!fresh() || Date.now() >= deadline) {
          await mesh.close().catch(() => undefined);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 1_000);
      }
    }
    if (!fresh()) {
      await mesh.close().catch(() => undefined);
      throw new Error("Connector 进程在连接期间已退出。");
    }
    this.mesh = mesh;
    const channel: ConnectorChannel = { control: new ControlServiceClient(mesh), logs: new LogsServiceClient(mesh) };
    this.channel = channel;
    this.watchStreams(channel);
    return channel;
  }

  /** Follow state and log events; a dropped stream resumes after its last seq. */
  private watchStreams(channel: ConnectorChannel): void {
    const controller = new AbortController();
    this.streams = controller;
    this.options.onLogSourceChanged?.();
    const follow = async <T>(name: string, open: (since: number | null, signal: AbortSignal) => AsyncIterable<T>) => {
      let since: number | null = null;
      let backoff = 500;
      while (!controller.signal.aborted) {
        try {
          for await (const event of open(since, controller.signal)) {
            since = (event as { seq?: number }).seq ?? since;
            backoff = 500;
            this.handleEvent(event);
          }
          if (!controller.signal.aborted) throw new Error(`${name} stream ended`);
        } catch (error) {
          if (controller.signal.aborted) return;
          this.log({ level: "WARNING", message: `${name} stream interrupted: ${errorMessage(error)}` });
          await new Promise(resolve => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, 5_000);
        }
      }
    };
    void follow("Connector state", (since, signal) => channel.control.events(since, { signal }));
    void follow("Connector log", (since, signal) => channel.logs.tail(since, null, { signal }));
  }

  private handleEvent(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const value = event as { kind?: string; state?: unknown; level?: string; message?: string; time?: string; name?: string; exception?: string | null };
    if (value.kind === "state") {
      this.mergeRuntimeState(value.state);
      this.emitState();
      return;
    }
    if (typeof value.message === "string") {
      // Runtime records keep Connector's sequence and are never written by Desktop.
      const entry = event as LogEntry;
      this.options.onRuntimeLog?.({ ...entry, level: entry.level ?? "INFO" });
    }
  }

  private handleStderrLine(line: string, recent: string[]): void {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!plain) return;
    recent.push(plain.length > RECENT_OUTPUT_LINE_LENGTH ? `${plain.slice(0, RECENT_OUTPUT_LINE_LENGTH)}…` : plain);
    if (recent.length > RECENT_OUTPUT_LINES) recent.shift();
    const match = plain.match(/\|\s*(TRACE|DEBUG|INFO|SUCCESS|WARNING|ERROR|CRITICAL)\s*\|/);
    const uvMessage = /^(Using CPython|Creating virtual environment|Removed virtual environment|Building |Built |Downloading |Downloaded |Installed |Uninstalled |Resolved |Prepared |Audited )/.test(plain);
    this.log({ level: match?.[1] ?? (uvMessage ? "INFO" : "ERROR"), message: plain });
  }

  private finalizeRpcProcess(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.rpcProcess !== child) return;
    void terminateConnectorProcess(child).then(() => { if (!this.rpcProcess) this.environment.recordProcess(); }).catch(error => this.logError(error));
    this.log(message);
    this.rpcReader?.close();
    this.rpcReader = null;
    const output = this.rpcOutput;
    this.rpcOutput = null;
    this.rpcProcess = null;
    const ready = this.ready;
    this.ready = null;
    this.streams?.abort();
    this.streams = null;
    const mesh = this.mesh;
    const channel = this.channel;
    this.mesh = null;
    this.channel = null;
    if (channel) this.options.onLogSourceChanged?.();
    void mesh?.close().catch(() => undefined);
    void channel?.close?.().catch(() => undefined);
    const expected = this.shuttingDown || this.terminating.has(child);
    const drained = Promise.race([
      output?.closed ?? Promise.resolve(),
      new Promise<void>(resolve => setTimeout(resolve, OUTPUT_DRAIN_MS)),
    ]);
    void drained.then(() => {
      const reason = withRecentOutput(message, output?.lines);
      ready?.reject(new Error(reason));
      // The Connector reports its own errors while it runs; an exit nobody
      // asked for leaves none, so record it until a new process reports.
      if (expected || this.rpcProcess !== null) return;
      this.state.lastError = reason;
      this.emitState();
    });
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

  private terminateRpcProcess(suppressRestart = false): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = this.terminate(suppressRestart).finally(() => { this.termination = null; });
    return this.termination;
  }

  private async terminate(suppressRestart: boolean): Promise<void> {
    const child = this.rpcProcess;
    if (!child) return;
    this.terminating.add(child);
    const previousSuppression = this.suppressProcessRestart;
    this.suppressProcessRestart = this.suppressProcessRestart || suppressRestart;
    await terminateConnectorProcess(child);
    if (this.rpcProcess === child) this.finalizeRpcProcess(child, "Connector RPC was terminated.");
    this.suppressProcessRestart = previousSuppression;
  }

  /** Only a launch materializes the project copy; state checks stay read-only. */
  private resolveLauncher(materialize = false): ConnectorLauncher | null {
    const direct = this.resolveDirectConnectorCli();
    if (direct) {
      this.state.uvMissing = false;
      this.state.resolvedUvPath = "";
      this.state.resolvedPythonPath = "";
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
    const python = this.resolvePythonPath();
    this.state.resolvedPythonPath = python;
    const projectDir = this.options.packaged && materialize
      ? this.projectDir ??= materializeConnectorProject(this.options.connectorDir, this.options.dataPath)
      : this.projectDir ?? this.options.connectorDir;
    // An explicit interpreter keeps uv from choosing, or downloading, one itself.
    const pythonArgs = python ? ["--python", python] : [];
    return {
      executable: uv,
      args: ["run", "--no-sync", "--project", projectDir, ...pythonArgs, "anywhere-cli", "rpc", "--config", this.options.configPath],
      description: `${uv} run --project ${projectDir}${python ? ` --python ${python}` : ""}`,
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

  /**
   * Where `uv run --project` keeps this project's environment: the packaged
   * app always forces it under `userData` (see `connectorEnvironment`),
   * development uses `UV_PROJECT_ENVIRONMENT` or the repo's `.venv`.
   */
  private projectEnvironmentPath(): string {
    if (this.options.packaged) return path.join(this.options.dataPath, ".venv");
    const configured = (this.shellEnvironment.UV_PROJECT_ENVIRONMENT ?? process.env.UV_PROJECT_ENVIRONMENT)?.trim();
    return configured ? path.resolve(this.projectDir ?? this.options.connectorDir, configured) : path.join(this.options.connectorDir, ".venv");
  }

  /**
   * A saved `uvPath` wins because it is an explicit user choice. Otherwise the
   * bundled uv wins in development exactly as it does when packaged, so a dev
   * launch never depends on the developer's PATH; PATH is only the last resort.
   */
  private resolveUvPath(): string {
    const executableName = process.platform === "win32" ? "uv.exe" : "uv";
    const configured = this.options.settings.get().uvPath;
    const bundled = path.join(this.options.uvBundleDir, `${process.platform}-${process.arch}`, executableName);
    for (const candidate of [configured, bundled, executableName]) {
      const resolved = this.resolveExecutable(candidate);
      if (resolved) return resolved;
    }
    return "";
  }

  /**
   * A saved `pythonPath` wins because it is an explicit user choice, then the
   * bundled CPython. Empty lets uv pick an interpreter itself, downloading one
   * when needed; only development without `yarn bundle:python` gets there.
   */
  private resolvePythonPath(): string {
    const configured = this.options.settings.get().pythonPath;
    for (const candidate of [configured, bundledPythonExecutable(this.options.pythonBundleDir)]) {
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
      AA_CONNECTOR_OWNER_KIND: "desktop-workbench",
      PATH: [...new Set(entries)].join(path.delimiter),
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      FORCE_COLOR: "0",
    };
    if (this.options.packaged) {
      environment.UV_PROJECT_ENVIRONMENT = this.projectEnvironmentPath();
      environment.UV_CACHE_DIR = path.join(this.options.dataPath, "uv-cache");
    }
    // The chosen mirror is the first index and PyPI the fallback: uv takes
    // each package from the first index that has it, so a mirror that
    // filters large wheels (TUNA, USTC and BFSU carry no openai-codex) still
    // installs. Every index is explicit because the bundled project or the
    // inherited shell environment may declare others.
    const settings = this.options.settings.get();
    const mirror = settings.uvPypiIndexUrl.replace(/\/+$/, "");
    environment.UV_DEFAULT_INDEX = PYPI_SIMPLE;
    environment.UV_INDEX_URL = PYPI_SIMPLE;
    if (mirror && mirror !== PYPI_SIMPLE) environment.UV_INDEX = mirror;
    else delete environment.UV_INDEX;
    environment.PIP_INDEX_URL = mirror || PYPI_SIMPLE;
    // Without a bundled or saved interpreter uv downloads CPython itself; the default is GitHub.
    environment.UV_PYTHON_INSTALL_MIRROR = settings.uvPythonInstallMirror || PYTHON_BUILDS_GITHUB;
    environment.UV_HTTP_TIMEOUT ||= UV_HTTP_TIMEOUT_SECONDS;
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
    | "pythonPath"
    | "uvPypiIndexUrl"
    | "uvPythonInstallMirror"
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
      pythonPath: settings.pythonPath,
      uvPypiIndexUrl: settings.uvPypiIndexUrl,
      uvPythonInstallMirror: settings.uvPythonInstallMirror,
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
    if (typeof next.logsPath === "string" && next.logsPath.trim()) this.state.logsPath = next.logsPath;
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

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

interface Rendezvous {
  kind: "connector.ready";
  version: 1;
  instanceId: string;
  pid: number;
  endpoint: { unixPath: string } | { pipe: string };
  key: string;
}

function parseRendezvous(line: string): Rendezvous | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const endpoint = value.endpoint && typeof value.endpoint === "object" ? value.endpoint as Record<string, unknown> : {};
  const local = typeof endpoint.unixPath === "string" ? { unixPath: endpoint.unixPath }
    : typeof endpoint.pipe === "string" ? { pipe: endpoint.pipe } : undefined;
  if (value.kind !== "connector.ready" || value.version !== 1 || !local || !Number.isSafeInteger(value.pid)
    || typeof value.instanceId !== "string" || typeof value.key !== "string" || !value.key.startsWith("mk_")) return undefined;
  return { kind: "connector.ready", version: 1, instanceId: value.instanceId, pid: value.pid as number, endpoint: local, key: value.key };
}

function deferredControl(): { promise: Promise<ConnectorChannel>; resolve: (channel: ConnectorChannel) => void; reject: (error: Error) => void } {
  let resolve!: (channel: ConnectorChannel) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ConnectorChannel>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

function withRecentOutput(message: string, lines: readonly string[] = []): string {
  return lines.length > 0 ? `${message}\nLast output:\n${lines.join("\n")}` : message;
}
