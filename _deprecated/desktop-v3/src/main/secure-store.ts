// Secrets for the renderer (client E2E private key, refresh tokens), encrypted with the OS keychain through
// Electron `safeStorage` (async API) and kept in one 0600 JSON file in the app data directory. Values never
// touch disk in plain text; when the keychain is unavailable the store says so and refuses to write.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** The subset of Electron `safeStorage` this store needs (injectable for tests). */
export interface SecretCipher {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>;
}

// Keys are only JSON property names (the renderer uses e.g. `account.<server>::<user>.refresh_token`).
const KEY_PATTERN = /^[\x20-\x7e]{1,256}$/u;
const MAX_VALUE_BYTES = 64 * 1024;

export class SecureStoreError extends Error {
  override readonly name = "SecureStoreError";
}

export function assertSecretKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw new SecureStoreError("invalid secret key");
}

export class SecureStore {
  readonly file: string;
  readonly #cipher: SecretCipher;
  #cache: Record<string, string> | undefined;
  /** Serializes read-modify-write cycles (encryption is async). */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, cipher: SecretCipher) {
    this.file = file;
    this.#cipher = cipher;
  }

  async available(): Promise<boolean> {
    try {
      return await this.#cipher.isAvailable();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    assertSecretKey(key);
    const sealed = this.#load()[key];
    if (sealed === undefined) return null;
    if (!(await this.available())) throw new SecureStoreError("the OS keychain is not available");
    let opened: { result: string; shouldReEncrypt?: boolean };
    try {
      opened = await this.#cipher.decrypt(Buffer.from(sealed, "base64"));
    } catch {
      // Sealed with a key this login can no longer open (keychain reset, copied profile): treat as missing.
      return null;
    }
    if (opened.shouldReEncrypt) await this.set(key, opened.result).catch(() => undefined);
    return opened.result;
  }

  set(key: string, value: string): Promise<void> {
    assertSecretKey(key);
    if (typeof value !== "string") throw new SecureStoreError("secret value must be a string");
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new SecureStoreError("secret value too large");
    return this.#serial(async () => {
      if (!(await this.available())) throw new SecureStoreError("the OS keychain is not available");
      const sealed = (await this.#cipher.encrypt(value)).toString("base64");
      this.#save({ ...this.#load(), [key]: sealed });
    });
  }

  delete(key: string): Promise<void> {
    assertSecretKey(key);
    return this.#serial(async () => {
      const data = { ...this.#load() };
      if (!(key in data)) return;
      delete data[key];
      this.#save(data);
    });
  }

  keys(): string[] {
    return Object.keys(this.#load());
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #load(): Record<string, string> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.entries(parsed) : [];
      this.#cache = Object.fromEntries(entries.filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      this.#cache = {};
    }
    return this.#cache;
  }

  #save(data: Record<string, string>): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.#cache = data;
  }
}
