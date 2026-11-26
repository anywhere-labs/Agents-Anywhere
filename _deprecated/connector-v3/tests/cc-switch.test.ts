// CC Switch's model providers (`runtime/cc-switch.ts`) in a database laid out as CC Switch lays out its own, used by a
// real `ConnectorHost` (initialized, not serving) for agents named as CC Switch's apps; and reading subscription
// usage answers (`runtime/subscription-usage.ts`).
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import type { CatalogAgent } from "../src/core/agent-catalog.js";
import { ConnectorHost } from "../src/host/connector-host.js";
import { AgentFinder } from "../src/runtime/agent-finder.js";
import { CcSwitchStore, readToml, setTomlValue } from "../src/runtime/cc-switch.js";
import { readClaudeCredentials, readClaudeUsage, readCodexUsage } from "../src/runtime/subscription-usage.js";

const TUNNEL = { metadata: {}, tunnel: { id: "tun_1", principal: "user:1/client:web" }, e2e: null, idempotencyKey: undefined, remainingMs: () => null, signal: new AbortController().signal } as unknown as RpcContext;

// As CC Switch creates them (v4, user_version 26).
const SCHEMA = `
CREATE TABLE providers (
  id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
  created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT, meta TEXT NOT NULL DEFAULT '{}',
  is_current BOOLEAN NOT NULL DEFAULT 0, in_failover_queue BOOLEAN NOT NULL DEFAULT 0, "cost_multiplier" TEXT NOT NULL DEFAULT '1.0',
  "limit_daily_usd" TEXT, "limit_monthly_usd" TEXT, "provider_type" TEXT, PRIMARY KEY (id, app_type));
CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, url TEXT NOT NULL, added_at INTEGER,
  FOREIGN KEY (provider_id, app_type) REFERENCES providers(id, app_type) ON DELETE CASCADE);
PRAGMA user_version = 26;
`;

const CODEX_CONFIG = `model_provider = "custom"
model = "deepseek-v4"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = true
`;

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-ccswitch-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function ccSwitchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(root, "cc-switch-"));
  const db = new DatabaseSync(path.join(dir, "cc-switch.db"));
  db.exec(SCHEMA);
  const add = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, category, sort_index, is_current) VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run("claude-official", "claude", "Claude Official", JSON.stringify({ env: {} }), "official", 0, 0);
  add.run(
    "relay",
    "claude",
    "Relay",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_AUTH_TOKEN: "sk-relay", API_TIMEOUT_MS: "600000" } }),
    null,
    1,
    1,
  );
  add.run("deepseek", "codex", "DeepSeek", JSON.stringify({ auth: { OPENAI_API_KEY: "sk-deepseek" }, config: CODEX_CONFIG }), "cn_official", 0, 0);
  add.run("codex-official", "codex", "OpenAI Official", JSON.stringify({ auth: {}, config: "" }), "official", 1, 1);
  db.close();
  return dir;
}

const rows = (dir: string) => {
  const db = new DatabaseSync(path.join(dir, "cc-switch.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, app_type, name, settings_config, is_current FROM providers ORDER BY app_type, sort_index").all() as {
      id: string;
      app_type: string;
      name: string;
      settings_config: string;
      is_current: number;
    }[];
  } finally {
    db.close();
  }
};

