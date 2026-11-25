// Model gateways (`core/agent-gateway.ts`): what each agent is given to use one, and an agent's gateway on a real
// `ConnectorHost` (initialized, not serving) whose catalog has agents of its own, scripts around a stdio ACP agent that
// writes down the environment it was started with and the requests it was sent.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import { AGENT_CATALOG, type CatalogAgent } from "../src/core/agent-catalog.js";
import { CLAUDE_GATEWAY, CODEX_GATEWAY, COPILOT_GATEWAY, GOOSE_GATEWAY, KILO_GATEWAY, KIMI_GATEWAY, OPENCODE_GATEWAY, QWEN_GATEWAY, type AgentGateway } from "../src/core/agent-gateway.js";
import { ModelGatewaySchema } from "../src/core/config.js";
import { ConnectorHost } from "../src/host/connector-host.js";
import { AgentFinder } from "../src/runtime/agent-finder.js";

const KEY = "sk-aa-secret-key";
const TUNNEL = { metadata: {}, tunnel: { id: "tun_1", principal: "user:1/client:web" }, e2e: null, idempotencyKey: undefined, remainingMs: () => null, signal: new AbortController().signal } as unknown as RpcContext;

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

describe("what an agent is given", () => {
  const gateway = { base_url: "https://gw.example.com", api_key: KEY, model: "some/model" };

  it("is the address the way its client wants it", () => {
    const url = (agent: AgentGateway, base_url: string): unknown => {
      const launch = agent.launch({ ...gateway, base_url });
      return launch.provider?.baseUrl ?? launch.env?.ANTHROPIC_BASE_URL ?? launch.env?.OPENAI_BASE_URL;
    };
    for (const agent of [CODEX_GATEWAY, QWEN_GATEWAY]) {
      assert.equal(url(agent, "https://gw.example.com"), "https://gw.example.com/v1");
      assert.equal(url(agent, "https://gw.example.com/"), "https://gw.example.com/v1");
      assert.equal(url(agent, "https://gw.example.com/v1/"), "https://gw.example.com/v1");
      assert.equal(url(agent, "http://127.0.0.1:4000/openai"), "http://127.0.0.1:4000/openai");
    }
    assert.equal(url(CLAUDE_GATEWAY, "https://gw.example.com/v1/"), "https://gw.example.com");
    assert.equal(url(CLAUDE_GATEWAY, "https://gw.example.com/anthropic"), "https://gw.example.com/anthropic");
    const goose = (base_url: string) => GOOSE_GATEWAY.launch({ ...gateway, base_url }).env ?? {};
    assert.deepEqual([goose("https://gw.example.com").OPENAI_HOST, goose("https://gw.example.com").OPENAI_BASE_PATH], ["https://gw.example.com", "v1/chat/completions"]);
    assert.equal(goose("https://gw.example.com/a/b/").OPENAI_BASE_PATH, "a/b/chat/completions");
  });

  it("goes before the user's own settings in Claude Code, and leaves nothing of theirs in between", () => {
    const { env, sessionMeta } = CLAUDE_GATEWAY.launch(gateway);
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, KEY);
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) assert.equal(env?.[name], "", name);
    for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(env?.[name], "some/model", name);
    assert.deepEqual(sessionMeta, { claudeCode: { options: { settings: { apiKeyHelper: "", env } } } });
    assert.equal("ANTHROPIC_MODEL" in (CLAUDE_GATEWAY.launch({ base_url: gateway.base_url, api_key: KEY }).env ?? {}), false);
  });

  it("is a provider for Codex, and a piece of configuration for OpenCode and Kilo Code", () => {
    assert.deepEqual(CODEX_GATEWAY.launch(gateway), {
      provider: { providerId: "openai", apiType: "openai", baseUrl: "https://gw.example.com/v1", headers: { Authorization: `Bearer ${KEY}` } },
      env: { CODEX_CONFIG: '{"model":"some/model"}' },
    });
    assert.equal(CODEX_GATEWAY.launch({ base_url: gateway.base_url, api_key: KEY }).env, undefined);
    for (const [agent, variable] of [[OPENCODE_GATEWAY, "OPENCODE_CONFIG_CONTENT"], [KILO_GATEWAY, "KILO_CONFIG_CONTENT"]] as const) {
      const config = JSON.parse(agent.launch(gateway).env?.[variable] ?? "") as { model: string; provider: Record<string, { options: unknown; models: object }> };
      assert.equal(config.model, "gateway/some/model");
      assert.deepEqual(config.provider.gateway?.options, { baseURL: "https://gw.example.com/v1", apiKey: KEY });
      assert.deepEqual(Object.keys(config.provider.gateway?.models ?? {}), ["some/model"]);
    }
  });

  it("names the key and the model for every agent of the catalog that has one", () => {
    const agents = AGENT_CATALOG.filter((agent) => agent.gateway !== undefined);
    assert.deepEqual(agents.map((agent) => agent.id).sort(), ["claude", "codex", "copilot", "goose", "kilo", "kimi", "opencode", "qwen"]);
    for (const agent of agents) {
      const launch = JSON.stringify(agent.gateway?.launch(gateway));
      for (const part of [KEY, "some/model", "gw.example.com"]) assert.ok(launch.includes(part), `${agent.id}: ${part}`);
    }
    assert.deepEqual([COPILOT_GATEWAY, KIMI_GATEWAY].map((agent) => agent.modelRequired), [true, true]);
  });

  it("is only ever an http(s) address without a user, query or fragment", () => {
    const ok = (base_url: string) => ModelGatewaySchema.safeParse({ base_url, api_key: KEY }).success;
    for (const url of ["https://gw.example.com", "http://127.0.0.1:4000/v1", "https://gw.example.com/a/b/"]) assert.equal(ok(url), true, url);
    for (const url of ["", "gw.example.com", "ftp://gw.example.com", "file:///etc/passwd", "https://me:pass@gw.example.com", "https://gw.example.com?x=1", "https://gw.example.com/#x"]) {
      assert.equal(ok(url), false, url);
    }
  });
});

