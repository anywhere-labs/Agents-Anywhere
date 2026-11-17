import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Mesh as MeshConnection } from "meshcall" with { "resolution-mode": "import" };
import { ConnectorRpcError, CONNECTOR_CONFLICT_MESSAGE } from "./connector-rpc-error";
import type { ConnectorHostMessage, ConnectorProcess, LaunchConnector } from "./connector-launcher";
import type { DesktopBindingStore } from "./desktop-binding";
import type { DesktopSettingsStore } from "./desktop-settings";
import { removeFile, writeJsonFile } from "./json-store";
import { localRuntimePath, type OwnershipState, type RuntimeOwner } from "./local-runtime";
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

/** The Connector starts its Router and control service within seconds; a cold start can take longer. */
const CONTROL_CONNECT_TIMEOUT_MS = 20_000;
/**
 * Claiming the machine can wait for an older Connector to finish its turns and
 * hand over (v3 design 04-connector.md §9.1: up to five minutes by default).
 */
const OWNERSHIP_TIMEOUT_MS = 330_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
/** How long a Connector asked to stop may take before it is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
const RECENT_OUTPUT_LINES = 12;
const RECENT_OUTPUT_LINE_LENGTH = 500;
/** The decision a newer (or same-version) Connector's lease reports: use it, do not compete. */
const USE_EXISTING = "use_existing";
const NEWER_CONNECTOR_MESSAGE = "这台电脑上已有更新版本的 Connector 在运行（命令行或 DSH 插件），由它连接服务器。Desktop 不会再启动自己的 Connector。";
const HANDED_OVER_MESSAGE = "更新版本的 Connector 已接管这台电脑，Desktop 内置的 Connector 已让出。";

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

/** What a ready Connector posted: how to reach its control channel as the `host` role. */
export interface Rendezvous {
  kind: "connector.ready";
  version: 1;
  instanceId: string;
  pid: number;
  endpoint: { unixPath?: string; namedPipe?: string; host?: string; port?: number };
  key: string;
}