describe("CC Switch's providers", () => {
  it("are read as CC Switch keeps them, without their keys", async () => {
    const store = new CcSwitchStore(await ccSwitchDir());
    assert.equal(store.available, true);
    assert.deepEqual(store.list("claude"), [
      { id: "claude-official", name: "Claude Official", hasKey: false, official: true, current: false },
      { id: "relay", name: "Relay", baseUrl: "https://relay.example.com", hasKey: true, official: false, current: true },
    ]);
    assert.deepEqual(store.list("codex")[0], { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4", hasKey: true, official: false, current: false });
    assert.equal(new CcSwitchStore(path.join(root, "none")).available, false);
  });

  it("start an agent the way the app's own configuration would, without touching the database", async () => {
    const dir = await ccSwitchDir();
    const before = rows(dir);
    const store = new CcSwitchStore(dir);
    const claude = store.launchOf("claude", "relay");
    assert.equal(claude.env?.ANTHROPIC_BASE_URL, "https://relay.example.com");
    assert.equal(claude.env?.ANTHROPIC_AUTH_TOKEN, "sk-relay");
    assert.equal(claude.env?.API_TIMEOUT_MS, "600000", "the provider's other variables come along");
    assert.equal(claude.env?.ANTHROPIC_API_KEY, "", "no other way to sign in goes before it");
    // Codex takes its address as it is: the Responses API is under it.
    assert.deepEqual(store.launchOf("codex", "deepseek"), {
      provider: { providerId: "openai", apiType: "openai", baseUrl: "https://api.deepseek.com", headers: { Authorization: "Bearer sk-deepseek" } },
      env: { CODEX_CONFIG: JSON.stringify({ model: "deepseek-v4" }) },
    });
    assert.match(store.launchOf("claude", "claude-official").error ?? "", /no address or key/);
    assert.match(store.launchOf("claude", "gone").error ?? "", /is gone/);
    assert.deepEqual(rows(dir), before);
  });

  it("are added and changed in CC Switch's own format, keeping what else they say", async () => {
    const dir = await ccSwitchDir();
    const store = new CcSwitchStore(dir);
    const added = store.save("codex", { name: "Gateway", baseUrl: "https://gw.example.com/v1", apiKey: "sk-gw", model: "gpt-x" });
    assert.deepEqual({ ...added, id: undefined }, { id: undefined, name: "Gateway", baseUrl: "https://gw.example.com/v1", model: "gpt-x", hasKey: true, official: false, current: false });
    const saved = rows(dir).find((row) => row.id === added.id);
    assert.equal(saved?.is_current, 0);
    const config = JSON.parse(saved?.settings_config ?? "{}") as { auth: Record<string, string>; config: string };
    assert.deepEqual(config.auth, { OPENAI_API_KEY: "sk-gw" });
    assert.deepEqual(readToml(config.config), {
      root: { model_provider: "custom", model: "gpt-x" },
      tables: { "model_providers.custom": { name: "custom", base_url: "https://gw.example.com/v1", wire_api: "responses" } },
    });

    // A change keeps the key and everything else it does not name.
    store.save("codex", { name: "DeepSeek 2", baseUrl: "https://api.deepseek.com/v2", model: "" }, "deepseek");
    const changed = JSON.parse(rows(dir).find((row) => row.id === "deepseek")?.settings_config ?? "{}") as { auth: Record<string, string>; config: string };
    assert.deepEqual(changed.auth, { OPENAI_API_KEY: "sk-deepseek" });
    assert.equal(changed.config, CODEX_CONFIG.replace('model = "deepseek-v4"\n', "").replace("https://api.deepseek.com", "https://api.deepseek.com/v2"));
    store.save("claude", { name: "Relay", baseUrl: "https://relay2.example.com", apiKey: "sk-new", model: "m" }, "relay");
    assert.deepEqual(JSON.parse(rows(dir).find((row) => row.id === "relay")?.settings_config ?? "{}"), {
      env: { ANTHROPIC_BASE_URL: "https://relay2.example.com", ANTHROPIC_AUTH_TOKEN: "sk-new", API_TIMEOUT_MS: "600000", ANTHROPIC_MODEL: "m" },
    });

    assert.throws(() => store.save("claude", { name: "x", baseUrl: "https://x.example" }, "claude-official"), /own sign-in/);
    assert.throws(() => store.save("claude", { name: "x", baseUrl: "https://x.example" }), /needs a key/);
    assert.throws(() => store.remove("claude", "relay"), /CC Switch is using/);
    store.remove("codex", added.id);
    assert.equal(rows(dir).some((row) => row.id === added.id), false);
  });

  it("change only the line of a config.toml they name", () => {
    assert.equal(setTomlValue('a = "1"\n\n[t]\nb = "2"\n', "", "model", "m"), 'a = "1"\nmodel = "m"\n\n[t]\nb = "2"\n');
    assert.equal(setTomlValue('[t]\nb = "2"\n\n[u]\nc = "3"\n', "t", "b", undefined), '[t]\n\n[u]\nc = "3"\n');
    assert.equal(setTomlValue('[t]\nb = "2"\n\n[u]\nc = "3"\n', "t", "d", "4"), '[t]\nb = "2"\nd = "4"\n\n[u]\nc = "3"\n');
    assert.equal(setTomlValue('a = "1"\n', "x.y", "z", "w"), 'a = "1"\n\n[x.y]\nz = "w"\n');
    assert.deepEqual(readToml('[model_providers."my-gw"]\nbase_url = \'https://g\' # here\n').tables, { "model_providers.my-gw": { base_url: "https://g" } });
  });
});

// ── On a device ──

const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log] = process.argv.slice(2);
const note = (kind, value) => fs.appendFileSync(log, kind + " " + JSON.stringify(value) + "\n");
note("spawn", { url: process.env.ANTHROPIC_BASE_URL || null, key: process.env.ANTHROPIC_AUTH_TOKEN || null });
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let created = 0;
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id === undefined) continue;
    const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
    else if (msg.method === "session/new") { note("meta", msg.params._meta || null); reply({ sessionId: "acp-" + ++created }); }
    else reply({});
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const hosts: ConnectorHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

