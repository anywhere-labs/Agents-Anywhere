/**
 * The Connector's side of the v3 control plane (`server-v3`):
 *
 *   POST /devices/register      (user access token)  → device record + device secret, once per device
 *   POST /devices/router-token  (device secret)      → short-lived MeshCall tokens, one per Router
 *   aa.v3.Control/presence      (client stream)      → heartbeats while the Connector runs
 *   aa.v3.Control/notify_push   (unary)              → push notifications for the owner
 *
 * What an encrypted device tells the server is limited by contract (control.schema.json): no `summary` in presence,
 * and push requests carry no session id, title or body — stripped here, before anything leaves the device.
 */

import { Mesh, MeshCallError, Router, UnauthenticatedError } from "meshcall";

import type { DeviceMode, DevicePlatform } from "../core/config.js";
import type { DriveDownload } from "../runtime/device-ops.js";

const CONTROL_SERVICE = "aa.v3.Control";

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RouterTokenEntry {
  router_id: string;
  router_url: string;
  token: string;
  token_id: string;
  expires_at: string;
}

export interface DeviceRouterTokens {
  device_id: string;
  principal: string;
  tokens: RouterTokenEntry[];
}

export interface RegisteredDevice {
  device: {
    id: string;
    name: string;
    platform: DevicePlatform;
    connector_version: string;
    mode_hint: DeviceMode;
    presence: "online" | "offline";
    created_at: string;
    last_seen_at: string;
    e2e_public_key_hint?: string;
  };
  device_secret: string;
  notice?: string;
}

/** A non-2xx answer from the control plane. `status` 401 means the credential is wrong or expired. */
export class ControlHttpError extends Error {
  override readonly name = "ControlHttpError";
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail = typeof parsed === "object" && parsed !== null && "detail" in parsed ? String((parsed as { detail: unknown }).detail) : text.slice(0, 200);
    throw new ControlHttpError(response.status, `${url} answered ${response.status}: ${detail}`, parsed);
  }
  return parsed as T;
}

function endpoint(controlUrl: string, route: string): string {
  return `${controlUrl.replace(/\/+$/u, "")}${route}`;
}

export interface RegisterDeviceOptions {
  controlUrl: string;
  /** The owner's access token (from login). */
  accessToken: string;
  name: string;
  platform: DevicePlatform;
  modeHint: DeviceMode;
  connectorVersion: string;
  /** Non-authoritative: clients trust only the QR-pinned key. */
  e2ePublicKeyHint?: string;
  fetch?: FetchLike;
}

export async function registerDeviceWithControlPlane(options: RegisterDeviceOptions): Promise<RegisteredDevice> {
  const body: Record<string, unknown> = {
    name: options.name,
    platform: options.platform,
    mode_hint: options.modeHint,
    connector_version: options.connectorVersion,
  };
  if (options.e2ePublicKeyHint) body.e2e_public_key_hint = options.e2ePublicKeyHint;
  return postJson<RegisteredDevice>(options.fetch ?? fetch, endpoint(options.controlUrl, "/devices/register"), body, {
    authorization: `Bearer ${options.accessToken}`,
  });
}

export interface FetchRouterTokensOptions {
  controlUrl: string;
  deviceId: string;
  deviceSecret: string;
  fetch?: FetchLike;
}

export async function fetchDeviceRouterTokens(options: FetchRouterTokensOptions): Promise<DeviceRouterTokens> {
  const result = await postJson<DeviceRouterTokens>(options.fetch ?? fetch, endpoint(options.controlUrl, "/devices/router-token"), {
    device_id: options.deviceId,
    device_secret: options.deviceSecret,
  });
  if (!result || !Array.isArray(result.tokens)) throw new ControlHttpError(502, "the control plane answered router-token without tokens", result);
  return result;
}

// ── Cloud drive (large attachments) ─────────────────────────────────────────────────────────────────────────────

