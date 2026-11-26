// The managed connector-v3 on this machine.
//
// Desktop runs the bundled connector with Electron's own Node (`ELECTRON_RUN_AS_NODE=1`) as a separate child
// process in Local-First mode (`start --local-router`): the connector spawns the local `meshcall-router`
// (bound to 127.0.0.1, `--shutdown-on-stdin-close`, so it exits with the connector) and, once this machine is
// registered, also serves on the control plane's Routers. Closing the window keeps it running; quitting the app
// stops it.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import * as path from "node:path";

import QRCode from "qrcode";

import type { ConnectorStatus, DeviceMode, PairResult, RegisterInput } from "../shared/bridge";
import { adminCall, type AdminStatus } from "./admin-client";
import { ManagedProcess } from "./process-manager";

export interface ConnectorManagerOptions {
  /** Entry script of the bundled connector (`desktop-entry.mjs`). */
  entry: string;
  /** Runtime that executes `entry`: Electron itself (with ELECTRON_RUN_AS_NODE) or node. */
  execPath: string;
  dataDir: string;
  logDir: string;
  /** Environment for the connector (login-shell PATH etc.). */
  env: () => NodeJS.ProcessEnv;
  /** Maps the renderer's control URL (`/api/control` or absolute) to an absolute URL. */
  resolveControlUrl: (url: string) => string;
  /** Optional fixed port for the local Router (default: random). */
  localRouterPort?: number;
  /** Extra ACP presets file passed with `--presets`. */
  presetsFile?: string;
}

interface IdentityFile {
  device_id?: string;
  control_url?: string;
}

interface SettingsFile {
  device_name?: string;
  mode?: DeviceMode;
}

export class ConnectorManager extends EventEmitter {
  readonly options: ConnectorManagerOptions;
  readonly process: ManagedProcess;
  #lastAdmin: AdminStatus | null = null;

  constructor(options: ConnectorManagerOptions) {
    super();
    this.options = options;
    const args = [options.entry, "start", "--data-dir", options.dataDir, "--local-router"];
    if (options.localRouterPort !== undefined) args.push("--local-router-port", String(options.localRouterPort));
    if (options.presetsFile) args.push("--presets", options.presetsFile);
    this.process = new ManagedProcess({
      name: "connector-v3",
      command: options.execPath,
      args,
      // Read at spawn time: the login-shell environment arrives asynchronously.
      env: () => this.#childEnv(),
      logFile: this.logFile,
      backoff: { initialMs: 1_000, maxMs: 30_000, factor: 2, resetAfterMs: 60_000, maxAttempts: 0 },
      health: {
        check: async () => {
          this.#lastAdmin = await adminCall<AdminStatus>(options.dataDir, { cmd: "status" }, 5_000);
          return true;
        },
        intervalMs: 10_000,
        startupGraceMs: 30_000,
        failuresBeforeRestart: 3,
      },
      stopTimeoutMs: 10_000,
    });
    this.process.on("status", () => {
      if (!this.process.running) this.#lastAdmin = null;
      void this.status().then((s) => this.emit("status", s));
    });
  }

  get logFile(): string {
    return path.join(this.options.logDir, "connector.log");
  }

  #childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.options.env() };
    env.ELECTRON_RUN_AS_NODE = "1";
    env.AA_CONNECTOR_DATA_DIR = this.options.dataDir;
    env.AA_LOG_LEVEL = env.AA_LOG_LEVEL ?? "info";
    delete env.AA_ACCESS_TOKEN;
    return env;
  }

  async #readJson<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path.join(this.options.dataDir, name), "utf8")) as T;
    } catch {
      return null;
    }
  }

  start(): void {
    this.process.start();
  }

  async stop(): Promise<void> {
    await this.process.stop();
    this.#lastAdmin = null;
  }

  async status(): Promise<ConnectorStatus> {
    const identity = await this.#readJson<IdentityFile>("identity.json");
    const settings = await this.#readJson<SettingsFile>("settings.json");
    let admin = this.#lastAdmin;
    if (this.process.running) {
      admin = await adminCall<AdminStatus>(this.options.dataDir, { cmd: "status" }, 3_000).catch(() => this.#lastAdmin);
      this.#lastAdmin = admin;
    }
    const registered = typeof identity?.control_url === "string" && /^https?:\/\//u.test(identity.control_url);
    return {
      registered,
      deviceId: registered ? (identity?.device_id ?? null) : null,
      deviceName: settings?.device_name ?? null,
      mode: (admin?.mode ?? settings?.mode ?? null) as DeviceMode | null,
      controlUrl: registered ? (identity?.control_url ?? null) : null,
      connector: this.process.status,
      localRouter: admin?.local_router ? { url: admin.local_router.url, httpUrl: admin.local_router.http_url } : null,
      runtimes: (admin?.runtimes ?? []).map((r) => ({ id: r.id, name: r.name })),
      dataDir: this.options.dataDir,
      logFile: this.logFile,
    };
  }

  /** Register this machine with a control plane (stops and restarts the connector around it). */
  async register(input: RegisterInput): Promise<ConnectorStatus> {
    const name = input.name.trim();
    if (!name) throw new Error("device name is required");
    if (input.mode !== "normal" && input.mode !== "encrypted") throw new Error("mode must be normal or encrypted");
    if (!input.accessToken) throw new Error("access token is required");
    const controlUrl = this.options.resolveControlUrl(input.controlUrl);
    const current = await this.status();
    if (current.registered) throw new Error(`this computer is already registered as ${current.deviceId}`);

    await this.stop();
    try {
      const identity = await this.#readJson<IdentityFile>("identity.json");
      const args = [this.options.entry, "register", "--data-dir", this.options.dataDir, "--control-url", controlUrl, "--name", name, "--mode", input.mode];
      // A Local-First-only identity (`direct:`) is replaced; its E2E key is kept by the CLI.
      if (identity) args.push("--force");
      await this.#runCli(args, { AA_ACCESS_TOKEN: input.accessToken });
    } finally {
      this.start();
    }
    return this.status();
  }

  async pair(input: { label?: string; ttlSeconds?: number } = {}): Promise<PairResult> {
    if (!this.process.running) throw new Error("the connector is not running");
    const result = await adminCall<{ uri: string; expires_at: string }>(this.options.dataDir, {
      cmd: "pair",
      ...(input.label ? { label: input.label.slice(0, 80) } : {}),
      ...(input.ttlSeconds ? { ttl_ms: Math.round(Math.min(Math.max(input.ttlSeconds, 30), 3600) * 1000) } : {}),
      platform: "desktop",
    });
    const qr_svg = await QRCode.toString(result.uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return { uri: result.uri, expires_at: result.expires_at, qr_svg };
  }

  /** The last `lines` lines of the connector log. */
  async logs(lines = 200): Promise<string> {
    const count = Math.min(Math.max(Math.trunc(lines) || 200, 1), 5_000);
    if (!existsSync(this.logFile)) return "";
    const handle = await open(this.logFile, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const all = buffer.toString("utf8").split("\n");
      return all.slice(-count - 1).join("\n");
    } finally {
      await handle.close();
    }
  }

  #runCli(args: string[], extraEnv: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.execPath, args, {
        env: { ...this.#childEnv(), ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error((err || out).trim().replace(/^aa-connector:\s*/u, "") || `connector exited with code ${code}`));
      });
    });
  }
}
