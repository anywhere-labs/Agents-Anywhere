/**
 * `ConnectorHost`: one v3 Connector — state on disk, the device gate, sessions, terminals, agent runtimes, the four
 * MeshCall services, and the Router connections they are served on.
 *
 * Two ways to reach Routers:
 *   - control-plane mode: `controlUrl` + device secret (from `identity.json` after `register`) → router tokens for
 *     every Router, plus the `aa.v3.Control/presence` stream;
 *   - direct mode: explicit `routers: [{ url, token? }]` (local tests, Desktop's embedded Router).
 *
 * Mounts per Router:
 *   - `aa.v3.DeviceAdmin` without tunnels: the control plane can always call it, encrypted or not;
 *   - `aa.v3.Sessions`, `aa.v3.Terminals`, `aa.v3.Device` with tunnels; on an encrypted device also
 *     `requireE2E` + `requireE2EPeer`, so MeshCall itself refuses anything but a paired E2E session (and the gate
 *     checks again in every handler).
 *
 * Mode switch (docs/v3/e2ee-admission-proposal.md §7): stop serving and drop every connection and stream first,
 * then persist the new mode, then serve again under the new policy. Switching to encrypted flips the gate before
 * anything else, so no call slips through in the gap.
 */

import { randomBytes } from "node:crypto";

import { generateE2EKey, Mesh, Router, type RunningServer } from "meshcall";

import type { AcpRuntimePreset } from "../core/config.js";
import { DeviceGate, type DeviceGateOptions, type PairingHint, type PairingPayload } from "../core/gate.js";
import { SessionStore } from "../core/session-store.js";
import { AcpRuntimeHost, type PushEvent } from "../runtime/acp-host.js";
import { devicePlatform } from "../runtime/device-ops.js";
import { StateStore, type ConnectorSettings, type DeviceIdentity, type DeviceMode, type PairedClientEntry } from "../runtime/state-store.js";
import { TerminalManager } from "../runtime/terminal-manager.js";
import { DeviceAdminService, TunnelStreamTracker } from "../rpc/device-admin-service.js";
import { DeviceService } from "../rpc/device-service.js";
import { SessionsService } from "../rpc/sessions-service.js";
import { TerminalsService } from "../rpc/terminals-service.js";
import {
  backoffDelay,
  ControlPresenceClient,
  fetchDeviceRouterTokens,
  isUnauthenticated,
  type PresenceSummary,
  type RouterTokenEntry,
} from "./control-client.js";
import { LocalRouterHost, type LocalRouterDescriptor, type LocalRouterHostOptions } from "./local-router.js";

export const CONNECTOR_VERSION = "3.0.0-alpha.1";

export interface RouterTarget {
  url: string;
  /** MeshCall bearer token (`mk_…` / `mt_…`); omit for an open local Router. */
  token?: string;
  id?: string;
}

export interface ConnectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ConnectorHostOptions {
  /** Default `~/.agents-anywhere/connector-v3`. */
  dataDir?: string;
  /** Device id for direct mode when there is no `identity.json` yet (generated otherwise). */
  deviceId?: string;
  /** Direct mode: serve on these Routers. */
  routers?: RouterTarget[];
  /**
   * Local-First mode: spawn a local Go `meshcall-router` bound to 127.0.0.1 with a generated 0600 auth file.
   * Works standalone (no remote server) or alongside a remote control plane (hybrid local + cloud).
   */
  localRouter?: boolean | Omit<LocalRouterHostOptions, "dataDir">;
  /** Control-plane mode (defaults to `identity.json`'s `control_url` / `device_secret`). */
  controlUrl?: string;
  deviceSecret?: string;
  presets?: AcpRuntimePreset[];
  /** Add the built-in `claude` / `codex` presets. Default true. */
  includeDefaultPresets?: boolean;
  connectorVersion?: string;
  presenceIntervalMs?: number;
  /** `send({ wait: true })` cap. */
  waitTimeoutMs?: number;
  onPushEvent?: (event: PushEvent) => void;
  /** `DeviceAdmin/check_update`: look for an update locally. Never runs server-provided code. */
  onCheckUpdate?: (channel: string | undefined) => void | Promise<void>;
  onPairingConfirm?: DeviceGateOptions["onPairingConfirm"];
  onClientPaired?: (entry: PairedClientEntry) => void;
  /** Told after every mode switch completed. */
  onModeChanged?: (mode: DeviceMode) => void;
  logger?: ConnectorLogger;
  fetch?: typeof fetch;
}

