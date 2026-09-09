import { EventEmitter } from "node:events";
import { ConnectorLogStore } from "../log-store";
import { ConnectorSupervisor } from "../connector-supervisor";
import { DesktopBindingStore } from "../desktop-binding";
import { DesktopDeviceService } from "../desktop-device-service";
import { DesktopSettingsStore } from "../desktop-settings";
import { desktopInstallation, MachineStateStore } from "../machine-state";
import type { DesktopOnboardingSource, DesktopOnboardingState } from "../machine-state";
import { readShellEnvironment } from "../shell-environment";
import { LogBatcher } from "./log-batcher";
import type { OwnershipState } from "../local-runtime";
import type {
  ConnectorConfigPatch,
  ConnectorLogEntry,
  ConnectorLogPage,
  ConnectorLogQuery,
  ConnectorState,
  DesktopDeviceAuthInput,
  DesktopDeviceNameInput,
  DesktopDeviceProvisionInput,
  DesktopDeviceReconnectInput,
  DesktopSettings,
  DesktopSettingsPatch,
  PublicLocalDesktopBinding,
} from "../connector-types";
import type { BackendEventName, BackendInit } from "./protocol";

/**
 * Outbound HTTP for device registration. It is injected so the backend can
 * reuse the main process's Chromium network stack (system proxy, certificates)
 * instead of the plain Node agent.
 */
export type BackendFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

type EventName = BackendEventName;

/**
 * Owns every stateful Desktop service. Construction is synchronous so the
 * process can report ready immediately; the two slow startup steps (reading the
 * login shell environment and the first Connector ownership probe) run in
 * `initialize()` and never delay the window.
 */
export class BackendState {
  private readonly events = new EventEmitter();
  private readonly settings: DesktopSettingsStore;
  private readonly logs: ConnectorLogStore;
  private readonly binding: DesktopBindingStore;
  private readonly machineState: MachineStateStore;
  private readonly connector: ConnectorSupervisor;
  private readonly devices: DesktopDeviceService;
  private ownership: OwnershipState = { status: "error", message: "正在检查本机 Connector…" };
  private readonly logBatcher = new LogBatcher((batch) => this.emit("logs", batch));
  private closed = false;
  private initialized = false;

  constructor(private readonly init: BackendInit, fetcher: BackendFetcher) {
    this.machineState = new MachineStateStore();
    this.settings = new DesktopSettingsStore(init.settingsPath, init.preferredLanguages);
    this.logs = new ConnectorLogStore(init.logsPath, () => this.settings.get());
    this.binding = new DesktopBindingStore(init.bindingPath);
    this.connector = new ConnectorSupervisor({
      onOwnership: (state) => {
        this.ownership = state;
        this.emit("ownership", state);
      },
      configPath: init.configPath,
      dataPath: init.dataPath,
      connectorDir: init.connectorDir,
      resourcesPath: init.resourcesPath,
      packaged: init.packaged,
      homePath: init.homePath,
      shellEnvironment: {},
      settings: this.settings,
      binding: this.binding,
      logs: this.logs,
      onState: (state) => this.emit("state", state),
      onLog: (entry) => this.bufferLog(entry),
    });
    this.devices = new DesktopDeviceService({
      requireOwnership: () => this.requireOwnership(),
      binding: this.binding,
      connector: this.connector,
      fetcher,
      defaultServerUrl: () => init.defaultServerUrl,
      apiNamespace: () => init.apiNamespace,
      readLocalConnectorIds: () => this.machineState.readConnectorIds(),
    });
  }

  on(event: EventName, listener: (data: unknown) => void): void {
    this.events.on(event, listener);
  }

  off(event: EventName, listener: (data: unknown) => void): void {
    this.events.off(event, listener);
  }

  /**
   * Startup work that must not block the window. Ownership failures stay
   * observable through the `ownership` event; the renderer shows the retry
   * action exactly as before.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const shellEnvironment = await readShellEnvironment().catch(() => ({} as NodeJS.ProcessEnv));
    if (this.closed) return;
    this.connector.setShellEnvironment(shellEnvironment);
    await this.acquireOwnership().catch(() => undefined);
    await this.recordInstallation().catch((error) => this.appendLog({
      level: "ERROR",
      message: `Could not record Desktop installation: ${errorMessage(error)}`,
    }));
    if (this.closed) return;
    const config = this.connector.loadPrivateConfig();
    if (config && !this.binding.get()) this.binding.adoptConfig(config);
    this.connector.bindingChanged();
    if (this.ownership.status === "owned") {
      await this.startOwnedConnectorOnLaunch().catch((error) => this.appendLog({
        level: "ERROR",
        message: `Could not start the local Connector on launch: ${errorMessage(error)}`,
      }));
    }
  }

  ownershipState(): OwnershipState {
    return this.ownership;
  }

  /** Acquires ownership and rethrows conflicts, for callers that must fail. */
  async acquireOwnershipOrThrow(): Promise<OwnershipState> {
    await this.requireOwnership();
    return this.ownership;
  }

