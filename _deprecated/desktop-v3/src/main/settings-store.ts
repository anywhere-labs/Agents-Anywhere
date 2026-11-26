// Small persisted desktop settings (control server URL), kept in the app data directory.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { DesktopSettings } from "../shared/bridge";

export function normalizeControlUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("the control server URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("the control server URL must be an absolute http(s) URL");
  }
  return value;
}

export class SettingsStore {
  readonly file: string;
  readonly #defaults: DesktopSettings;
  #cache: DesktopSettings | undefined;

  constructor(file: string, defaults: DesktopSettings) {
    this.file = file;
    this.#defaults = defaults;
  }

  get(): DesktopSettings {
    if (this.#cache) return this.#cache;
    let stored: Partial<DesktopSettings> = {};
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DesktopSettings>;
    } catch {
      stored = {};
    }
    this.#cache = {
      controlUrl: typeof stored.controlUrl === "string" && stored.controlUrl ? stored.controlUrl : this.#defaults.controlUrl,
    };
    return this.#cache;
  }

  update(patch: Partial<DesktopSettings>): DesktopSettings {
    const next = { ...this.get(), ...patch };
    if (patch.controlUrl !== undefined) next.controlUrl = normalizeControlUrl(patch.controlUrl);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.file);
    this.#cache = next;
    return next;
  }
}
