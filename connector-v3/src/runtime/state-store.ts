/**
 * Persistent local state for the v3 Connector.
 *
 * Layout under `dataDir` (default `~/.agents-anywhere/connector-v3`, mode 0700):
 *
 *   identity.json        device credentials + optional X25519 static key (0600)
 *   settings.json        device-local settings (mode, MCP toggle, limits, name)
 *   paired-clients.json  device-gate trust list (PairedClientEntry[])
 *   sessions.json        opaque SessionStore snapshot array
 *
 * Every file is written atomically (temp file in the same directory, fsync,
 * rename) and with 0600 permissions on POSIX: identity holds secrets, the
 * paired-clients list is integrity-critical, and sessions hold conversation
 * data that never leaves this machine.
 *
 * The shapes here are intentionally self-contained and structurally match
 * `contracts/aa-v3/1.0/control.schema.json` (`DeviceMode`) and
 * `contracts/aa-v3/1.0/pairing.schema.json` (`PairedClientEntry`).
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** `DeviceMode` in control.schema.json. */
export type DeviceMode = "normal" | "encrypted";

/** `PairedClientEntry.platform` in pairing.schema.json. */
export type PairedClientPlatform = "ios" | "android" | "desktop" | "web" | "cli";

export interface DeviceIdentity {
  device_id: string;
  device_secret: string;
  control_url: string;
  /** X25519 static private key, unpadded base64url (32 bytes). Never leaves this machine. */
  e2e_private_key?: string;
  /** X25519 static public key, unpadded base64url (32 bytes). Pinned by clients via QR. */
  e2e_public_key?: string;
}

export interface ConnectorSettings {
  mode: DeviceMode;
  /** "Allow external Agent control" — off by default (architecture §5.2). */
  allow_mcp: boolean;
  /** Require a local confirmation before a new pairing takes effect — off by default (e2ee §9.4). */
  require_pairing_confirm: boolean;
  max_rpc_file_bytes: number;
  device_name: string;
}

/** `PairedClientEntry` in pairing.schema.json. */
export interface PairedClientEntry {
  client_pub: string;
  label: string;
  platform: PairedClientPlatform;
  paired_at: string;
  last_seen_at?: string;
}

export const DEFAULT_MAX_RPC_FILE_BYTES = 8 * 1024 * 1024;

export const STATE_FILES = {
  identity: "identity.json",
  settings: "settings.json",
  pairedClients: "paired-clients.json",
  sessions: "sessions.json",
} as const;

const SECRET_FILE_MODE = 0o600;
const DATA_DIR_MODE = 0o700;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const PAIRED_PLATFORMS: readonly PairedClientPlatform[] = ["ios", "android", "desktop", "web", "cli"];
const IS_WINDOWS = process.platform === "win32";

export class StateStoreError extends Error {
  readonly code: "state_file_invalid" | "state_value_invalid";
  readonly file: string | undefined;

  constructor(code: StateStoreError["code"], message: string, file?: string) {
    super(`${code}: ${message}`);
    this.name = "StateStoreError";
    this.code = code;
    this.file = file;
  }
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), ".agents-anywhere", "connector-v3");
}

export function defaultSettings(): ConnectorSettings {
  return {
    mode: "normal",
    allow_mcp: false,
    require_pairing_confirm: false,
    max_rpc_file_bytes: DEFAULT_MAX_RPC_FILE_BYTES,
    device_name: safeHostname(),
  };
}

// ---------------------------------------------------------------------------
// Atomic file writes (shared with device-ops)
// ---------------------------------------------------------------------------

export interface AtomicWriteOptions {
  /** Permission bits for the new file. Default 0o666 (subject to umask). */
  mode?: number;
  /**
   * Apply `mode` exactly with chmod (bypassing umask). Use for secret files
   * and when preserving the mode of a file being replaced.
   */
  exactMode?: boolean;
}

/**
 * Write `data` to `target` atomically: readers observe either the old or the
 * new content, never a partial write. The temp file lives in the same
 * directory so `rename` never crosses a filesystem boundary.
 */