async function setup() {
  const dir = await mkdtemp(path.join(root, "device-"));
  const [bin, project] = [path.join(dir, "bin"), path.join(dir, "project")];
  for (const each of [bin, project]) await mkdir(each);
  const script = path.join(dir, "agent.cjs");
  const log = path.join(dir, "agent.log");
  await writeFile(script, FAKE_AGENT);
  await writeFile(log, "");
  const program = path.join(bin, "claude");
  await writeFile(program, `#!/bin/sh\nexec '${process.execPath}' '${script}' '${log}'\n`);
  await chmod(program, 0o755);
  const store = new CcSwitchStore(await ccSwitchDir());
  const claude: CatalogAgent = { id: "claude", name: "Claude Code", website: "https://agent.example", programs: ["claude"], args: [], install: [] };
  const host = new ConnectorHost({
    dataDir: path.join(dir, "state"),
    deviceId: "dev_ccswitch",
    catalog: [claude],
    finder: new AgentFinder({ env: { PATH: bin }, home: dir, usualFolders: ["/usr/bin", "/bin"], folders: [], readShellPath: async () => undefined }),
    ccSwitch: store,
    waitTimeoutMs: 5_000,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  hosts.push(host);
  await host.init();
  const noted = async (kind: string) =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith(`${kind} `))
      .map((line) => JSON.parse(line.slice(kind.length + 1)) as unknown);
  return { host, store, device: host.deviceService, create: () => host.sessionsService.create({ agent: "claude", cwd: project }, TUNNEL), noted, agentsJson: path.join(dir, "state", "agents.json") };
}

async function refusedWith(run: () => unknown, code: string, reason: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof MeshCallError, String(error));
    assert.deepEqual([error.code, error.reason], [code, reason], error.message);
    return;
  }
  assert.fail(`not refused (${reason})`);
}