// ── On a device ──

const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, providers] = process.argv.slice(2);
const note = (kind, value) => fs.appendFileSync(log, kind + " " + JSON.stringify(value) + "\n");
note("spawn", { url: process.env.GW_URL || null, key: process.env.GW_KEY || null, mine: process.env.MINE || null });
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let created = 0;
let model = process.env.GW_MODEL || "own-model";
const config = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: ["own-model", "other-model", process.env.GW_MODEL].filter(Boolean).map((value) => ({ value, name: value })) }];
function handle(msg) {
  if (msg.method === undefined || msg.id === undefined) return;
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method !== "initialize") note("request", { method: msg.method, params: msg.params });
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, ...(providers === "providers" ? { providers: {} } : {}) } });
    case "session/new": return reply({ sessionId: "acp-" + process.pid + "-" + ++created, configOptions: config() });
    case "session/set_config_option": model = msg.params.value; return reply({ configOptions: config() });
    case "session/prompt": return reply({ stopReason: "end_turn" });
    case "providers/set":
      if (msg.params.headers.Authorization === "Bearer refuse-me") return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "no such provider" } });
      return reply({});
    case "session/resume":
    case "session/close": return reply({});
    default: out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no " + msg.method } });
  }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Reads its gateway from the environment, and from what its sessions are opened with. */
const ENV_GATEWAY: AgentGateway = {
  api: "openai-chat",
  modelRequired: true,
  launch: ({ base_url, api_key, model }) => ({ env: { GW_URL: base_url, GW_KEY: api_key, GW_MODEL: model ?? "" }, sessionMeta: { gateway: base_url } }),
};
/** Is told about it with `providers/set`. */
const PROVIDER_GATEWAY: AgentGateway = {
  api: "openai-responses",
  modelRequired: false,
  launch: ({ base_url, api_key }) => ({ provider: { providerId: "openai", apiType: "openai", baseUrl: base_url, headers: { Authorization: `Bearer ${api_key}` } } }),
};