export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const mode = opts.mode ?? 0o666;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    if (opts.exactMode && !IS_WINDOWS) {
      await handle.chmod(mode);
    }
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(tmp, target);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  if (!IS_WINDOWS) {
    // Best effort: persist the directory entry so the rename survives a crash.
    const dirHandle = await fs.open(dir, "r").catch(() => undefined);
    if (dirHandle) {
      await dirHandle.sync().catch(() => undefined);
      await dirHandle.close().catch(() => undefined);
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // On Windows a rename onto a file that another process holds open can fail
  // transiently with EPERM/EACCES/EBUSY (antivirus, indexers).
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = IS_WINDOWS && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!transient || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export interface StateStoreOptions {
  dataDir?: string;
}

export class StateStore {
  readonly dataDir: string;
  /** Per-file write queue so concurrent saves land in call order. */
  readonly #writeQueues = new Map<string, Promise<unknown>>();
  #initialized: Promise<void> | undefined;

  constructor(opts: StateStoreOptions = {}) {
    this.dataDir = path.resolve(opts.dataDir ?? defaultDataDir());
  }

  pathFor(file: (typeof STATE_FILES)[keyof typeof STATE_FILES]): string {
    return path.join(this.dataDir, file);
  }

  /** Create `dataDir` (0700) if needed. Idempotent; called by every save. */
  init(): Promise<void> {
    this.#initialized ??= (async () => {
      await fs.mkdir(this.dataDir, { recursive: true, mode: DATA_DIR_MODE });
    })().catch((err: unknown) => {
      this.#initialized = undefined;
      throw err;
    });
    return this.#initialized;
  }

  // -- identity ------------------------------------------------------------

  async loadIdentity(): Promise<DeviceIdentity | null> {
    const file = this.pathFor(STATE_FILES.identity);
    const raw = await this.#readJson(file);
    if (raw === undefined) return null;
    await tightenMode(file);
    return parseIdentity(raw, file);
  }

  async saveIdentity(identity: DeviceIdentity): Promise<void> {
    const value = parseIdentity(identity, undefined);
    await this.#writeJson(STATE_FILES.identity, value);
  }

  // -- settings ------------------------------------------------------------

  /** Returns defaults merged with the persisted file; missing file → defaults. */
  async loadSettings(): Promise<ConnectorSettings> {
    const file = this.pathFor(STATE_FILES.settings);
    const raw = await this.#readJson(file);
    if (raw === undefined) return defaultSettings();
    return parseSettings(raw, file);
  }

  async saveSettings(settings: ConnectorSettings): Promise<void> {
    const value = parseSettings(settings, undefined, { requireAll: true });
    await this.#writeJson(STATE_FILES.settings, value);
  }

  /** Load, apply a partial update, validate, persist, and return the result. */
  async updateSettings(patch: Partial<ConnectorSettings>): Promise<ConnectorSettings> {
    const next = parseSettings({ ...(await this.loadSettings()), ...patch }, undefined, { requireAll: true });
    await this.#writeJson(STATE_FILES.settings, next);
    return next;
  }

  // -- paired clients ------------------------------------------------------

  async loadPairedClients(): Promise<PairedClientEntry[]> {
    const file = this.pathFor(STATE_FILES.pairedClients);
    const raw = await this.#readJson(file);
    if (raw === undefined) return [];
    return parsePairedClients(raw, file);
  }

  async savePairedClients(clients: readonly PairedClientEntry[]): Promise<void> {
    const value = parsePairedClients(clients, undefined);
    await this.#writeJson(STATE_FILES.pairedClients, value);
  }

  // -- sessions snapshot ---------------------------------------------------

  async loadSessionsSnapshot<T = unknown>(): Promise<T[]> {
    const file = this.pathFor(STATE_FILES.sessions);
    const raw = await this.#readJson(file);
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw new StateStoreError("state_file_invalid", "sessions snapshot must be a JSON array", file);
    }
    return raw as T[];
  }

  async saveSessionsSnapshot(snapshot: readonly unknown[]): Promise<void> {
    if (!Array.isArray(snapshot)) {
      throw new StateStoreError("state_value_invalid", "sessions snapshot must be an array");
    }
    await this.#writeJson(STATE_FILES.sessions, snapshot);
  }

  // -- internals -----------------------------------------------------------

  async #readJson(file: string): Promise<unknown> {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new StateStoreError("state_file_invalid", `not valid JSON (${(err as Error).message})`, file);
    }
  }

  async #writeJson(name: string, value: unknown): Promise<void> {
    await this.init();
    const file = path.join(this.dataDir, name);
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const previous = this.#writeQueues.get(file) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => atomicWriteFile(file, body, { mode: SECRET_FILE_MODE, exactMode: true }));
    this.#writeQueues.set(file, next);
    try {
      await next;
    } finally {
      if (this.#writeQueues.get(file) === next) this.#writeQueues.delete(file);
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(file: string | undefined, message: string): StateStoreError {
  return file === undefined
    ? new StateStoreError("state_value_invalid", message)
    : new StateStoreError("state_file_invalid", message, file);
}

function requireString(obj: Record<string, unknown>, key: string, file: string | undefined, max = 4096): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(file, `${key} must be a non-empty string (≤ ${max} chars)`);
  }
  return value;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function parseIdentity(raw: unknown, file: string | undefined): DeviceIdentity {
  if (!isRecord(raw)) throw invalid(file, "identity must be a JSON object");
  const identity: DeviceIdentity = {
    device_id: requireString(raw, "device_id", file, 128),
    device_secret: requireString(raw, "device_secret", file),
    control_url: requireString(raw, "control_url", file),
  };
  for (const key of ["e2e_private_key", "e2e_public_key"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !BASE64URL_32.test(value)) {
      throw invalid(file, `${key} must be 32 bytes of unpadded base64url`);
    }
    identity[key] = value;
  }
  if ((identity.e2e_private_key === undefined) !== (identity.e2e_public_key === undefined)) {
    throw invalid(file, "e2e_private_key and e2e_public_key must be set together");
  }
  return identity;
}

function parseSettings(
  raw: unknown,
  file: string | undefined,
  opts: { requireAll?: boolean } = {},
): ConnectorSettings {
  if (!isRecord(raw)) throw invalid(file, "settings must be a JSON object");
  const defaults = defaultSettings();
  const pick = <K extends keyof ConnectorSettings>(
    key: K,
    check: (value: unknown) => value is ConnectorSettings[K],
    expected: string,
  ): ConnectorSettings[K] => {
    const value = raw[key];
    if (value === undefined) {
      if (opts.requireAll) throw invalid(file, `${key} is required`);
      return defaults[key];
    }
    // A present-but-invalid value is an error, never a silent fallback: a
    // corrupted `mode` must not quietly downgrade an encrypted device.
    if (!check(value)) throw invalid(file, `${key} must be ${expected}`);
    return value;
  };
  return {
    mode: pick("mode", (v): v is DeviceMode => v === "normal" || v === "encrypted", '"normal" or "encrypted"'),
    allow_mcp: pick("allow_mcp", (v): v is boolean => typeof v === "boolean", "a boolean"),
    require_pairing_confirm: pick(
      "require_pairing_confirm",
      (v): v is boolean => typeof v === "boolean",
      "a boolean",
    ),
    max_rpc_file_bytes: pick(
      "max_rpc_file_bytes",
      (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
      "a positive integer",
    ),
    device_name: pick(
      "device_name",
      (v): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 128,
      "a non-empty string (≤ 128 chars)",
    ),
  };
}

function parsePairedClients(raw: unknown, file: string | undefined): PairedClientEntry[] {
  if (!Array.isArray(raw)) throw invalid(file, "paired clients must be a JSON array");
  const seen = new Set<string>();
  return raw.map((item: unknown, index): PairedClientEntry => {
    if (!isRecord(item)) throw invalid(file, `paired client #${index} must be an object`);
    const clientPub = item.client_pub;
    if (typeof clientPub !== "string" || !BASE64URL_32.test(clientPub)) {
      throw invalid(file, `paired client #${index}: client_pub must be 32 bytes of unpadded base64url`);
    }
    if (seen.has(clientPub)) throw invalid(file, `paired client #${index}: duplicate client_pub`);
    seen.add(clientPub);
    const label = requireString(item, "label", file, 128);
    const platform = item.platform;
    if (typeof platform !== "string" || !PAIRED_PLATFORMS.includes(platform as PairedClientPlatform)) {
      throw invalid(file, `paired client #${index}: platform must be one of ${PAIRED_PLATFORMS.join(", ")}`);
    }
    if (!isInstant(item.paired_at)) throw invalid(file, `paired client #${index}: paired_at must be a timestamp`);
    const entry: PairedClientEntry = {
      client_pub: clientPub,
      label,
      platform: platform as PairedClientPlatform,
      paired_at: item.paired_at,
    };
    if (item.last_seen_at !== undefined) {
      if (!isInstant(item.last_seen_at)) {
        throw invalid(file, `paired client #${index}: last_seen_at must be a timestamp`);
      }
      entry.last_seen_at = item.last_seen_at;
    }
    return entry;
  });
}

async function tightenMode(file: string): Promise<void> {
  if (IS_WINDOWS) return;
  try {
    const stat = await fs.stat(file);
    if ((stat.mode & 0o077) !== 0) await fs.chmod(file, SECRET_FILE_MODE);
  } catch {
    // The subsequent read reports real errors.
  }
}

function safeHostname(): string {
  const name = os.hostname().trim().slice(0, 128);
  return name.length > 0 ? name : "connector";
}