export interface DriveDownloadOptions {
  controlUrl: string;
  deviceId: string;
  deviceSecret: string;
  fileId: string;
  fetch?: FetchLike;
}

/** `GET /drive/files/{id}/download-url` as this device (`X-AA-Device-Id` / `X-AA-Device-Secret`). */
export async function fetchDriveDownload(options: DriveDownloadOptions): Promise<DriveDownload> {
  const fetchImpl = options.fetch ?? fetch;
  const url = endpoint(options.controlUrl, `/drive/files/${encodeURIComponent(options.fileId)}/download-url`);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", "X-AA-Device-Id": options.deviceId, "X-AA-Device-Secret": options.deviceSecret },
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail = typeof parsed === "object" && parsed !== null && "detail" in parsed ? String((parsed as { detail: unknown }).detail) : text.slice(0, 200);
    throw new ControlHttpError(response.status, `${url} answered ${response.status}: ${detail}`, parsed);
  }
  const result = parsed as DriveDownload;
  if (!result?.file || !result.download?.url) throw new ControlHttpError(502, "the control plane answered download-url without a link", parsed);
  return result;
}

// ── Presence and push ───────────────────────────────────────────────────────────────────────────────────────────

export interface PresenceSummary {
  runtimes: string[];
  active_sessions: number;
  pending_approvals: number;
}

/** `PresenceReport` of control.schema.json. */
export interface PresenceReport {
  device_id: string;
  platform: DevicePlatform;
  connector_version: string;
  mode_hint: DeviceMode;
  sent_at: string;
  summary?: PresenceSummary;
  e2e_public_key_hint?: string;
}

export interface PushRequest {
  event_type: "approval" | "activity" | "error";
  session_id?: string;
  title?: string;
  body?: string;
}

export interface PushAck {
  queued: number;
  content_stripped: boolean;
}

export interface ControlPresenceOptions {
  deviceId: string;
  platform: DevicePlatform;
  connectorVersion: string;
  /** Read at every report: a mode switch shows up in the next one (call `reportNow()`). */
  getMode: () => DeviceMode;
  /** Normal mode only. */
  getSummary: () => PresenceSummary;
  /** Sent as a hint in encrypted mode only. */
  e2ePublicKey: string;
  tokens: RouterTokenEntry[];
  /** New tokens after a 401 / 4401 (`fetchDeviceRouterTokens`). */
  refreshTokens?: () => Promise<RouterTokenEntry[]>;
  intervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (level: "info" | "warn", message: string) => void;
}

const DEFAULT_PRESENCE_INTERVAL_MS = 20_000;

/** The Router or the control plane refused the credential (`401` / `4401`). */
export function isUnauthenticated(error: unknown): boolean {
  if (error instanceof UnauthenticatedError) return true;
  if (error instanceof MeshCallError && error.code === "unauthenticated") return true;
  const text = String(error);
  return /\b4401\b|\b401\b/u.test(text);
}

/** Jittered exponential backoff: `base · 2^attempt`, capped, ±50 %. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** Keeps one `aa.v3.Control/presence` stream open (one Router at a time, failing over), and sends push requests. */
export class ControlPresenceClient {
  readonly #options: ControlPresenceOptions;
  #tokens: RouterTokenEntry[];
  #stopped = true;
  #loop: Promise<void> | undefined;
  #mesh: Mesh | undefined;
  #wake: (() => void) | undefined;
  #stopController = new AbortController();
  #reportsSent = 0;

  constructor(options: ControlPresenceOptions) {
    this.#options = options;
    this.#tokens = [...options.tokens];
  }

  get reportsSent(): number {
    return this.#reportsSent;
  }

  updateTokens(tokens: RouterTokenEntry[]): void {
    this.#tokens = [...tokens];
  }

