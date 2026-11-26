/**
 * Model providers kept by CC Switch (https://github.com/farion1231/cc-switch, MIT, © Jason Young), read from and
 * written to its database on the device (`~/.cc-switch/cc-switch.db`), so the providers the user already keeps there
 * are the ones Agents Anywhere offers, and one added here shows up there.
 *
 * Only rows of its `providers` table are touched: never which provider is current, its other tables, its settings,
 * the database's journal mode or its schema. Choosing a provider for an agent in Agents Anywhere reaches only the
 * processes Agents Anywhere starts (in their environment, or over ACP): the agent's own configuration, and with it
 * the agent in the user's terminal, keeps what CC Switch wrote.
 *
 * A provider is kept per app in the app's own configuration format (`settings_config`): Claude Code's `{env}`,
 * Codex's `{auth, config}` with `config` the text of a `config.toml`. Read as CC Switch reads them.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeLaunch, codexLaunch, type GatewayLaunch } from "../core/agent-gateway.js";

/** The agents whose CC Switch providers can be used here, by agent id: CC Switch's app of each. */
export const CC_SWITCH_APPS = { claude: "claude", codex: "codex" } as const;
export type CcSwitchApp = (typeof CC_SWITCH_APPS)[keyof typeof CC_SWITCH_APPS];

export function ccSwitchAppOf(agentId: string): CcSwitchApp | undefined {
  return (CC_SWITCH_APPS as Record<string, CcSwitchApp>)[agentId];
}

/** One provider, as the client sees it: its key never leaves the device. */
export interface CcSwitchProvider {
  id: string;
  name: string;
  /** Absent for the app's own sign-in (CC Switch's "official" providers): there is nothing to point it at. */
  baseUrl?: string;
  model?: string;
  hasKey: boolean;
  /** It is the app's own sign-in, not an address of its own. */
  official: boolean;
  /** CC Switch has it in use for the app (what the agent's own configuration says now). */
  current: boolean;
  website?: string;
}

export interface CcSwitchProviderInput {
  name: string;
  baseUrl: string;
  /** Kept when absent (editing); required for a new one. */
  apiKey?: string;
  /** An empty string removes it. */
  model?: string;
}

export class CcSwitchError extends Error {
  constructor(
    readonly reason: "cc_switch_missing" | "cc_switch_unreadable" | "provider_not_found" | "provider_official" | "provider_current" | "provider_invalid",
    message: string,
  ) {
    super(message);
  }
}

interface ProviderRow {
  id: string;
  name: string;
  settings_config: string;
  website_url: string | null;
  category: string | null;
  is_current: number;
}

/** What a provider points the app at, read from its `settings_config`. */
interface Target {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Claude Code: its variables besides the address, key and model (timeouts, models of each size, …). */
  env?: Record<string, string>;
}

// `node:sqlite` comes with Node 22.5+; loaded when first needed, synchronously (a process is configured synchronously).
type Sqlite = typeof import("node:sqlite");
let sqlite: Sqlite | null | undefined;
function loadSqlite(): Sqlite | null {
  if (sqlite === undefined) {
    try {
      sqlite = (process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined) ?? null;
    } catch {
      sqlite = null;
    }
  }
  return sqlite;
}

export class CcSwitchStore {
  readonly dbPath: string;

  constructor(dir: string = path.join(os.homedir(), ".cc-switch")) {
    this.dbPath = path.join(dir, "cc-switch.db");
  }

  /** CC Switch has kept providers on this device (and this Node can read them). */
  get available(): boolean {
    return existsSync(this.dbPath) && loadSqlite() !== null;
  }