type ConnectorSupervisorOptions = {
  onOwnership?: (state: OwnershipState) => void;
  configPath: string;
  dataPath: string;
  resourcesPath: string;
  packaged: boolean;
  homePath: string;
  /** The bundled local MeshCall Router; empty uses `MESHCALL_ROUTER_BINARY` or meshcall's lookup. */
  routerBinary?: string;
  /** The bundled frp client for port preview; empty refuses previews. */
  frpcBinary?: string;
  shellEnvironment: NodeJS.ProcessEnv;
  settings: DesktopSettingsStore;
  binding: DesktopBindingStore;
  logs: ConnectorLogStore;
  /** Starts one embedded Connector (Main forks it as a utility process). */
  launch: LaunchConnector;
  onState: (state: ConnectorState) => void;
  onLog: (entry: ConnectorLogEntry) => void;
  onRuntimeLog?: (entry: ConnectorLogEntry) => void;
  onLogSourceChanged?: () => void;
  /** The Connector reported device settings the server handed over. */
  onDeviceSettings?: (settings: { confirmQuitOnShutdown: boolean }) => void;
  /** Test seam; production connects a Mesh to the Connector's Router. */
  connectControl?: (rendezvous: Rendezvous) => Promise<ConnectorChannel>;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

/**
 * Desktop's embedded TS Connector (v3 design 04-connector.md §9.4).
 *
 * Main forks `desktop-main.js` as an Electron utility process; it posts a
 * ready descriptor over its parent port, and Desktop then drives it exactly as
 * it drove the v2 Python Connector: `aa.local.v2.Control` and `Logs` over the
 * Connector's local MeshCall Router. There is no environment to prepare: the
 * Connector is a JS bundle that runs on Electron's own Node.
 *
 * Version arbitration happens inside the Connector's lease. Desktop only
 * reacts to the outcome: a newer Connector already running (`use_existing`)
 * or a newer one taking over from Desktop's (`handed_over`) means Desktop
 * stops competing and says so.
 */
export class ConnectorSupervisor {
  private process: ConnectorProcess | null = null;
  private ready: Deferred<ConnectorChannel> | null = null;
  private acquisition: Promise<void> | null = null;
  private claimedProcess: ConnectorProcess | null = null;
  private mesh: MeshConnection | null = null;
  private channel: ConnectorChannel | null = null;
  private streams: AbortController | null = null;
  private recentOutput: string[] = [];
  private shuttingDown = false;
  private keepRuntimeRunning = false;
  /** A newer Connector serves this computer; Desktop does not start or restart its own. */
  private yielded = false;
  private crashCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Processes this supervisor is stopping on purpose; their exit is not an error. */
  private readonly terminating = new WeakSet<ConnectorProcess>();
  /** Processes stopped to be rebuilt (an unresponsive control service): a running runtime comes back. */
  private readonly rebuilding = new WeakSet<ConnectorProcess>();
  private readonly exits = new WeakMap<ConnectorProcess, Promise<void>>();
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
      ...this.publicSettings(),
    };
    this.refreshLocalState();
  }

  setShellEnvironment(environment: NodeJS.ProcessEnv): void {
    this.shellEnvironment = environment;
  }

  /** Only the proxy setting reaches the Connector; it lives in its config, so a change restarts it. */
  async applySettings(previous: DesktopSettings): Promise<ConnectorState> {
    const current = this.options.settings.get();
    this.refreshLocalState();
    if (previous.connectorProxy === current.connectorProxy) return this.emitState();
    const config = this.loadPrivateConfig();
    if (!config || !this.process) return this.emitState();
    const shouldRestart = this.keepRuntimeRunning || this.state.running;
    await this.saveCredentials(config);
    return shouldRestart ? this.restart() : this.emitState();
  }

  bindingChanged(): ConnectorState {
    this.refreshLocalState();
    return this.emitState();
  }

  publicState(): ConnectorState {
    this.refreshBindingState();
    return { ...this.state };
  }

  hasRuntimeLogs(): boolean { return this.channel !== null; }

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
    if (this.yielded) return this.emitState();
    try {
      this.mergeRuntimeState(await this.request("connector.getState", undefined, { requiresConfig: false }));
    } catch (error) {
      this.logError(error);
    }
    return this.emitState();
  }

  /** The first probe after launch: claims the machine before any credentials exist. */
  async preflightProvisioning(): Promise<ConnectorState> {
    fs.mkdirSync(this.options.dataPath, { recursive: true, mode: 0o700 });
    fs.accessSync(this.options.dataPath, fs.constants.R_OK | fs.constants.W_OK);
    this.mergeRuntimeState(await this.request("connector.acquireOwnership", undefined, { requiresConfig: false, timeoutMs: OWNERSHIP_TIMEOUT_MS }));
    return this.emitState();
  }

  acquireOwnership(): Promise<void> {
    if (this.acquisition) return this.acquisition;
    if (this.shuttingDown) return Promise.reject(new Error("Connector is stopping."));
    this.acquisition = this.acquire().finally(() => { this.acquisition = null; });
    return this.acquisition;
  }

  private async acquire(): Promise<void> {
    try {
      // A recheck after Desktop yielded tries again: the newer Connector may be gone.
      this.yielded = false;
      // Revalidating a live lease must not unmount the workspace.
      if (!this.process || this.claimedProcess !== this.process) this.options.onOwnership?.({ status: "checking" });
      await this.request("connector.acquireOwnership", undefined, { requiresConfig: false, timeoutMs: OWNERSHIP_TIMEOUT_MS });
      this.claimedProcess = this.process;
      this.options.onOwnership?.({ status: "owned" });
    } catch (error) {
      this.claimedProcess = null;
      const conflict = error instanceof ConnectorRpcError && error.ownershipConflict;
      const message = errorMessage(error);
      this.log({ level: conflict ? "WARNING" : "ERROR", message: `Could not acquire Connector ownership: ${message}` });
      if (!conflict) this.options.onOwnership?.({ status: "error", message });
      throw error;
    }
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
      return { serverUrl: binding?.serverUrl ?? "", connectorId: binding?.connectorId ?? "", hasCredential: false };
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
    // Persist first so a crash after the Server creates a device does not lose
    // the only copy of its one-time Connector token.
    writeJsonFile(this.options.configPath, normalized);
    this.mergeRuntimeState({ hasConfig: true, authFailed: false, lastError: null });
    this.refreshLocalState();
    this.emitState();
    try {
      const result = await this.request("connector.saveConfig", this.connectorConfig(normalized), { requiresConfig: false });
      return sanitizeConfig(parsePrivateConfig(result));
    } catch (error) {
      this.log({ level: "WARNING", message: `Connector credentials were stored for recovery, but the Connector did not acknowledge them: ${errorMessage(error)}` });
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
    this.mergeRuntimeState(await this.request("connector.start", undefined, { requiresConfig: true, timeoutMs: OWNERSHIP_TIMEOUT_MS }));
    return this.emitState();
  }

  async stop(): Promise<ConnectorState> {
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    if (this.process) {
      this.mergeRuntimeState(await this.request("connector.stop", undefined, { requiresConfig: false, timeoutMs: 10_000 }));
    } else {
      this.mergeRuntimeState({ running: false, status: "stopped" });
    }
    return this.emitState();
  }

  async restart(): Promise<ConnectorState> {
    this.keepRuntimeRunning = true;
    this.clearRestartTimer();
    this.mergeRuntimeState(await this.request("connector.restart", undefined, { requiresConfig: true, timeoutMs: OWNERSHIP_TIMEOUT_MS }));
    return this.emitState();
  }

  async clearCredentials(): Promise<ConnectorState> {
    try {
      await this.stop();
    } catch (error) {
      this.log({ level: "WARNING", message: errorMessage(error) });
    }
    removeFile(this.options.configPath);
    this.mergeRuntimeState({ status: "stopped", running: false, authFailed: false, lastError: null, hasConfig: false });
    this.refreshLocalState();
    return this.emitState();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    await this.acquisition?.catch(() => undefined);
    await this.terminate();
  }

  /** Call one method of `aa.local.v2.Control`, starting the Connector first when needed. */
  private async request(method: string, params?: unknown, options: { requiresConfig?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.shuttingDown) throw new Error("Connector is stopping.");
    if (this.yielded) throw this.yieldedError();
    // A process on its way out (stepping aside, a rebuild) is not reused: wait for it, then launch anew.
    const leaving = this.process;
    if (leaving && this.terminating.has(leaving)) await this.exits.get(leaving);
    if (this.shuttingDown) throw new Error("Connector is stopping.");
    this.ensureProcess(options.requiresConfig !== false);
    const control = (await this.awaitControl(method)).control;
    const call = { timeoutMs: options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS };
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

  private awaitControl(method: string): Promise<ConnectorChannel> {
    const ready = this.ready;
    if (!ready) return Promise.reject(new Error("Connector is not available."));
    const child = this.process;
    return new Promise<ConnectorChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(withRecentOutput(`Connector did not become ready within ${Math.round(CONTROL_CONNECT_TIMEOUT_MS / 1_000)}s: ${method}`, this.recentOutput)));
      }, CONTROL_CONNECT_TIMEOUT_MS);
      ready.promise.then(
        channel => { clearTimeout(timer); resolve(channel); },
        error => { clearTimeout(timer); reject(error); },
      );
    }).catch(async error => {
      if (this.process === child) await this.terminate();
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
      if (details?.decision === USE_EXISTING) return this.yieldTo(ownerRecord, NEWER_CONNECTOR_MESSAGE, details);
      const rawMessage = typeof value?.message === "string" ? value.message.trim() : "";
      const ownerParts = [
        typeof ownerRecord?.kind === "string" && ownerRecord.kind.trim() ? ownerRecord.kind.trim() : "",
        typeof ownerRecord?.pid === "number" && Number.isFinite(ownerRecord.pid) ? `PID ${ownerRecord.pid}` : "",
      ].filter(Boolean);
      const detailLine = rawMessage && rawMessage !== CONNECTOR_CONFLICT_MESSAGE
        ? rawMessage
        : ownerParts.length > 0 ? `Another Connector is running (${ownerParts.join(", ")}).` : "";
      const conflictMessage = detailLine ? `${CONNECTOR_CONFLICT_MESSAGE}\n${detailLine}` : CONNECTOR_CONFLICT_MESSAGE;
      this.options.onOwnership?.({
        status: "conflict",
        message: conflictMessage,
        ...(ownerRecord ? { owner: ownerRecord as unknown as RuntimeOwner } : {}),
      });
      return new ConnectorRpcError(-32009, conflictMessage, { reason: "connector_already_running", ...(details ?? {}) });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ConnectorRpcError(-32000, message || "Connector error", details ?? { reason: code });
  }

  /**
   * A newer Connector serves this computer (04-connector.md §9.1). Desktop's own
   * process exits and stays stopped; a recheck from the gate tries again.
   */
  private yieldTo(owner: Record<string, unknown> | undefined, message: string, details?: Record<string, unknown>): ConnectorRpcError {
    this.yielded = true;
    this.keepRuntimeRunning = false;
    this.clearRestartTimer();
    this.claimedProcess = null;
    this.log({ level: "INFO", message });
    this.options.onOwnership?.({
      status: "conflict",
      message,
      recovery: { kind: "newerConnector" },
      ...(owner ? { owner: owner as unknown as RuntimeOwner } : {}),
    });
    void this.terminate().catch(error => this.logError(error));
    return new ConnectorRpcError(-32009, message, { reason: "connector_already_running", decision: USE_EXISTING, ...(details ?? {}) });
  }

  private yieldedError(): ConnectorRpcError {
    return new ConnectorRpcError(-32009, NEWER_CONNECTOR_MESSAGE, { reason: "connector_already_running", decision: USE_EXISTING });
  }

  private ensureProcess(requiresConfig: boolean): void {
    if (this.process) return;
    this.refreshLocalState();
    if (requiresConfig && this.state.setupIssue) throw new Error(`Connector setup is not ready: ${this.state.setupIssue}`);
    const child = this.options.launch(this.connectorEnvironment());
    this.process = child;
    this.recentOutput = [];
    this.ready = deferred<ConnectorChannel>();
    const ready = this.ready;
    // A rejection nobody awaits yet must not surface as unhandled.
    ready.promise.catch(() => undefined);
    let exitResolve!: () => void;
    this.exits.set(child, new Promise<void>(resolve => { exitResolve = resolve; }));
    this.log("Starting the embedded Connector");
    child.onOutput(line => this.handleOutputLine(line));
    child.onMessage(message => this.handleHostMessage(child, ready, message));
    child.onExit(({ code, error }) => {
      exitResolve();
      this.finalizeProcess(child, error ? `Connector failed to start: ${error}` : `Connector exited with code ${code ?? "null"}`);
    });
  }

  private handleHostMessage(child: ConnectorProcess, ready: Deferred<ConnectorChannel>, message: ConnectorHostMessage): void {
    if (this.process !== child || !message || typeof message !== "object") return;
    if (message.type === "ready") {
      const rendezvous = parseRendezvous(message);
      if (!rendezvous) {
        ready.reject(new Error("The Connector posted an invalid ready message."));
        void this.terminate().catch(error => this.logError(error));
        return;
      }
      this.log({ level: "INFO", message: `Connector ready (${rendezvous.instanceId}, PID ${rendezvous.pid})` });
      void this.connect(rendezvous, ready).then(
        channel => ready.resolve(channel),
        error => {
          ready.reject(error instanceof Error ? error : new Error(String(error)));
          void this.terminate().catch(failure => this.logError(failure));
        },
      );
      return;
    }
    if (message.type === "failed") {
      const reason = `Connector failed to start (${message.code}): ${message.message}`;
      this.log({ level: "ERROR", message: reason });
      ready.reject(new Error(withRecentOutput(reason, this.recentOutput)));
      return;
    }
    if (message.type === "stopped") {
      // The Connector has finished its shutdown; its parent port alone keeps the process alive.
      this.terminating.add(child);
      child.kill();
      // A newer Connector asked this one to hand over and it did (04-connector.md §9.1).
      if (message.reason === "handed_over") this.yieldTo(undefined, HANDED_OVER_MESSAGE);
    }
  }

  private async connect(rendezvous: Rendezvous, ready: Deferred<ConnectorChannel>): Promise<ConnectorChannel> {
    const fresh = () => this.ready === ready && this.process !== null;
    if (this.options.connectControl) {
      const channel = await this.options.connectControl(rendezvous);
      if (!fresh()) { await channel.close?.().catch(() => undefined); throw new Error("Connector 进程在连接期间已退出。"); }
      this.channel = channel;
      this.watchStreams(channel);
      return channel;
    }
    const { Mesh, Router } = await import("meshcall");
    const mesh = new Mesh(new Router(rendezvous.endpoint as never), { token: rendezvous.key, peerId: `desktop-workbench-${rendezvous.instanceId}` });
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
    const child = this.process;
    let probing = false;
    let failures = 0;
    // A live process can lose its control service or block its event loop.
    const healthCheck = setInterval(() => {
      if (probing || controller.signal.aborted || this.shuttingDown || !this.keepRuntimeRunning || this.state.authFailed) return;
      probing = true;
      void (async () => {
        try {
          await channel.control.getState({ timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
          failures = 0;
        } catch (error) {
          if (controller.signal.aborted || this.process !== child || this.shuttingDown || !this.keepRuntimeRunning || this.state.authFailed) return;
          if (++failures < 2) return;
          this.log({ level: "WARNING", message: `Connector control service is unresponsive; restarting it: ${errorMessage(error)}` });
          await this.terminate({ rebuild: true });
        } finally {
          probing = false;
        }
      })().catch(error => this.logError(error));
    }, HEALTH_CHECK_INTERVAL_MS);
    healthCheck.unref();
    controller.signal.addEventListener("abort", () => clearInterval(healthCheck), { once: true });
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
    const value = event as { kind?: string; state?: unknown; message?: string };
    if (value.kind === "state") {
      this.mergeRuntimeState(value.state);
      this.emitState();
      return;
    }
    if (typeof value.message === "string") {
      // Runtime records keep the Connector's sequence and are never written by Desktop.
      const entry = event as LogEntry;
      this.options.onRuntimeLog?.({ ...entry, level: entry.level ?? "INFO" });
    }
  }

  /** The Connector logs through `aa.local.v2.Logs`; what it prints is a crash or an early failure. */
  private handleOutputLine(line: string): void {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!plain) return;
    this.recentOutput.push(plain.length > RECENT_OUTPUT_LINE_LENGTH ? `${plain.slice(0, RECENT_OUTPUT_LINE_LENGTH)}…` : plain);
    if (this.recentOutput.length > RECENT_OUTPUT_LINES) this.recentOutput.shift();
    this.log({ level: "WARNING", message: plain });
  }

  private finalizeProcess(child: ConnectorProcess, message: string): void {
    if (this.process !== child) return;
    this.log(message);
    const output = [...this.recentOutput];
    this.process = null;
    this.claimedProcess = this.claimedProcess === child ? null : this.claimedProcess;
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
    const expected = this.shuttingDown || this.terminating.has(child) || this.yielded;
    const rebuild = this.rebuilding.has(child) && !this.shuttingDown && !this.yielded;
    const reason = withRecentOutput(message, output);
    ready?.reject(new Error(reason));
    this.mergeRuntimeState({ running: false, status: "stopped" });
    // The Connector reports its own errors while it runs; an exit nobody asked
    // for leaves none, so record it until a new process reports.
    if (!expected) this.state.lastError = reason;
    this.emitState();
    if ((!expected || rebuild) && this.keepRuntimeRunning && !this.state.authFailed && this.hasCredential()) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.state.authFailed || this.yielded) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.crashCount++, 5));
    this.log({ level: "WARNING", message: `Connector will restart in ${delay}ms.` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch(error => {
        this.logError(error);
        if (this.keepRuntimeRunning && !this.shuttingDown && !this.state.authFailed && !this.yielded) this.scheduleRestart();
      });
    }, delay);
  }

  /** Ask the Connector to stop (it finishes its shutdown and posts `stopped`), then kill it if it does not exit. */
  private async terminate(options: { rebuild?: boolean } = {}): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.terminating.add(child);
    if (options.rebuild) this.rebuilding.add(child);
    const exited = this.exits.get(child) ?? Promise.resolve();
    child.shutdown();
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS); }),
    ]);
    clearTimeout(timer);
    if (!graceful) {
      this.log({ level: "WARNING", message: "The Connector did not stop in time; killing it." });
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
    }
    if (this.process === child) this.finalizeProcess(child, "Connector was stopped.");
  }

  /** Desktop's config file, its Router and settings; the Connector's data dir is the shared `~/.agents-anywhere/v3`. */
  private connectorEnvironment(): Record<string, string> {
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...this.shellEnvironment,
      PATH: this.pathEntries().join(path.delimiter),
      AA_CONNECTOR_OWNER_KIND: "desktop-workbench",
      // Desktop keeps the device binding it always had (`<userData>/connector/connector.json`).
      AGENT_CONNECTOR_CONFIG: this.options.configPath,
      // ACP adapters run on this Electron executable as Node (04-connector.md §9.4).
      AA_ELECTRON_NODE: process.execPath,
      AA_PI_NPM_ROOT: path.join(this.options.dataPath, "pi-npm-runtimes"),
      FORCE_COLOR: "0",
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    if (this.options.routerBinary) environment.MESHCALL_ROUTER_BINARY = this.options.routerBinary;
    if (this.options.frpcBinary) environment.AA_FRPC_BINARY = this.options.frpcBinary;
    // A preview tunnel leaves the way the device link does when that is an explicit proxy.
    const proxy = this.options.settings.get().connectorProxy;
    if (proxy && proxy !== "direct") environment.AA_PREVIEW_PROXY = proxy;
    else delete environment.AA_PREVIEW_PROXY;
    const piBundle = this.options.packaged
      ? path.join(this.options.resourcesPath, "pi-runtime")
      : path.resolve(__dirname, "..", "..", "build", "pi-runtime");
    if (fs.existsSync(path.join(piBundle, "package.json"))) environment.AA_PI_BUNDLED_RUNTIME = piBundle;
    else delete environment.AA_PI_BUNDLED_RUNTIME;
    if (process.platform === "win32") {
      delete environment.Path;
      delete environment.path;
      environment.Path = environment.PATH;
    }
    return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }

  /** The config Desktop hands the Connector: its saved binding plus the proxy setting. */
  private connectorConfig(config: ConnectorPrivateConfig): ControlSettings {
    const proxy = this.options.settings.get().connectorProxy;
    return { ...config, proxy: proxy || "system" } as ControlSettings;
  }

  private pathEntries(): string[] {
    const entries: string[] = [];
    for (const environment of [process.env, this.shellEnvironment]) {
      const value = environment.PATH || environment.Path || environment.path;
      if (value) entries.push(...value.split(path.delimiter));
    }
    if (process.platform === "darwin") {
      entries.push(path.join(this.options.homePath, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA || path.join(this.options.homePath, "AppData", "Roaming");
      const localAppData = process.env.LOCALAPPDATA || path.join(this.options.homePath, "AppData", "Local");
      entries.push(path.join(this.options.homePath, "scoop", "shims"), path.join(localAppData, "Microsoft", "WinGet", "Packages"), path.join(appData, "npm"));
    }
    return [...new Set(entries.filter(Boolean))];
  }

  private refreshLocalState(): void {
    const config = this.loadPrivateConfig();
    this.state.hasConfig = Boolean(config);
    this.state.hasCredential = Boolean(config?.connectorToken);
    this.state.setupIssue = config ? "" : "configMissing";
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

  private publicSettings(): Pick<ConnectorState,
    "openAtLogin" | "startConnectorOnLaunch" | "silentLaunch" | "notificationsEnabled" | "confirmQuitOnShutdown"
    | "connectorProxy" | "logChunkSizeKb" | "logRetainChunks" | "logRetentionDays"> {
    const settings = this.options.settings.get();
    return {
      openAtLogin: settings.openAtLogin,
      startConnectorOnLaunch: settings.startConnectorOnLaunch,
      silentLaunch: settings.silentLaunch,
      notificationsEnabled: settings.notificationsEnabled,
      confirmQuitOnShutdown: settings.confirmQuitOnShutdown,
      connectorProxy: settings.connectorProxy,
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
    const deviceSettings = next.deviceSettings as Record<string, unknown> | null | undefined;
    if (deviceSettings && typeof deviceSettings.confirmQuitOnShutdown === "boolean") {
      this.options.onDeviceSettings?.({ confirmQuitOnShutdown: deviceSettings.confirmQuitOnShutdown });
    }
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

function parseRendezvous(value: unknown): Rendezvous | undefined {
  const message = value as Partial<Rendezvous> | null;
  if (!message || message.kind !== "connector.ready" || message.version !== 1) return undefined;
  if (typeof message.instanceId !== "string" || typeof message.key !== "string" || !message.endpoint || typeof message.endpoint !== "object") return undefined;
  return {
    kind: "connector.ready",
    version: 1,
    instanceId: message.instanceId,
    pid: typeof message.pid === "number" ? message.pid : 0,
    endpoint: message.endpoint,
    key: message.key,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function parsePrivateConfig(value: unknown): ConnectorPrivateConfig {
  if (!value || typeof value !== "object") throw new Error("Connector config must be an object.");
  const config = value as Record<string, unknown>;
  const serverUrl = String(config.serverUrl ?? "").trim().replace(/\/+$/, "");
  const connectorId = String(config.connectorId ?? "").trim();
  const connectorToken = String(config.connectorToken ?? "").trim();
  if (!serverUrl || !connectorId || !connectorToken) throw new Error("serverUrl, connectorId, and connectorToken are required.");
  return {
    serverUrl,
    connectorId,
    connectorToken,
    heartbeatSeconds: Number(config.heartbeatSeconds ?? 20),
    reconnectSeconds: Number(config.reconnectSeconds ?? 3),
    syncExistingOnConnect: config.syncExistingOnConnect === undefined ? true : Boolean(config.syncExistingOnConnect),
    syncIntervalSeconds: Number(config.syncIntervalSeconds ?? 30),
    statePath: typeof config.statePath === "string" ? config.statePath : null,
  };
}

function sanitizeConfig(config: ConnectorPrivateConfig): ConnectorPublicConfig {
  const { connectorToken: _token, ...rest } = config;
  return { ...rest, hasCredential: Boolean(config.connectorToken) };
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withRecentOutput(message: string, lines: readonly string[] = []): string {
  return lines.length ? `${message}\nLast output:\n${lines.join("\n")}` : message;
}