  /** The report as it would be sent now. */
  buildReport(): PresenceReport {
    const mode = this.#options.getMode();
    const report: PresenceReport = {
      device_id: this.#options.deviceId,
      platform: this.#options.platform,
      connector_version: this.#options.connectorVersion,
      mode_hint: mode,
      sent_at: new Date().toISOString(),
    };
    if (mode === "encrypted") {
      report.e2e_public_key_hint = this.#options.e2ePublicKey;
    } else {
      const summary = this.#options.getSummary();
      report.summary = { runtimes: [...summary.runtimes], active_sessions: summary.active_sessions, pending_approvals: summary.pending_approvals };
    }
    return report;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#stopController = new AbortController();
    this.#loop = this.#run();
  }

  /** Send a report now (after a mode switch or a rename). */
  reportNow(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopController.abort();
    this.reportNow();
    const mesh = this.#mesh;
    await Promise.race([this.#loop, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    await mesh?.close().catch(() => undefined);
  }

  /** `aa.v3.Control/notify_push`. Encrypted devices send only the event type. */
  async notifyPush(request: PushRequest): Promise<PushAck | undefined> {
    const payload: Record<string, unknown> = { device_id: this.#options.deviceId, event_type: request.event_type };
    if (this.#options.getMode() !== "encrypted") {
      if (request.session_id) payload.session_id = request.session_id;
      if (request.title) payload.title = request.title.slice(0, 160);
      if (request.body) payload.body = request.body.slice(0, 512);
    }
    let mesh = this.#mesh;
    let temporary = false;
    if (mesh === undefined) {
      const entry = this.#tokens[0];
      if (entry === undefined) return undefined;
      mesh = new Mesh(new Router(entry.router_url), entry.token ? { token: entry.token } : {});
      temporary = true;
    }
    try {
      return await mesh.unary<Record<string, unknown>, PushAck>(CONTROL_SERVICE, "notify_push", payload, { timeoutMs: 5000 });
    } finally {
      if (temporary) await mesh.close().catch(() => undefined);
    }
  }

  async #run(): Promise<void> {
    const initial = this.#options.initialBackoffMs ?? 1000;
    const max = this.#options.maxBackoffMs ?? 30_000;
    let attempt = 0;
    let index = 0;
    while (!this.#stopped) {
      const entry = this.#tokens[index % Math.max(1, this.#tokens.length)];
      if (entry === undefined) {
        await this.#sleep(backoffDelay(++attempt, initial, max));
        await this.#refresh();
        continue;
      }
      const mesh = new Mesh(new Router(entry.router_url), entry.token ? { token: entry.token } : {});
      this.#mesh = mesh;
      let healthy = false;
      try {
        await mesh.clientStream(CONTROL_SERVICE, "presence", {}, this.#reports(() => (healthy = true)));
        attempt = 0;
      } catch (error) {
        if (this.#stopped) break;
        this.#log("warn", `presence stream on ${entry.router_id} ended: ${String(error)}`);
        if (healthy) attempt = 0;
        if (isUnauthenticated(error)) await this.#refresh();
        else index++;
        await this.#sleep(backoffDelay(++attempt, initial, max));
      } finally {
        if (this.#mesh === mesh) this.#mesh = undefined;
        await mesh.close().catch(() => undefined);
      }
    }
  }

  async *#reports(onSent: () => void): AsyncGenerator<PresenceReport> {
    const interval = this.#options.intervalMs ?? DEFAULT_PRESENCE_INTERVAL_MS;
    while (!this.#stopped) {
      yield this.buildReport();
      this.#reportsSent++;
      onSent();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, interval);
        timer.unref();
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.#wake = done;
      });
    }
  }

  async #refresh(): Promise<void> {
    if (this.#options.refreshTokens === undefined) return;
    try {
      this.#tokens = [...(await this.#options.refreshTokens())];
    } catch (error) {
      this.#log("warn", `could not refresh router tokens: ${String(error)}`);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.#stopController.signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.#stopController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  #log(level: "info" | "warn", message: string): void {
    this.#options.log?.(level, message);
  }
}