  async recheckOwnership(): Promise<OwnershipState> {
    if (this.closed) return this.ownership;
    await this.acquireOwnership().catch(() => undefined);
    return this.ownership;
  }

  getSettings(): DesktopSettings {
    return this.settings.get();
  }

  /** Read-only view used by the main process before it creates the window. */
  getOnboarding(): DesktopOnboardingState {
    return this.machineState.readOnboarding();
  }

  /** Called from the complete page only; the entry itself never records completion. */
  completeOnboarding(input: { source?: unknown }): Promise<DesktopOnboardingState> {
    const source = input?.source;
    if (source !== "desktop" && source !== "dsh-plugin") throw new Error("Unsupported Desktop onboarding source.");
    return this.machineState.completeOnboarding(source as DesktopOnboardingSource);
  }

  saveSettings(patch: DesktopSettingsPatch): Promise<ConnectorState> {
    const previous = this.settings.get();
    const saved = this.settings.save(patch ?? {});
    return this.connector.applySettings(previous).then(
      (state) => {
        this.logs.updateSettings(() => this.settings.get());
        this.emit("settings", this.settings.get());
        return state;
      },
      async (error: unknown) => {
        this.settings.save(previous);
        try {
          await this.connector.applySettings(saved);
        } catch (rollbackError) {
          this.appendLog({ level: "ERROR", message: `Failed to restore Connector settings: ${errorMessage(rollbackError)}` });
        }
        this.logs.updateSettings(() => this.settings.get());
        this.emit("settings", this.settings.get());
        throw error;
      },
    );
  }

  getConnectorState(): Promise<ConnectorState> {
    return this.connector.getState();
  }

  getPublicConfig() {
    return this.connector.getPublicConfig();
  }

  saveConfig(patch: ConnectorConfigPatch): Promise<ConnectorState> {
    return this.connector.saveConfig(patch ?? {});
  }

  startConnector(): Promise<ConnectorState> {
    return this.connector.start();
  }

  stopConnector(): Promise<ConnectorState> {
    return this.connector.stop();
  }

  restartConnector(): Promise<ConnectorState> {
    return this.connector.restart();
  }

  readLogs(query: ConnectorLogQuery): ConnectorLogPage {
    return this.logs.read(query ?? {});
  }

  clearLogs(): ConnectorLogPage {
    const page = this.logs.clear();
    this.emit("logsCleared", undefined);
    return page;
  }

  exportLogs(filePath: string): number {
    return this.logs.exportTo(filePath);
  }

  appendLog(entry: string | Partial<ConnectorLogEntry>): void {
    this.bufferLog(this.logs.append(entry));
  }

  getLocalBinding(): PublicLocalDesktopBinding | null {
    return this.devices.getLocalBinding();
  }

  createAndConnect(input: DesktopDeviceProvisionInput): Promise<PublicLocalDesktopBinding> {
    return this.devices.createAndConnect(input);
  }

  reconnectAndConnect(input: DesktopDeviceReconnectInput): Promise<PublicLocalDesktopBinding> {
    return this.devices.reconnectAndConnect(input);
  }

  disconnectLocal(input: DesktopDeviceAuthInput): Promise<PublicLocalDesktopBinding> {
    return this.devices.disconnectLocal(input);
  }

  updateLocalBindingName(name: DesktopDeviceNameInput["name"]): PublicLocalDesktopBinding {
    return this.devices.updateLocalBindingName(name ?? "");
  }

  /** Starts the Connector on launch when a credential is already present. */
  async startOwnedConnectorOnLaunch(): Promise<void> {
    if (!this.settings.get().startConnectorOnLaunch) return;
    const state = await this.connector.getState();
    if (state.hasCredential && !state.manualDisconnected) await this.connector.start();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logBatcher.dispose();
    await this.connector.shutdown().catch(() => undefined);
  }

  private async requireOwnership(): Promise<void> {
    if (this.closed) throw new Error("Desktop backend is shutting down.");
    await this.connector.acquireOwnership();
  }

  private acquireOwnership(): Promise<void> {
    return this.connector.acquireOwnership();
  }

  private recordInstallation(): Promise<void> {
    return this.machineState.recordInstallation(desktopInstallation({
      executablePath: this.init.desktopExecutablePath,
      appPath: this.init.desktopAppPath,
      packaged: this.init.packaged,
      platform: process.platform,
    }));
  }

  private emit(event: EventName, data: unknown): void {
    this.events.emit(event, data);
  }

  /**
   * The Connector can log many lines per second. Coalescing them keeps the SSE
   * frame rate bounded, so the renderer performs one state update per batch
   * instead of one per line.
   */
  private bufferLog(entry: ConnectorLogEntry): void {
    this.logBatcher.push(entry);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