interface ServingRouter {
  target: RouterTarget;
  mesh: Mesh;
  running: RunningServer;
}

const silentLogger: ConnectorLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class ConnectorHost {
  readonly options: ConnectorHostOptions;
  readonly state: StateStore;
  readonly streams = new TunnelStreamTracker();
  readonly startedAt = Date.now();
  readonly connectorVersion: string;

  #logger: ConnectorLogger;
  #settings: ConnectorSettings | undefined;
  #identity: DeviceIdentity | undefined;
  #gate: DeviceGate | undefined;
  #store: SessionStore | undefined;
  #terminals: TerminalManager | undefined;
  #runtimes: AcpRuntimeHost | undefined;
  #services: { admin: DeviceAdminService; sessions: SessionsService; device: DeviceService; terminals: TerminalsService } | undefined;
  #presence: ControlPresenceClient | undefined;
  #localRouter: LocalRouterHost | undefined;
  #localRouterDescriptor: LocalRouterDescriptor | undefined;
  #serving: ServingRouter[] = [];
  #targets: RouterTarget[] = [];
  #controlMode = false;
  #started = false;
  #stopping = false;
  #initPromise: Promise<void> | undefined;
  /** Mode switches and restarts run one at a time. */
  #lifecycle: Promise<unknown> = Promise.resolve();
  #persistTimer: NodeJS.Timeout | undefined;
  #persisting: Promise<void> = Promise.resolve();
  #restartAttempts = new Map<string, number>();
  /** Bumped whenever serving stops, so retries scheduled for an earlier round give up. */
  #generation = 0;
  /** Background retries of Routers that could not be served on (unreachable at startup, or a failed restart). */
  #retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: ConnectorHostOptions = {}) {
    this.options = options;
    this.state = new StateStore(options.dataDir === undefined ? {} : { dataDir: options.dataDir });
    this.connectorVersion = options.connectorVersion ?? CONNECTOR_VERSION;
    this.#logger = options.logger ?? silentLogger;
  }

  // ── Accessors (after init) ──

  get deviceId(): string {
    return this.#need(this.#identity, "identity").device_id;
  }
  get gate(): DeviceGate {
    return this.#need(this.#gate, "gate");
  }
  get store(): SessionStore {
    return this.#need(this.#store, "store");
  }
  get terminals(): TerminalManager {
    return this.#need(this.#terminals, "terminals");
  }
  get runtimes(): AcpRuntimeHost {
    return this.#need(this.#runtimes, "runtimes");
  }
  get sessionsService(): SessionsService {
    return this.#need(this.#services, "services").sessions;
  }
  get settings(): ConnectorSettings {
    return { ...this.#need(this.#settings, "settings") };
  }
  get mode(): DeviceMode {
    return this.gate.mode;
  }
  get identity(): DeviceIdentity {
    return { ...this.#need(this.#identity, "identity") };
  }
  get isServing(): boolean {
    return this.#serving.length > 0;
  }
  get presence(): ControlPresenceClient | undefined {
    return this.#presence;
  }
  get localRouter(): LocalRouterHost | undefined {
    return this.#localRouter;
  }
  get localRouterDescriptor(): LocalRouterDescriptor | undefined {
    return this.#localRouterDescriptor;
  }

  // ── Lifecycle ──

  /** Load state, make sure the device key exists, build everything. Idempotent; `start()` calls it. */
  init(): Promise<void> {
    this.#initPromise ??= this.#init().catch((error: unknown) => {
      this.#initPromise = undefined;
      throw error;
    });
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    const state = this.state;
    await state.init();
    const settings = await state.loadSettings();
    let identity = await state.loadIdentity();
    const controlUrl = this.options.controlUrl ?? identity?.control_url;
    const isControlUrl = controlUrl !== undefined && /^https?:\/\//u.test(controlUrl);
    if (identity === null) {
      const explicit = this.options.deviceId !== undefined && this.options.deviceSecret !== undefined;
      if (this.options.routers === undefined && !this.options.localRouter && isControlUrl && !explicit) {
        throw new Error("this device is not registered: run `aa-connector register` first");
      }
      identity = {
        device_id: this.options.deviceId ?? `dev_${randomBytes(12).toString("base64url")}`,
        device_secret: this.options.deviceSecret ?? randomBytes(24).toString("base64url"),
        control_url: controlUrl ?? "direct:",
      };
    }
    if (identity.e2e_private_key === undefined || identity.e2e_public_key === undefined) {
      // The device's static X25519 key: made once, kept in identity.json (0600), never sent anywhere.
      const keys = await generateE2EKey();
      identity = { ...identity, e2e_private_key: keys.privateKey, e2e_public_key: keys.publicKey };
    }
    await state.saveIdentity(identity);
    this.#identity = identity;
    this.#settings = settings;

    const gateOptions: DeviceGateOptions = {
      instanceId: identity.device_id,
      e2ePrivateKey: identity.e2e_private_key as string,
      e2ePublicKey: identity.e2e_public_key as string,
      mode: settings.mode,
      allowMcp: settings.allow_mcp,
      requirePairingConfirm: settings.require_pairing_confirm,
      pairedClients: await state.loadPairedClients(),
      onStateChange: (clients) => state.savePairedClients(clients),
    };
    if (this.options.onPairingConfirm) gateOptions.onPairingConfirm = this.options.onPairingConfirm;
    if (this.options.onClientPaired) gateOptions.onClientPaired = this.options.onClientPaired;
    const gate = new DeviceGate(gateOptions);
    this.#gate = gate;

    const store = new SessionStore({ device: { id: identity.device_id, name: settings.device_name }, onChange: () => this.#schedulePersist() });
    try {
      const saved = await state.loadSessionsSnapshot();
      if (saved.length > 0) store.loadSnapshot({ version: 1, sessions: saved });
    } catch (error) {
      this.#logger.warn(`could not restore saved sessions: ${String(error)}`);
    }
    this.#store = store;
    this.#terminals = new TerminalManager();
    this.#runtimes = new AcpRuntimeHost({
      store,
      presets: this.options.presets ?? [],
      includeDefaultPresets: this.options.includeDefaultPresets ?? true,
      maxFileBytes: () => this.#settings?.max_rpc_file_bytes ?? settings.max_rpc_file_bytes,
      onPushEvent: (event) => this.#onPush(event),
      clientInfo: { name: "agents-anywhere-connector", version: this.connectorVersion },
    });

    const host = this;
    this.#services = {
      admin: new DeviceAdminService({
        closeTunnelSessions: (tunnelId) => {
          this.closeTunnelSessions(tunnelId);
        },
        rename: (name) => this.rename(name),
        checkUpdate: (channel) => this.options.onCheckUpdate?.(channel),
      }),
      sessions: new SessionsService({
        gate,
        store,
        runtimes: this.#runtimes,
        streams: this.streams,
        ...(this.options.waitTimeoutMs !== undefined ? { waitTimeoutMs: this.options.waitTimeoutMs } : {}),
      }),
      device: new DeviceService({
        gate,
        get deviceId() {
          return host.deviceId;
        },
        dataDir: state.dataDir,
        connectorVersion: this.connectorVersion,
        startedAt: this.startedAt,
        settings: () => this.settings,
        updateSettings: (patch) => this.updateSettings(patch, { deferModeSwitch: true }),
        runtimes: () => this.runtimes.list(),
        revokePairedClient: (clientPub) => this.revokePairedClient(clientPub),
      }),
      terminals: new TerminalsService({ gate, terminals: this.#terminals, streams: this.streams }),
    };
  }

  /** Connect to the Routers (and the control plane) and serve. */
  async start(): Promise<void> {
    await this.init();
    if (this.#started) return;
    this.#stopping = false;
    const identity = this.identity;
    const targets: RouterTarget[] = [];

    try {
      if (this.options.localRouter) {
        const lrOpts = typeof this.options.localRouter === "object" ? this.options.localRouter : {};
        const lr = new LocalRouterHost({ dataDir: this.state.dataDir, ...lrOpts });
        const descriptor = await lr.start(identity.device_id);
        this.#localRouter = lr;
        this.#localRouterDescriptor = descriptor;
        const devToken = await lr.issueDeviceToken(identity.device_id);
        targets.push({ id: "local-router", url: descriptor.url, token: devToken.token });
        this.#logger.info(`local meshcall-router listening on ${descriptor.url} (http: ${descriptor.http_url})`);
      }

      if (this.options.routers !== undefined) {
        this.#controlMode = false;
        targets.push(...this.options.routers.map((r, i) => ({ ...r, id: r.id ?? `router-${i}` })));
      } else {
        const controlUrl = this.options.controlUrl ?? identity.control_url;
        if (/^https?:\/\//u.test(controlUrl)) {
          this.#controlMode = true;
          const tokens = await this.#fetchTokens();
          targets.push(...tokens.map(toTarget));
          this.#presence = new ControlPresenceClient({
            deviceId: identity.device_id,
            platform: devicePlatform(),
            connectorVersion: this.connectorVersion,
            getMode: () => this.gate.mode,
            getSummary: () => this.presenceSummary(),
            e2ePublicKey: identity.e2e_public_key as string,
            tokens,
            refreshTokens: () => this.#fetchTokens(),
            ...(this.options.presenceIntervalMs !== undefined ? { intervalMs: this.options.presenceIntervalMs } : {}),
            log: (level, message) => (level === "warn" ? this.#logger.warn(message) : this.#logger.info(message)),
          });
        } else if (targets.length === 0) {
          throw new Error("no Routers to serve on: pass `localRouter: true`, `routers`, or register the device with a control plane");
        }
      }

      this.#targets = targets;
      this.#started = true;
      await this.#serveAll();
    } catch (error) {
      this.#started = false;
      this.#presence = undefined;
      await this.#localRouter?.stop().catch(() => undefined);
      this.#localRouter = undefined;
      this.#localRouterDescriptor = undefined;
      throw error;
    }
    this.#presence?.start();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    await this.#presence?.stop();
    this.#presence = undefined;
    await this.#serialize(() => this.#stopServing());
    await this.#localRouter?.stop();
    this.#localRouter = undefined;
    this.#localRouterDescriptor = undefined;
    await this.#runtimes?.dispose();
    await this.#terminals?.closeAll();
    await this.flush();
  }

  /** Write the sessions snapshot now. */
  async flush(): Promise<void> {
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
      this.#persisting = this.#persisting.then(() => this.#persist());
    }
    await this.#persisting;
  }

  // ── Mode and settings ──

  /** The safe switch: stop serving, drop every connection, persist, then serve again under the new policy. */
  switchMode(mode: DeviceMode): Promise<void> {
    return this.#serialize(async () => {
      if (mode !== "normal" && mode !== "encrypted") throw new TypeError(`unknown mode ${String(mode)}`);
      const gate = this.gate;
      const current = this.#settings?.mode;
      if (mode === gate.mode && mode === current) return;
      if (mode === "encrypted") gate.mode = "encrypted"; // fail closed before anything else
      await this.#stopServing();
      gate.mode = mode;
      this.#settings = await this.state.updateSettings({ mode });
      this.#logger.info(`device mode is now ${mode}`);
      this.#presence?.reportNow();
      if (this.#started && !this.#stopping) await this.#serveAll();
      try {
        this.options.onModeChanged?.(mode);
      } catch {
        // Listener problems are theirs.
      }
    });
  }

  /**
   * Persist a settings change. A mode change goes through `switchMode`; with `deferModeSwitch` (an RPC asking) it
   * runs right after the current call answered, since the switch drops the connection the call came on.
   */
  async updateSettings(patch: Partial<ConnectorSettings>, options: { deferModeSwitch?: boolean } = {}): Promise<ConnectorSettings> {
    await this.init();
    const { mode, ...rest } = patch;
    if (Object.keys(rest).length > 0) {
      this.#settings = await this.state.updateSettings(rest);
      this.#applySettings(this.#settings);
    }
    if (mode !== undefined && mode !== this.gate.mode) {
      if (options.deferModeSwitch) {
        if (mode === "encrypted") this.gate.mode = "encrypted"; // fail closed now; the switch finishes the job
        setTimeout(() => {
          this.switchMode(mode).catch((error: unknown) => this.#logger.error(`mode switch failed: ${String(error)}`));
        }, 50).unref();
        return { ...this.settings, mode };
      }
      await this.switchMode(mode);
    }
    return this.settings;
  }

  async setAllowMcp(allow: boolean): Promise<ConnectorSettings> {
    return this.updateSettings({ allow_mcp: allow });
  }

  async rename(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new TypeError("a device name cannot be empty");
    await this.updateSettings({ device_name: trimmed.slice(0, 128) });
  }

  // ── Pairing ──

  /** A one-time pairing link (`aa-pair://v1/…`). Show it only on this device. */
  async createPairing(ttlMs?: number, hint: PairingHint = {}): Promise<{ uri: string; payload: PairingPayload }> {
    await this.init();
    return this.gate.createPairing(ttlMs, hint);
  }

  listPairedClients(): PairedClientEntry[] {
    return this.gate.listPairedClients();
  }

  /** Remove a client: its next handshake fails, and its live streams end now. */
  revokePairedClient(clientPub: string): boolean {
    const removed = this.gate.revokePairedClient(clientPub);
    this.streams.closePeer(clientPub);
    return removed;
  }

  /** `DeviceAdmin/close_tunnel_sessions`: end every stream that came through a revoked tunnel. */
  closeTunnelSessions(tunnelId: string): number {
    const closed = this.streams.closeTunnel(tunnelId);
    if (closed > 0) this.#logger.info(`closed ${closed} stream(s) of tunnel ${tunnelId}`);
    return closed;
  }

  /** What a normal device reports in presence. */
  presenceSummary(): PresenceSummary {
    const store = this.store;
    const { sessions } = store.list();
    let pending = 0;
    let active = 0;
    for (const summary of sessions) {
      if (summary.state === "running" || summary.state === "waiting") active++;
      pending += store.getControl(summary.id).pending.length;
    }
    return { runtimes: this.runtimes.list().map((r) => r.id), active_sessions: active, pending_approvals: pending };
  }

  // ── Serving ──

  /**
   * Serve on every target. Succeeds once any Router accepts; the others keep being retried in the background, so a
   * Router that is restarting while the Connector starts gets the device once it is back.
   */
  async #serveAll(): Promise<void> {
    const generation = this.#generation;
    const targets = this.#targets;
    const results = await Promise.allSettled(targets.map((target) => this.#serveOne(target, generation)));
    const failures: unknown[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") return;
      failures.push(result.reason);
      const target = targets[i] as RouterTarget;
      this.#logger.warn(`could not serve on ${target.url}: ${String(result.reason)}`);
    });
    if (failures.length < results.length) {
      results.forEach((result, i) => {
        if (result.status === "rejected") this.#scheduleRetry(targets[i] as RouterTarget, generation, result.reason);
      });
    }
    // Every target failed: start() throws, so there is nothing to keep retrying.
    if (failures.length === results.length && results.length > 0) {
      throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
    }
  }

  #targetKey(target: RouterTarget): string {
    return target.id ?? target.url;
  }

  /** Retry one Router with jittered backoff until it accepts, serving stops, or the host stops. */
  #scheduleRetry(target: RouterTarget, generation: number, lastError: unknown): void {
    const key = this.#targetKey(target);
    if (this.#stopping || generation !== this.#generation || this.#retryTimers.has(key)) return;
    const attempt = (this.#restartAttempts.get(key) ?? 0) + 1;
    this.#restartAttempts.set(key, attempt);
    const wait = backoffDelay(attempt, 1000, 60_000);
    const timer = setTimeout(() => {
      this.#retryTimers.delete(key);
      void (async () => {
        if (this.#stopping || generation !== this.#generation) return;
        let current = this.#targets.find((t) => this.#targetKey(t) === key) ?? target;
        if (this.#controlMode && isUnauthenticated(lastError)) {
          // The token may have expired while the Router was away: take fresh ones from the control plane.
          const tokens = await this.#fetchTokens();
          if (this.#stopping || generation !== this.#generation) return;
          this.#targets = tokens.map(toTarget);
          this.#presence?.updateTokens(tokens);
          const fresh = this.#targets.find((t) => this.#targetKey(t) === key);
          if (fresh === undefined) return; // The control plane no longer lists this Router.
          current = fresh;
        }
        await this.#serveOne(current, generation);
        this.#restartAttempts.delete(key);
        this.#logger.info(`serving again on ${current.url}`);
      })().catch((error: unknown) => {
        this.#logger.warn(`still cannot serve on ${target.url}: ${String(error)}`);
        this.#scheduleRetry(target, generation, error);
      });
    }, wait);
    timer.unref();
    this.#retryTimers.set(key, timer);
  }

  #cancelRetries(): void {
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#restartAttempts.clear();
  }

  async #serveOne(target: RouterTarget, generation = this.#generation): Promise<void> {
    const services = this.#need(this.#services, "services");
    const gate = this.gate;
    const instanceId = this.deviceId;
    const mesh = new Mesh(new Router(target.url), target.token ? { token: target.token } : {});
    const onTunnelClosed = (closed: { tunnelId: string }) => {
      this.streams.closeTunnel(closed.tunnelId);
    };
    // Content-free admin: no tunnels, so only direct (control plane) calls reach it.
    mesh.mount(services.admin, { instanceId, accessLog: false });
    const business = [services.sessions, services.terminals, services.device];
    if (gate.mode === "encrypted") {
      mesh.mount(...business, {
        ...gate.mountOptions(),
        instanceId,
        accessLog: false,
        acceptTunnels: true,
        requireE2E: true,
        requireE2EPeer: true,
        onTunnelClosed,
      });
    } else {
      // The E2E hooks stay on in normal mode so a client can pair before the device switches to encrypted.
      mesh.mount(...business, { ...gate.mountOptions(), instanceId, accessLog: false, acceptTunnels: true, onTunnelClosed });
    }
    let running: RunningServer;
    try {
      running = await mesh.startServing();
    } catch (error) {
      await mesh.close().catch(() => undefined);
      throw error;
    }
    if (this.#stopping || generation !== this.#generation) {
      // Serving stopped (host stop or mode switch) while this Router was connecting: don't serve under a stale policy.
      await running.close({ drain: false }).catch(() => undefined);
      await mesh.close().catch(() => undefined);
      return;
    }
    const entry: ServingRouter = { target, mesh, running };
    this.#serving.push(entry);
    void running.server.refused.then((error) => this.#onRefused(entry, error));
    this.#logger.info(`serving ${instanceId} (${gate.mode}) on ${target.url}`);
  }

  async #stopServing(): Promise<void> {
    this.#generation++;
    this.#cancelRetries();
    const serving = this.#serving;
    this.#serving = [];
    // Streams first: a drain would otherwise wait for every watch to end.
    this.streams.closeAll();
    await Promise.all(
      serving.map(async ({ mesh, running }) => {
        await running.close({ drain: true, drainTimeoutMs: 1000 }).catch(() => undefined);
        await mesh.close().catch(() => undefined);
      }),
    );
  }

  /** Every Router refused the token (expired / revoked): fetch new ones and serve again on that Router. */
  #onRefused(entry: ServingRouter, error: unknown): void {
    if (!this.#serving.includes(entry) || this.#stopping) return;
    this.#logger.warn(`${entry.target.url} refused this device: ${String(error)}`);
    if (!this.#controlMode) return;
    const key = this.#targetKey(entry.target);
    const attempt = (this.#restartAttempts.get(key) ?? 0) + 1;
    this.#restartAttempts.set(key, attempt);
    const wait = backoffDelay(attempt, 1000, 60_000);
    const generation = this.#generation;
    setTimeout(() => {
      void this.#serialize(async () => {
        if (!this.#serving.includes(entry) || this.#stopping) return;
        this.#serving = this.#serving.filter((e) => e !== entry);
        await entry.running.close({ drain: false }).catch(() => undefined);
        await entry.mesh.close().catch(() => undefined);
        const tokens = await this.#fetchTokens();
        this.#targets = tokens.map(toTarget);
        this.#presence?.updateTokens(tokens);
        const target = this.#targets.find((t) => this.#targetKey(t) === key);
        if (target === undefined) {
          // Serving on another Router instead would register the device there twice.
          this.#logger.warn(`the control plane no longer lists ${entry.target.url}; not serving there`);
          return;
        }
        await this.#serveOne(target, generation);
        this.#restartAttempts.delete(key);
      }).catch((err: unknown) => {
        // The entry is out of `#serving` by now, so hand the Router to the background retry.
        this.#logger.error(`could not reconnect to ${entry.target.url}: ${String(err)}`);
        const target = this.#targets.find((t) => this.#targetKey(t) === key) ?? entry.target;
        this.#scheduleRetry(target, generation, err);
      });
    }, wait).unref();
  }

  async #fetchTokens(): Promise<RouterTokenEntry[]> {
    const identity = this.identity;
    const result = await fetchDeviceRouterTokens({
      controlUrl: this.options.controlUrl ?? identity.control_url,
      deviceId: identity.device_id,
      deviceSecret: this.options.deviceSecret ?? identity.device_secret,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return result.tokens;
  }

  // ── Internals ──

  #applySettings(settings: ConnectorSettings): void {
    const gate = this.gate;
    gate.allowMcp = settings.allow_mcp;
    gate.requirePairingConfirm = settings.require_pairing_confirm;
    this.store.device.name = settings.device_name;
  }

  #onPush(event: PushEvent): void {
    try {
      this.options.onPushEvent?.(event);
    } catch {
      // Best effort.
    }
    void this.#presence?.notifyPush(event).catch((error: unknown) => this.#logger.warn(`push failed: ${String(error)}`));
  }

  #schedulePersist(): void {
    if (this.#persistTimer !== undefined) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      this.#persisting = this.#persisting.then(() => this.#persist());
    }, 300);
    this.#persistTimer.unref();
  }

  async #persist(): Promise<void> {
    const store = this.#store;
    if (store === undefined) return;
    try {
      await this.state.saveSessionsSnapshot(store.exportSnapshot().sessions);
    } catch (error) {
      this.#logger.error(`could not save sessions: ${String(error)}`);
    }
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#lifecycle.then(run, run);
    this.#lifecycle = next.catch(() => undefined);
    return next;
  }

  #need<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`ConnectorHost is not initialized (${what}); call init() or start() first`);
    return value;
  }
}

function toTarget(entry: RouterTokenEntry): RouterTarget {
  return { id: entry.router_id, url: entry.router_url, token: entry.token };
}