let root: string;
const hosts: ConnectorHost[] = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-gateway-"));
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(path.join(root, "device-"));
  const [bin, project] = [path.join(dir, "bin"), path.join(dir, "project")];
  for (const each of [bin, project]) await mkdir(each);
  const agentScript = path.join(dir, "agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const put = async (name: string, providers: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\nexec '${process.execPath}' '${agentScript}' '${logFile}' ${providers}\n`);
    await chmod(file, 0o755);
  };
  await put("env-agent", "none");
  await put("provider-agent", "providers");
  await put("old-agent", "none");
  const agent = (id: string, gateway?: AgentGateway): CatalogAgent => ({ id, name: id, website: "https://agent.example", programs: [`${id}-agent`], args: [], install: [], ...(gateway ? { gateway } : {}) });
  await put("plain-agent", "none");
  const logs: string[] = [];
  const host = new ConnectorHost({
    dataDir: path.join(dir, "state"),
    deviceId: "dev_gateway",
    catalog: [agent("env", ENV_GATEWAY), agent("provider", PROVIDER_GATEWAY), agent("old", PROVIDER_GATEWAY), agent("plain")],
    finder: new AgentFinder({ env: { PATH: bin }, home: dir, usualFolders: ["/usr/bin", "/bin"], folders: [], readShellPath: async () => undefined }),
    waitTimeoutMs: 5_000,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  hosts.push(host);
  await host.init();
  const noted = async (kind: string) =>
    (await readFile(logFile, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith(`${kind} `))
      .map((line) => JSON.parse(line.slice(kind.length + 1)) as Record<string, unknown>);
  return {
    host,
    device: host.deviceService,
    logs,
    create: (id: string) => host.sessionsService.create({ agent: id, cwd: project }, TUNNEL),
    spawns: () => noted("spawn"),
    requests: async (method: string) => (await noted("request")).filter((r) => r.method === method).map((r) => r.params as Record<string, unknown>),
    saved: async () => JSON.parse(await readFile(path.join(dir, "state", "agents.json"), "utf8")) as { agents: Record<string, { gateway?: unknown }> },
    file: path.join(dir, "state", "agents.json"),
  };
}

describe("an agent's gateway", { skip: process.platform === "win32" }, () => {
  it("is used by the processes started from then on; its key is in agents.json and nowhere else", async () => {
    const f = await setup();
    await f.create("env");
    assert.deepEqual(f.device.agents({}, TUNNEL).agents.map((a) => a.gateway), [
      { api: "openai-chat", model_required: true },
      { api: "openai-responses", model_required: false },
      { api: "openai-responses", model_required: false },
      undefined,
    ]);

    const entry = await f.device.update_agent({ id: "env", env: { MINE: "1", GW_URL: "https://mine.example" }, gateway: { base_url: "https://gw.example.com/v1", api_key: KEY, model: "gw-model" } }, TUNNEL);
    assert.deepEqual(entry.gateway, { api: "openai-chat", model_required: true, base_url: "https://gw.example.com/v1", model: "gw-model" });
    assert.deepEqual(entry.env_keys, ["MINE", "GW_URL"]);
    const session = await f.create("env");
    // The user's own variables are there; the gateway's go before one of the same name.
    assert.deepEqual((await f.spawns()).at(-1), { url: "https://gw.example.com/v1", key: KEY, mine: "1" });
    assert.deepEqual((await f.requests("session/new")).map((p) => p._meta), [undefined, { gateway: "https://gw.example.com/v1" }]);
    assert.equal(session.config.find((c) => c.id === "model")?.current, "gw-model");

    assert.deepEqual((await f.saved()).agents.env?.gateway, { base_url: "https://gw.example.com/v1", api_key: KEY, model: "gw-model" });
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify([f.device.agents({}, TUNNEL), entry, session, f.logs]).includes(KEY), false);
    assert.ok(f.logs.some((line) => line.includes("agent env updated") && line.includes("gateway")), "which field changed is logged");
  });

  it("keeps what is not part of a change, except the key when it moves to another host", async () => {
    const f = await setup();
    const set = (gateway: Record<string, string>) => f.device.update_agent({ id: "env", gateway }, TUNNEL);
    await set({ base_url: "https://gw.example.com", api_key: KEY, model: "a" });
    assert.equal((await set({ model: "b" })).gateway?.model, "b");
    assert.equal((await set({ base_url: "https://gw.example.com/v1" })).gateway?.base_url, "https://gw.example.com/v1");
    assert.deepEqual((await f.saved()).agents.env?.gateway, { base_url: "https://gw.example.com/v1", api_key: KEY, model: "b" });

    for (const base_url of ["https://other.example.com/v1", "http://gw.example.com/v1", "https://gw.example.com:8443/v1"]) {
      await refusedWith(() => set({ base_url }), "invalid_argument", "gateway_key_required");
    }
    await refusedWith(() => set({ api_key: "" }), "invalid_argument", "gateway_key_required");
    await refusedWith(() => set({ model: "" }), "invalid_argument", "gateway_model_required");
    assert.equal((await set({ base_url: "https://other.example.com", api_key: "sk-other" })).gateway?.base_url, "https://other.example.com");
    assert.deepEqual((await f.saved()).agents.env?.gateway, { base_url: "https://other.example.com", api_key: "sk-other", model: "b" });

    // A reset is about how it is started; the gateway goes with an empty address.
    assert.equal((await f.device.update_agent({ id: "env", reset: true }, TUNNEL)).gateway?.base_url, "https://other.example.com");
    assert.deepEqual((await set({ base_url: "" })).gateway, { api: "openai-chat", model_required: true });
    assert.equal((await f.saved()).agents.env, undefined);
    await f.create("env");
    assert.deepEqual((await f.spawns()).at(-1), { url: null, key: null, mine: null });
    assert.equal((await f.requests("session/new")).at(-1)?._meta, undefined);
  });

  it("is told with providers/set, before the first session and to every process", async () => {
    const f = await setup();
    await f.device.update_agent({ id: "provider", gateway: { base_url: "https://gw.example.com/v1", api_key: KEY } }, TUNNEL);
    await f.create("provider");
    const provider = { providerId: "openai", apiType: "openai", baseUrl: "https://gw.example.com/v1", headers: { Authorization: `Bearer ${KEY}` } };
    assert.deepEqual(await f.requests("providers/set"), [provider]);
    await f.create("provider");
    assert.equal((await f.requests("providers/set")).length, 1, "one process, told once");

    await f.device.update_agent({ id: "provider", gateway: { api_key: "sk-new" } }, TUNNEL);
    await f.create("provider");
    assert.deepEqual((await f.requests("providers/set"))[1], { ...provider, headers: { Authorization: "Bearer sk-new" } });
  });

  it("refuses to start an agent that will not use it, rather than have it answer without", async () => {
    const f = await setup();
    await f.device.update_agent({ id: "provider", gateway: { base_url: "https://gw.example.com", api_key: "refuse-me" } }, TUNNEL);
    await assert.rejects(() => f.create("provider"), /refused the model gateway: no such provider/);
    await f.device.update_agent({ id: "old", gateway: { base_url: "https://gw.example.com", api_key: KEY } }, TUNNEL);
    await assert.rejects(() => f.create("old"), /cannot be pointed at a model gateway/);
    assert.deepEqual(f.device.agents({}, TUNNEL).agents.map((a) => a.running), [0, 0, 0, 0]);
    await refusedWith(() => f.device.update_agent({ id: "plain", gateway: { base_url: "https://gw.example.com", api_key: KEY } }, TUNNEL), "failed_precondition", "gateway_unsupported");
    await refusedWith(() => f.host.updateAgent("env", { gateway: { base_url: "gw.example.com", api_key: KEY } }), "invalid_argument", "invalid_agent_settings");
  });

  it("starts the next conversation with its own model, not the one picked for another gateway", async () => {
    const f = await setup();
    const first = await f.create("env");
    await f.host.sessionsService.set_config({ id: first.id, config_id: "model", value: "other-model" }, TUNNEL);
    await f.host.runtimes.rememberSessionConfig(first.id);
    assert.equal(f.host.runtimes.lastSessionConfig("env").model, "other-model");

    await f.device.update_agent({ id: "env", gateway: { base_url: "https://gw.example.com", api_key: KEY, model: "gw-model" } }, TUNNEL);
    assert.equal(f.host.runtimes.lastSessionConfig("env").model, undefined);
    const prepared = await f.host.sessionsService.prepare({ agent: "env" }, TUNNEL);
    assert.equal(prepared.config.find((c) => c.id === "model")?.current, "gw-model");
  });
});