describe("an agent answering through a CC Switch provider", { skip: process.platform === "win32" }, () => {
  it("is started with it, its key nowhere but the process; its own configuration otherwise", async () => {
    const f = await setup();
    assert.deepEqual(f.device.agents({}, TUNNEL).agents[0]?.cc_switch, { available: true });
    const listed = await f.device.list_providers({ id: "claude" }, TUNNEL);
    assert.deepEqual(listed.providers.map((p) => [p.id, p.official, p.current]), [["claude-official", true, false], ["relay", false, true]]);
    assert.equal(JSON.stringify(listed).includes("sk-relay"), false);

    const entry = await f.device.update_agent({ id: "claude", provider: "relay" }, TUNNEL);
    assert.deepEqual(entry.cc_switch, { available: true, provider: { id: "relay", name: "Relay" } });
    assert.equal((await f.device.list_providers({ id: "claude" }, TUNNEL)).selected, "relay");
    await f.create();
    assert.deepEqual((await f.noted("spawn")).at(-1), { url: "https://relay.example.com", key: "sk-relay" });
    // Claude Code's own settings must not go before it.
    const meta = (await f.noted("meta")).at(-1) as { claudeCode: { options: { settings: { env: Record<string, string> } } } };
    assert.equal(meta.claudeCode.options.settings.env.ANTHROPIC_BASE_URL, "https://relay.example.com");
    // Only its id is kept by Agents Anywhere.
    assert.equal((await readFile(f.agentsJson, "utf8")).includes("sk-relay"), false);

    await refusedWith(() => f.device.remove_provider({ id: "claude", provider_id: "relay" }, TUNNEL), "failed_precondition", "provider_in_use");
    await refusedWith(() => f.device.update_agent({ id: "claude", provider: "claude-official" }, TUNNEL), "invalid_argument", "provider_official");
    await refusedWith(() => f.device.update_agent({ id: "claude", provider: "nope" }, TUNNEL), "not_found", "provider_not_found");

    // A gateway takes its place; an empty provider goes back to the agent's own configuration.
    const gateway = await f.device.update_agent({ id: "claude", provider: "" }, TUNNEL);
    assert.deepEqual(gateway.cc_switch, { available: true });
    await f.device.stop_agent({ id: "claude", force: true }, TUNNEL);
    await f.create();
    // What it is started with is its own again (here: the test's environment).
    assert.deepEqual((await f.noted("spawn")).at(-1), { url: process.env.ANTHROPIC_BASE_URL || null, key: process.env.ANTHROPIC_AUTH_TOKEN || null });
  });

  it("refuses to start once the provider is gone, rather than answer through something else", async () => {
    const f = await setup();
    const added = await f.device.save_provider({ id: "claude", name: "Temp", base_url: "https://temp.example.com", api_key: "sk-temp" }, TUNNEL);
    await f.device.update_agent({ id: "claude", provider: added.id }, TUNNEL);
    // Gone behind Agents Anywhere's back (removed in CC Switch).
    const db = new DatabaseSync(f.store.dbPath);
    db.prepare("DELETE FROM providers WHERE id = ?").run(added.id);
    db.close();
    await f.device.update_agent({ id: "claude", idle_close_minutes: 5 }, TUNNEL);
    assert.deepEqual(f.device.agents({}, TUNNEL).agents[0]?.cc_switch, { available: true, provider: { id: added.id } });
    await assert.rejects(() => f.create(), /provider it uses is gone/);
  });
});

describe("subscription usage", () => {
  it("reads Claude's windows, the newer per-model limits included", () => {
    const usage = readClaudeUsage({
      five_hour: { utilization: 51, resets_at: "2026-11-26T05:00:00Z" },
      seven_day: { utilization: 5, resets_at: "2026-11-30T00:00:00Z" },
      seven_day_opus: null,
      limits: [
        { kind: "weekly_scoped", group: "weekly", scope: { model: { display_name: "Sonnet" } }, percent: 12, resets_at: "2026-11-30T00:00:00Z" },
        { kind: "weekly_scoped", group: "weekly", scope: { surface: "web", model: { display_name: "Opus" } }, percent: 80 },
      ],
      extra_usage: { is_enabled: false },
    });
    assert.deepEqual(usage.windows, [
      { name: "five_hour", usedPercent: 51, resetsAt: "2026-11-26T05:00:00Z" },
      { name: "seven_day", usedPercent: 5, resetsAt: "2026-11-30T00:00:00Z" },
      { name: "seven_day_sonnet", usedPercent: 12, resetsAt: "2026-11-30T00:00:00Z" },
    ]);
    assert.deepEqual(usage.extra, { enabled: false });
  });

  it("reads Codex's windows by their length, its plan and credits", () => {
    const usage = readCodexUsage({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_800_000_000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_at: 1_800_100_000 } },
      credits: { has_credits: true, unlimited: false, balance: "62500" },
    });
    assert.deepEqual(usage.windows, [
      { name: "five_hour", usedPercent: 30, resetsAt: new Date(1_800_000_000_000).toISOString() },
      { name: "seven_day", usedPercent: 0 },
    ]);
    assert.equal(usage.plan, "Pro 200");
    assert.equal(usage.credits, 62_500);
  });

  it("knows a Claude sign-in that has run out from one Claude Code renews itself", () => {
    const now = Date.now();
    const entry = (fields: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: { accessToken: "at", subscriptionType: "max", rateLimitTier: "default_claude_max_20x", ...fields } });
    assert.deepEqual(readClaudeCredentials(entry({ expiresAt: now + 60_000 })), { token: "at", status: "ok", plan: "Max 20x" });
    assert.equal(readClaudeCredentials(entry({ expiresAt: now - 60_000, refreshToken: "rt" }))?.status, "refresh_pending");
    assert.equal(readClaudeCredentials(entry({ expiresAt: now - 60_000 }))?.status, "expired");
    assert.equal(readClaudeCredentials("{}"), undefined);
  });
});