  list(app: CcSwitchApp): CcSwitchProvider[] {
    return this.#read((db) =>
      (
        db
          .prepare(
            "SELECT id, name, settings_config, website_url, category, is_current FROM providers WHERE app_type = ? ORDER BY COALESCE(sort_index, 2147483647), created_at, name",
          )
          .all(app) as unknown as ProviderRow[]
      ).map((row) => toProvider(app, row)),
    );
  }

  /** How a process of the app is started to answer through the provider (`error` when it cannot be used). */
  launchOf(app: CcSwitchApp, id: string): GatewayLaunch {
    let row: ProviderRow | undefined;
    try {
      row = this.#row(app, id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (row === undefined) return { error: `the CC Switch provider it uses is gone (${id})` };
    const target = targetOf(app, row);
    if (target.baseUrl === undefined || !target.apiKey) return { error: `the CC Switch provider "${row.name}" has no address or key of its own` };
    if (app === "claude") {
      return claudeLaunch({
        ...(target.env ?? {}),
        ANTHROPIC_BASE_URL: target.baseUrl,
        ANTHROPIC_AUTH_TOKEN: target.apiKey,
        ...(target.model !== undefined ? { ANTHROPIC_MODEL: target.model } : {}),
      });
    }
    return codexLaunch(target.baseUrl, target.apiKey, target.model);
  }

  /** The provider's name, or undefined when it is not there. */
  nameOf(app: CcSwitchApp, id: string): string | undefined {
    try {
      return this.#row(app, id)?.name;
    } catch {
      return undefined;
    }
  }

  /** Add a provider (no `id`) or change one of the user's own; resolves with it. */
  save(app: CcSwitchApp, input: CcSwitchProviderInput, id?: string): CcSwitchProvider {
    const name = input.name.trim();
    const baseUrl = input.baseUrl.trim();
    if (name === "" || baseUrl === "") throw new CcSwitchError("provider_invalid", "a provider needs a name and an address");
    return this.#write((db) => {
      if (id === undefined) {
        if (!input.apiKey) throw new CcSwitchError("provider_invalid", "a new provider needs a key");
        const newId = randomUUID();
        const order = db.prepare("SELECT COALESCE(MAX(sort_index), -1) + 1 AS next FROM providers WHERE app_type = ?").get(app) as { next: number };
        const config = newSettings(app, baseUrl, input.apiKey, input.model || undefined);
        db.prepare(
          "INSERT INTO providers (id, app_type, name, settings_config, created_at, sort_index, meta, is_current) VALUES (?, ?, ?, ?, ?, ?, '{}', 0)",
        ).run(newId, app, name, JSON.stringify(config), Date.now(), order.next);
        return toProvider(app, this.#rowIn(db, app, newId) as ProviderRow);
      }
      const row = this.#rowIn(db, app, id);
      if (row === undefined) throw new CcSwitchError("provider_not_found", `there is no CC Switch provider ${id}`);
      if (targetOf(app, row).baseUrl === undefined) throw new CcSwitchError("provider_official", `"${row.name}" is ${app}'s own sign-in: change it in CC Switch`);
      const config = changedSettings(app, parseJson(row.settings_config), baseUrl, input.apiKey || undefined, input.model);
      db.prepare("UPDATE providers SET name = ?, settings_config = ? WHERE id = ? AND app_type = ?").run(name, JSON.stringify(config), id, app);
      return toProvider(app, this.#rowIn(db, app, id) as ProviderRow);
    });
  }

  /** Remove a provider; not the one CC Switch has in use (as CC Switch itself refuses to). */
  remove(app: CcSwitchApp, id: string): void {
    this.#write((db) => {
      const row = this.#rowIn(db, app, id);
      if (row === undefined) return;
      if (row.is_current) throw new CcSwitchError("provider_current", `CC Switch is using "${row.name}" for ${app}: switch to another one there first`);
      db.prepare("DELETE FROM provider_endpoints WHERE provider_id = ? AND app_type = ?").run(id, app);
      db.prepare("DELETE FROM providers WHERE id = ? AND app_type = ?").run(id, app);
    });
  }

  #row(app: CcSwitchApp, id: string): ProviderRow | undefined {
    return this.#read((db) => this.#rowIn(db, app, id));
  }

  #rowIn(db: import("node:sqlite").DatabaseSync, app: CcSwitchApp, id: string): ProviderRow | undefined {
    return db
      .prepare("SELECT id, name, settings_config, website_url, category, is_current FROM providers WHERE app_type = ? AND id = ?")
      .get(app, id) as unknown as ProviderRow | undefined;
  }

  #open(readOnly: boolean): import("node:sqlite").DatabaseSync {
    const lib = loadSqlite();
    if (lib === null) throw new CcSwitchError("cc_switch_unreadable", "this Node cannot read CC Switch's database (Node 22.5 or later is needed)");
    if (!existsSync(this.dbPath)) throw new CcSwitchError("cc_switch_missing", "CC Switch has no providers on this device");
    try {
      const db = new lib.DatabaseSync(this.dbPath, { readOnly });
      // Waits while CC Switch writes; per connection, nothing of the database changes.
      db.exec("PRAGMA busy_timeout = 5000");
      return db;
    } catch (error) {
      throw new CcSwitchError("cc_switch_unreadable", `CC Switch's database cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #read<T>(run: (db: import("node:sqlite").DatabaseSync) => T): T {
    const db = this.#open(true);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }

  #write<T>(run: (db: import("node:sqlite").DatabaseSync) => T): T {
    const db = this.#open(false);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = run(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
}

function toProvider(app: CcSwitchApp, row: ProviderRow): CcSwitchProvider {
  const target = targetOf(app, row);
  return {
    id: row.id,
    name: row.name,
    ...(target.baseUrl !== undefined ? { baseUrl: target.baseUrl } : {}),
    ...(target.model !== undefined ? { model: target.model } : {}),
    hasKey: Boolean(target.apiKey),
    official: target.baseUrl === undefined,
    current: Boolean(row.is_current),
    ...(row.website_url ? { website: row.website_url } : {}),
  };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const CLAUDE_KEYS = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]);

function targetOf(app: CcSwitchApp, row: ProviderRow): Target {
  const config = parseJson(row.settings_config);
  if (app === "claude") {
    const env = strings(config.env);
    const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
    const rest = Object.fromEntries(Object.entries(env).filter(([key]) => !CLAUDE_KEYS.has(key)));
    return {
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_MODEL ? { model: env.ANTHROPIC_MODEL } : {}),
      ...(Object.keys(rest).length > 0 ? { env: rest } : {}),
    };
  }
  const auth = strings(config.auth);
  const toml = readToml(typeof config.config === "string" ? config.config : "");
  const providerId = toml.root.model_provider;
  const table = providerId !== undefined ? toml.tables[`model_providers.${providerId}`] : undefined;
  const baseUrl = table?.base_url?.trim() || undefined;
  const envKey = table?.env_key;
  const apiKey = auth.OPENAI_API_KEY || (envKey !== undefined ? auth[envKey] : undefined);
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(toml.root.model ? { model: toml.root.model } : {}),
  };
}

/** A provider as CC Switch writes a new custom one. */
function newSettings(app: CcSwitchApp, baseUrl: string, apiKey: string, model: string | undefined): Record<string, unknown> {
  if (app === "claude") {
    return { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ...(model !== undefined ? { ANTHROPIC_MODEL: model } : {}) } };
  }
  const lines = [
    'model_provider = "custom"',
    ...(model !== undefined ? [`model = ${tomlString(model)}`] : []),
    "",
    "[model_providers.custom]",
    'name = "custom"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ];
  return { auth: { OPENAI_API_KEY: apiKey }, config: lines.join("\n") };
}

/** A provider with a new address, key or model; everything else it says stays. */
function changedSettings(
  app: CcSwitchApp,
  config: Record<string, unknown>,
  baseUrl: string,
  apiKey: string | undefined,
  model: string | undefined,
): Record<string, unknown> {
  if (app === "claude") {
    const env: Record<string, unknown> = { ...((config.env as Record<string, unknown> | undefined) ?? {}), ANTHROPIC_BASE_URL: baseUrl };
    if (apiKey !== undefined) {
      if (env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_API_KEY = apiKey;
      else env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    if (model === "") delete env.ANTHROPIC_MODEL;
    else if (model !== undefined) env.ANTHROPIC_MODEL = model;
    return { ...config, env };
  }
  let text = typeof config.config === "string" ? config.config : "";
  const providerId = readToml(text).root.model_provider ?? "custom";
  text = setTomlValue(text, `model_providers.${providerId}`, "base_url", baseUrl);
  if (model !== undefined) text = setTomlValue(text, "", "model", model === "" ? undefined : model);
  const auth = { ...((config.auth as object | undefined) ?? {}), ...(apiKey !== undefined ? { OPENAI_API_KEY: apiKey } : {}) };
  return { ...config, auth, config: text };
}

// ── The few lines of a Codex `config.toml` read here ─────────────────────────────────────────────────────────────
// Top-level `key = value` and `[table]` headers with string values; anything else (arrays, inline tables, multi-line
// strings) is passed over, and left as it is when the text is changed.

interface Toml {
  root: Record<string, string>;
  tables: Record<string, Record<string, string>>;
}

const HEADER = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/u;
const ASSIGN = /^\s*([A-Za-z0-9_\-."]+?)\s*=\s*(.*?)\s*$/u;

function tableName(raw: string): string {
  return raw
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1"))
    .join(".");
}

function tomlValue(raw: string): string | undefined {
  const double = /^"((?:[^"\\]|\\.)*)"/u.exec(raw);
  if (double) return JSON.parse(`"${double[1]}"`) as string;
  const single = /^'([^']*)'/u.exec(raw);
  if (single) return single[1];
  return undefined;
}

export function readToml(text: string): Toml {
  const toml: Toml = { root: {}, tables: {} };
  let table: Record<string, string> = toml.root;
  for (const line of text.split(/\r?\n/u)) {
    const header = HEADER.exec(line);
    if (header && !line.trim().startsWith("[[")) {
      const name = tableName(header[1] as string);
      table = toml.tables[name] ??= {};
      continue;
    }
    const assign = ASSIGN.exec(line);
    if (!assign || line.trim().startsWith("#")) continue;
    const value = tomlValue(assign[2] as string);
    if (value !== undefined) table[tableName(assign[1] as string)] = value;
  }
  return toml;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Set (or with `undefined` remove) `key` in `table` ("" for the top level), adding the table when it is not there. */
export function setTomlValue(text: string, table: string, key: string, value: string | undefined): string {
  const lines = text.split(/\r?\n/u);
  const entry = value === undefined ? undefined : `${key} = ${tomlString(value)}`;
  // The table's lines: after its header (the top level: from the start) up to the next header.
  let start = table === "" ? 0 : -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const header = HEADER.exec(lines[i] as string);
    if (!header) continue;
    if (start !== -1) {
      end = i;
      break;
    }
    if (tableName(header[1] as string) === table) start = i + 1;
  }
  if (start === -1) {
    return entry === undefined ? text : `${text.replace(/\n*$/u, "")}\n\n[${table}]\n${entry}\n`;
  }
  for (let i = start; i < end; i++) {
    const line = lines[i] as string;
    const assign = ASSIGN.exec(line);
    if (assign && !line.trim().startsWith("#") && tableName(assign[1] as string) === key) {
      if (entry === undefined) lines.splice(i, 1);
      else lines[i] = entry;
      return lines.join("\n");
    }
  }
  if (entry === undefined) return text;
  // After the table's last line that is not blank.
  let at = end;
  while (at > start && (lines[at - 1] as string).trim() === "") at--;
  lines.splice(at, 0, entry);
  return lines.join("\n");
}
