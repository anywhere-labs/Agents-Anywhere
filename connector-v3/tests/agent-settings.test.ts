// `aa.v3.Device/agents`, `update_agent` and `stop_agent` on a real `ConnectorHost` (initialized, not serving: the
// services are called directly with the contexts MeshCall would hand them; the Router end-to-end test covers the
// wire) and a small stdio ACP agent that logs what it was started with (argv0, args, one environment variable),
// every `session/new` and every `session/cancel`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { generateE2EKey, MeshCallError, PermissionDeniedError, type RpcContext } from "meshcall";

import type { AcpRuntimePreset } from "../src/core/config.js";
import { ConnectorHost } from "../src/host/connector-host.js";
import { UpdateAgentRequestSchema, type AgentEntry } from "../src/rpc/device-service.js";
import type { PushEvent } from "../src/runtime/acp-host.js";
import { StateStore, StateStoreError } from "../src/runtime/state-store.js";

const IS_WINDOWS = process.platform === "win32";

// argv: <log file> [--slow-init=<ms>] [anything else, logged]
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, ...flags] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(log, line + "\n");
note("spawn " + JSON.stringify({ pid: process.pid, argv0: process.argv0, args: process.argv.slice(2), token: process.env.AA_TEST_TOKEN ?? null }));
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = new Map();
async function handle(msg) {
  if (msg.method === undefined) return;
  const { id, method, params } = msg;
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const slow = flags.find((f) => f.startsWith("--slow-init="));
      if (slow) await sleep(Number(slow.split("=")[1]));
      return reply({ protocolVersion: 1, agentCapabilities: {} });
    }
    case "session/new": {
      const sessionId = "acp-" + process.pid + "-" + (sessions.size + 1);
      sessions.set(sessionId, { cancelled: false });
      note("session/new " + process.pid);
      return reply({ sessionId, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }] });
    }
    case "session/cancel": {
      const s = sessions.get(params.sessionId);
      if (s) s.cancelled = true;
      note("cancel " + process.pid);
      return;
    }
    case "session/prompt": {
      const s = sessions.get(params.sessionId);
      s.cancelled = false;
      const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
      // "slow …" runs until cancelled; "slow stubborn …" does not listen to session/cancel either.
      if (text.startsWith("slow")) {
        note("turn " + process.pid);
        for (let i = 0; i < 1000; i++) {
          if (s.cancelled && !text.includes("stubborn")) return reply({ stopReason: "cancelled" });
          await sleep(20);
        }
      }
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " + text } });
      return reply({ stopReason: "end_turn" });
    }
    default:
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: "no " + method } });
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
    if (line.trim()) handle(JSON.parse(line)).catch((e) => process.stderr.write(String(e) + "\n"));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** An environment value that must never show up in an answer, a log line or a push. */
const SECRET = "sk-test-d0-not-leak-9f3a";

/** MeshCall's per-call context, as the services read it. */
function context(fields: Record<string, unknown>): RpcContext {
  return { metadata: {}, tunnel: null, e2e: null, idempotencyKey: undefined, remainingMs: () => null, signal: new AbortController().signal, ...fields } as unknown as RpcContext;
}
/** A client through a plain tunnel (normal device). */
const TUNNEL = context({ tunnel: { id: "tun_1", principal: "user:1/client:web" } });
/** The control plane calling the device directly on behalf of a user. */
const CONTROL = context({ metadata: { "aa-via": "client", "aa-on-behalf-of": "user:1" } });
/** An external agent through the control plane's MCP tools. */
const MCP = context({ metadata: { "aa-via": "mcp", "aa-on-behalf-of": "user:1", "aa-mcp-client": "cursor" } });

type Reply = { delivered: string; reply_text?: string; turn_result?: string };
interface Spawn {
  pid: number;
  argv0: string;
  args: string[];
  token: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The error `run` fails with, sync or async. */
async function refusal(run: () => unknown): Promise<MeshCallError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof MeshCallError, `expected a MeshCallError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected a refusal");
}

async function refusedWith(run: () => unknown, code: string, reason: string): Promise<MeshCallError> {
  const error = await refusal(run);
  assert.equal(error.code, code, error.message);
  assert.equal(error.reason, reason, error.message);
  return error;
}

let root: string;
let agentScript: string;
/** Another name for `node`, to tell a changed command from the preset's. */
let nodeAlias: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-v3-agents-"));
  agentScript = path.join(root, "fake-acp-agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
  nodeAlias = IS_WINDOWS ? process.execPath : path.join(root, "node-alias");
  if (!IS_WINDOWS) await symlink(process.execPath, nodeAlias);
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Fixture {
  host: ConnectorHost;
  dataDir: string;
  dirs: { a: string; b: string };
  /** The preset of `fake` (configured), `slow` (configured, answers initialize after 4 s) and `builtin` (a default preset). */
  presets: { fake: AcpRuntimePreset; slow: AcpRuntimePreset; builtin: AcpRuntimePreset };
  logs: string[];
  pushes: PushEvent[];
  /** Stop this host and start another on the same data directory (the Connector restarts). */
  restart(): Promise<void>;
  spawns(): Promise<Spawn[]>;
  count(prefix: string): Promise<number>;
  agent(id: string): AgentEntry;
}

/** Hosts of the running test: stopped after it, so no agent outlives its test. */
const hosts: ConnectorHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop().catch(() => undefined)));
});

/** `agentsJson`: an `agents.json` already in the data directory when the Connector starts. */
async function setup(options: { agentsJson?: unknown } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(root, "case-"));
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const dirs = { a: path.join(dir, "a"), b: path.join(dir, "b") };
  for (const project of Object.values(dirs)) await mkdir(project);
  const dataDir = path.join(dir, "state");
  if (options.agentsJson !== undefined) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dataDir, "agents.json"), JSON.stringify(options.agentsJson), { mode: 0o600 });
  }
  const presets = {
    fake: { id: "fake", name: "Fake", command: process.execPath, args: [agentScript, logFile] },
    slow: { id: "slow", name: "Slow", command: process.execPath, args: [agentScript, logFile, "--slow-init=4000"] },
    builtin: { id: "builtin", name: "Built-in", command: process.execPath, args: [agentScript, logFile, "--builtin"] },
  };
  const logs: string[] = [];
  const pushes: PushEvent[] = [];
  const make = async () => {
    const host = new ConnectorHost({
      dataDir,
      deviceId: "dev_agents",
      presets: [presets.fake, presets.slow],
      defaultPresets: [presets.builtin],
      waitTimeoutMs: 5_000,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      onPushEvent: (event) => pushes.push(event),
    });
    hosts.push(host);
    await host.init();
    return host;
  };
  const spawns = async () =>
    (await readFile(logFile, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("spawn "))
      .map((line) => JSON.parse(line.slice("spawn ".length)) as Spawn);
  const fixture: Fixture = {
    host: await make(),
    dataDir,
    dirs,
    presets,
    logs,
    pushes,
    restart: async () => {
      await fixture.host.stop();
      fixture.host = await make();
    },
    spawns,
    count: async (prefix) => (await readFile(logFile, "utf8")).split("\n").filter((line) => line.startsWith(`${prefix} `)).length,
    agent: (id) => {
      const entry = fixture.host.deviceService.agents({}, TUNNEL).agents.find((a) => a.id === id);
      assert.ok(entry, `agent ${id} listed`);
      return entry;
    },
  };
  return fixture;
}

describe("Device/agents", () => {
  it("lists every agent with its effective settings and live counts, in the order of status.runtimes", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions } = f.host;
    const { agents } = device.agents({}, TUNNEL);
    assert.deepEqual(agents, [
      { id: "fake", name: "Fake", builtin: false, enabled: true, command: process.execPath, args: f.presets.fake.args, env_keys: [], customized: false, running: 0, busy: 0, idle_close_minutes: 0, sessions: 0, installed: true },
      { id: "slow", name: "Slow", builtin: false, enabled: true, command: process.execPath, args: f.presets.slow.args, env_keys: [], customized: false, running: 0, busy: 0, idle_close_minutes: 0, sessions: 0, installed: true },
      { id: "builtin", name: "Built-in", builtin: true, enabled: true, command: process.execPath, args: f.presets.builtin.args, env_keys: [], customized: false, running: 0, busy: 0, idle_close_minutes: 0, sessions: 0, installed: true },
    ]);
    assert.deepEqual(device.status({}, TUNNEL).runtimes, [
      { id: "fake", name: "Fake" },
      { id: "slow", name: "Slow" },
      { id: "builtin", name: "Built-in" },
    ]);

    // A session and a prepared one share the agent's process; a turn makes the session busy.
    const session = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    await sessions.prepare({ agent: "fake", cwd: f.dirs.b }, TUNNEL);
    assert.deepEqual([f.agent("fake").running, f.agent("fake").sessions, f.agent("fake").busy], [1, 2, 0]);
    await sessions.send({ id: session.id, client_msg_id: "m1", content: "slow work" }, TUNNEL);
    await eventually(async () => (await f.count("turn")) === 1, "the turn reached the agent");
    assert.deepEqual([f.agent("fake").running, f.agent("fake").busy], [1, 1]);
    assert.deepEqual([f.agent("builtin").running, f.agent("builtin").busy], [0, 0]);

    // Read-only, like status: the control plane and MCP (when allowed) may read it too.
    assert.equal(device.agents({}, CONTROL).agents.length, 3);
    f.host.gate.allowMcp = true;
    assert.equal(device.agents({}, MCP).agents.length, 3);
  });
});

describe("Device/update_agent", () => {
  it("turning an agent off hides it, refuses prepare, create and new turns, and closes its prepared agents", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions, store } = f.host;
    const prepared = await sessions.prepare({ agent: "fake", cwd: f.dirs.b }, TUNNEL);
    const session = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    const [spawned] = await f.spawns();
    assert.ok(spawned);

    const off = await device.update_agent({ id: "fake", enabled: false }, TUNNEL);
    assert.equal(off.enabled, false);
    assert.equal(off.customized, false, "the switch is not a customization");
    assert.deepEqual(f.host.runtimes.listPrepared(), []);
    assert.equal(f.host.runtimes.agent("fake").sessions, 1, "the prepared session is closed, the conversation's is not");
    assert.deepEqual(device.status({}, TUNNEL).runtimes.map((r) => r.id), ["slow", "builtin"]);
    assert.deepEqual(device.agents({}, TUNNEL).agents.map((a) => [a.id, a.enabled]), [["fake", false], ["slow", true], ["builtin", true]]);

    await refusedWith(() => sessions.prepare({ agent: "fake", cwd: f.dirs.a }, TUNNEL), "failed_precondition", "agent_disabled");
    const refusedCreate = await refusedWith(() => sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL), "failed_precondition", "agent_disabled");
    assert.equal(refusedCreate.message, "Fake is turned off on this device");
    assert.equal(refusedCreate.details?.agent, "fake");
    assert.equal(store.list().sessions.length, 1, "no session left behind");

    // An existing conversation takes no new turn (its idle agent is not used, nothing is restarted).
    const before = store.listMessages(session.id).messages.length;
    await refusedWith(() => sessions.send({ id: session.id, client_msg_id: "m1", content: "hello" }, TUNNEL), "failed_precondition", "agent_disabled");
    await refusedWith(() => sessions.compact({ id: session.id }, TUNNEL), "failed_precondition", "agent_disabled");
    assert.equal(store.listMessages(session.id).messages.length, before);
    assert.equal(await f.count("spawn"), 1);
    // A running process keeps running until stopped.
    assert.ok(alive(spawned.pid));
    assert.equal(f.agent("fake").running, 1);

    // On again: offered again, and the conversation works.
    assert.equal((await device.update_agent({ id: "fake", enabled: true }, TUNNEL)).enabled, true);
    assert.deepEqual(device.status({}, TUNNEL).runtimes.map((r) => r.id), ["fake", "slow", "builtin"]);
    const reply: Reply = await sessions.send({ id: session.id, client_msg_id: "m2", content: "hello", wait: true }, TUNNEL);
    assert.equal(reply.reply_text, "echo: hello");
    // The prepared id is gone: create opens a session of its own.
    await sessions.create({ agent: "fake", cwd: f.dirs.b, prepared_id: prepared.prepared_id }, TUNNEL);
    assert.equal(await f.count("session/new"), 3);
    assert.equal(await f.count("spawn"), 1);
  });

  it("saves the settings on the device, applies them to agents started afterwards and after a restart", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions } = f.host;
    const first = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    const customArgs = [agentScript, path.join(path.dirname(f.dataDir), "agent.log"), "--custom"];

    const entry = await device.update_agent({ id: "fake", command: ` ${nodeAlias} `, args: customArgs, env: { AA_TEST_TOKEN: SECRET, EMPTY_OK: "" } }, TUNNEL);
    assert.deepEqual(entry, {
      id: "fake",
      name: "Fake",
      builtin: false,
      enabled: true,
      command: nodeAlias,
      args: customArgs,
      env_keys: ["AA_TEST_TOKEN", "EMPTY_OK"],
      customized: true,
      running: 1,
      busy: 0,
      idle_close_minutes: 0,
      sessions: 1,
      installed: true,
    });
    assert.deepEqual(device.status({}, TUNNEL).runtimes[0], { id: "fake", name: "Fake" }, "the name stays the preset's");

    // This agent cannot restore a session, so the conversation stays in the process it has, with the settings before.
    const sent: Reply = await sessions.send({ id: first.id, client_msg_id: "m1", content: "still old", wait: true }, TUNNEL);
    assert.equal(sent.reply_text, "echo: still old");
    assert.equal(await f.count("spawn"), 1);

    // Started afterwards: the new command, args and environment.
    const second = await sessions.create({ agent: "fake", cwd: f.dirs.b }, TUNNEL);
    const spawned = (await f.spawns())[1];
    assert.ok(spawned);
    if (!IS_WINDOWS) assert.equal(spawned.argv0, nodeAlias);
    assert.deepEqual(spawned.args, customArgs.slice(1));
    assert.equal(spawned.token, SECRET);

    // On disk, 0600 in a 0700 directory, values included (that is where they live).
    const file = path.join(f.dataDir, "agents.json");
    const saved = JSON.parse(await readFile(file, "utf8")) as { agents: Record<string, Record<string, unknown>> };
    assert.deepEqual(saved.agents.fake, { command: nodeAlias, args: customArgs, env: { AA_TEST_TOKEN: SECRET, EMPTY_OK: "" } });
    if (!IS_WINDOWS) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
    }

    // The Connector restarts: same settings, and the existing conversation's next message starts the new agent.
    await f.restart();
    assert.deepEqual(f.agent("fake"), { ...entry, running: 0, sessions: 0 });
    const resumed: Reply = await f.host.sessionsService.send({ id: second.id, client_msg_id: "m2", content: "after restart", wait: true }, TUNNEL);
    assert.equal(resumed.reply_text, "echo: after restart");
    const restarted = (await f.spawns())[2];
    assert.ok(restarted);
    if (!IS_WINDOWS) assert.equal(restarted.argv0, nodeAlias);
    assert.deepEqual(restarted.args, customArgs.slice(1));
    assert.equal(restarted.token, SECRET);
  });

  it("never lets an environment value out: answers, logs and pushes carry only the names", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions } = f.host;
    const answers: unknown[] = [];
    answers.push(await device.update_agent({ id: "fake", env: { AA_TEST_TOKEN: SECRET, OTHER: "x" } }, TUNNEL));
    const session = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    answers.push(session, await sessions.send({ id: session.id, client_msg_id: "m1", content: "hi", wait: true }, TUNNEL));
    answers.push(device.agents({}, TUNNEL), device.agents({}, CONTROL), device.status({}, TUNNEL), device.get_settings({}, TUNNEL));
    answers.push(await sessions.prepare({ agent: "fake", cwd: f.dirs.b }, TUNNEL), sessions.list({}, TUNNEL));
    answers.push(await device.stop_agent({ id: "fake" }, TUNNEL));
    // Removing one leaves the other.
    const removed = await device.update_agent({ id: "fake", env: { AA_TEST_TOKEN: null } }, TUNNEL);
    answers.push(removed);
    assert.deepEqual(removed.env_keys, ["OTHER"]);

    for (const answer of answers) assert.ok(!JSON.stringify(answer).includes(SECRET), JSON.stringify(answer));
    assert.deepEqual(Object.keys(removed).sort(), ["args", "builtin", "busy", "command", "customized", "enabled", "env_keys", "id", "idle_close_minutes", "installed", "name", "running", "sessions"]);
    assert.ok(f.logs.length > 0);
    assert.ok(f.logs.every((line) => !line.includes(SECRET)), f.logs.join("\n"));
    assert.ok(f.pushes.length > 0);
    assert.ok(f.pushes.every((event) => !JSON.stringify(event).includes(SECRET)));
    assert.equal((await f.spawns())[0]?.token, SECRET, "the agent itself got it");
  });

  it("reset goes back to the preset, then applies the other fields; the switch stays as it is", async () => {
    const f = await setup();
    const { deviceService: device } = f.host;
    await device.update_agent({ id: "fake", enabled: false, command: nodeAlias, args: ["--x"], env: { AA_TEST_TOKEN: SECRET } }, TUNNEL);

    const reset = await device.update_agent({ id: "fake", reset: true }, TUNNEL);
    assert.deepEqual(
      { name: reset.name, command: reset.command, args: reset.args, env_keys: reset.env_keys, customized: reset.customized, enabled: reset.enabled },
      { name: "Fake", command: process.execPath, args: f.presets.fake.args, env_keys: [], customized: false, enabled: false },
    );
    const saved = () => readFile(path.join(f.dataDir, "agents.json"), "utf8").then((text) => (JSON.parse(text) as { agents: Record<string, unknown> }).agents);
    assert.deepEqual((await saved()).fake, { enabled: false });

    const again = await device.update_agent({ id: "fake", reset: true, enabled: true, args: ["--again"] }, TUNNEL);
    assert.deepEqual([again.command, again.args, again.enabled, again.customized], [process.execPath, ["--again"], true, true]);

    // Set back to the preset's own values: not customized, and nothing kept for it.
    const plain = await device.update_agent({ id: "fake", command: process.execPath, args: f.presets.fake.args, env: {} }, TUNNEL);
    assert.equal(plain.customized, false);
    assert.deepEqual(await saved(), {});
  });

  it("keeps an idle close time per agent: never by default, saved in minutes, 0 is never again, reset leaves it", async () => {
    const f = await setup();
    const saved = () => readFile(path.join(f.dataDir, "agents.json"), "utf8").then((text) => (JSON.parse(text) as { agents: Record<string, unknown> }).agents);
    assert.equal(f.agent("fake").idle_close_minutes, 0, "never by default");

    const set = await f.host.deviceService.update_agent({ id: "fake", idle_close_minutes: 30 }, TUNNEL);
    assert.equal(set.idle_close_minutes, 30);
    assert.deepEqual((await saved()).fake, { idle_close_minutes: 30 });
    assert.ok(f.logs.includes("agent fake updated (idle_close_minutes)"), f.logs.join("\n"));
    const reset = await f.host.deviceService.update_agent({ id: "fake", reset: true }, TUNNEL);
    assert.equal(reset.idle_close_minutes, 30, "reset leaves it");
    await f.restart();
    assert.equal(f.agent("fake").idle_close_minutes, 30, "after a restart");

    const never = await f.host.deviceService.update_agent({ id: "fake", idle_close_minutes: 0 }, TUNNEL);
    assert.equal(never.idle_close_minutes, 0);
    assert.deepEqual(await saved(), {}, "never is not stored");
    for (const bad of [-1, 1.5, 7 * 24 * 60 + 1]) {
      assert.ok(!UpdateAgentRequestSchema.safeParse({ id: "fake", idle_close_minutes: bad }).success, String(bad));
    }
  });

  it("checks what it is given, and refuses agents this device does not have", async () => {
    const f = await setup();
    const { deviceService: device } = f.host;
    await refusedWith(() => device.update_agent({ id: "nope", enabled: false }, TUNNEL), "invalid_argument", "unknown_agent");
    await refusedWith(() => device.stop_agent({ id: "nope" }, TUNNEL), "invalid_argument", "unknown_agent");

    // On the wire MeshCall checks the request against the schema.
    const ok = UpdateAgentRequestSchema.safeParse({ id: "fake", command: " /bin/agent ", args: ["", "a b"], env: { _A1: "v", B: null } });
    assert.ok(ok.success);
    assert.equal(ok.data.command, "/bin/agent");
    const bad: Record<string, unknown>[] = [
      { env: { "1BAD": "v" } },
      { env: { "A-B": "v" } },
      { env: { "": "v" } },
      { env: { A: "nul\u0000byte" } },
      { env: { A: 1 } },
      { command: "" },
      { command: "  " },
      { args: [1] },
      { args: "--flag" },
      { enabled: "yes" },
    ];
    for (const fields of bad) assert.equal(UpdateAgentRequestSchema.safeParse({ id: "fake", ...fields }).success, false, JSON.stringify(fields));
    assert.equal(UpdateAgentRequestSchema.safeParse({ id: "" }).success, false);

    // A direct caller (no schema in between) gets the same checks.
    await refusedWith(() => f.host.updateAgent("fake", { env: { "BAD-NAME": "v" } }), "invalid_argument", "invalid_agent_settings");
    await refusedWith(() => f.host.updateAgent("fake", { command: "" }), "invalid_argument", "invalid_agent_settings");

    // Only agents the user added have a name to change (`custom-agents.test.ts`): the others keep theirs.
    const ignored = await device.update_agent({ id: "fake", name: "Renamed" }, TUNNEL);
    assert.deepEqual([ignored.name, ignored.customized], ["Fake", false]);
    const nul = await refusedWith(() => f.host.updateAgent("fake", { env: { TOKEN: `${SECRET}\u0000` } }), "invalid_argument", "invalid_agent_settings");
    assert.equal(nul.details?.field, "env.TOKEN");
    assert.ok(!nul.message.includes(SECRET), nul.message);
    assert.equal(f.agent("fake").customized, false, "nothing changed");
  });

  it("closes prepared agents whose command, args or environment changed, so the next prepare uses the new ones", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions } = f.host;
    const first = await sessions.prepare({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    const pid = (await f.spawns())[0]?.pid;
    assert.ok(pid);

    // Nothing that a process runs with changed (it is on already, nothing to reset): the prepared agent stays.
    await device.update_agent({ id: "fake", enabled: true, reset: true }, TUNNEL);
    assert.deepEqual(f.host.runtimes.listPrepared().map((p) => p.id), [first.prepared_id]);
    assert.equal((await sessions.prepare({ agent: "fake", cwd: f.dirs.a }, TUNNEL)).prepared_id, first.prepared_id);
    assert.ok(alive(pid));

    await device.update_agent({ id: "fake", env: { AA_TEST_TOKEN: "v2" } }, TUNNEL);
    await eventually(() => !alive(pid), "the prepared agent closed");
    assert.deepEqual(f.host.runtimes.listPrepared(), []);
    const second = await sessions.prepare({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    assert.notEqual(second.prepared_id, first.prepared_id);
    assert.equal((await f.spawns())[1]?.token, "v2");
    // The session takes over the new one (no third process).
    await sessions.create({ agent: "fake", cwd: f.dirs.a, prepared_id: second.prepared_id }, TUNNEL);
    assert.equal(await f.count("spawn"), 2);
  });
});

describe("Device/stop_agent", () => {
  it("stops the agent's process with its sessions, prepared ones included; conversations stay and start it again on their next message", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions, store } = f.host;
    const one = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    const two = await sessions.create({ agent: "fake", cwd: f.dirs.b }, TUNNEL);
    await sessions.prepare({ agent: "fake", cwd: f.dirs.b }, TUNNEL);
    const other = await sessions.create({ agent: "builtin", cwd: f.dirs.a }, TUNNEL);
    const [fake, builtin] = (await f.spawns()).map((s) => s.pid) as [number, number];
    assert.equal(f.agent("fake").running, 1);

    assert.deepEqual(await device.stop_agent({ id: "fake" }, TUNNEL), { stopped: 1 });
    await eventually(() => !alive(fake), "the agent stopped");
    assert.ok(alive(builtin), "other agents are left alone");
    assert.equal(f.agent("fake").running, 0);
    assert.deepEqual(f.host.runtimes.listPrepared(), []);
    assert.deepEqual(store.list().sessions.map((s) => s.id).sort(), [one.id, two.id, other.id].sort());
    assert.equal(f.host.runtimes.isLive(one.id), false);

    const reply: Reply = await sessions.send({ id: one.id, client_msg_id: "m1", content: "back", wait: true }, TUNNEL);
    assert.equal(reply.reply_text, "echo: back");
    assert.equal(await f.count("spawn"), 3, "started again");
    assert.equal(f.agent("fake").running, 1);
    // Again: what runs now; then nothing.
    assert.deepEqual(await device.stop_agent({ id: "fake" }, TUNNEL), { stopped: 1 });
    assert.deepEqual(await device.stop_agent({ id: "fake" }, TUNNEL), { stopped: 0 });
  });

  it("refuses while a turn runs; force cancels it as Sessions/stop does, then stops", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions, store } = f.host;
    const session = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    const pid = (await f.spawns())[0]?.pid as number;
    await sessions.send({ id: session.id, client_msg_id: "m1", content: "slow work" }, TUNNEL);
    await sessions.send({ id: session.id, client_msg_id: "m2", content: "next", delivery: "queue" }, TUNNEL);
    await eventually(async () => (await f.count("turn")) === 1, "the turn reached the agent");

    const refused = await refusedWith(() => device.stop_agent({ id: "fake" }, TUNNEL), "failed_precondition", "turns_running");
    assert.equal(refused.details?.count, 1);
    assert.ok(alive(pid));
    assert.ok(sessions.isBusy(session.id));

    assert.deepEqual(await device.stop_agent({ id: "fake", force: true }, TUNNEL), { stopped: 1 });
    assert.equal(await f.count("cancel"), 1, "the agent was asked to cancel first");
    await eventually(() => !alive(pid), "the agent stopped");
    assert.equal(sessions.isBusy(session.id), false);
    const control = store.getControl(session.id);
    assert.equal(control.state, "idle");
    assert.equal(control.error, undefined);
    // Like Sessions/stop: the queued message waits for the next send instead of starting the agent again.
    assert.deepEqual(control.queued.map((q) => q.client_msg_id), ["m2"]);
    await sleep(100);
    assert.equal(await f.count("spawn"), 1);
    assert.ok(f.pushes.every((event) => event.event_type !== "error"), JSON.stringify(f.pushes));
  });

  it("a forced stop cancels a turn whose agent is still starting, instead of failing it", async () => {
    const f = await setup();
    const { deviceService: device, sessionsService: sessions, store } = f.host;
    // `slow` answers initialize after 4 s: create it while it is on its way up, as a turn's agent.
    const session = store.create({ agent: "slow", title: "", cwd: f.dirs.a });
    await sessions.send({ id: session.id, client_msg_id: "m1", content: "hi" }, TUNNEL);
    await eventually(async () => (await f.count("spawn")) === 1 && f.agent("slow").running === 1, "the agent was spawned");
    assert.equal(f.agent("slow").busy, 1);

    await refusedWith(() => device.stop_agent({ id: "slow" }, TUNNEL), "failed_precondition", "turns_running");
    const started = Date.now();
    assert.deepEqual(await device.stop_agent({ id: "slow", force: true }, TUNNEL), { stopped: 1 });
    assert.ok(Date.now() - started < 3_000, "no grace period for an agent that cannot cancel yet");
    assert.equal(sessions.isBusy(session.id), false);
    const control = store.getControl(session.id);
    assert.equal(control.state, "idle");
    assert.equal(control.error, undefined);
    assert.equal(f.agent("slow").running, 0);
  });

  it("a turn whose agent ignores the cancel ends cancelled, not failed, once the agent is stopped", async () => {
    const f = await setup();
    const { sessionsService: sessions, store } = f.host;
    const session = await sessions.create({ agent: "fake", cwd: f.dirs.a }, TUNNEL);
    await sessions.send({ id: session.id, client_msg_id: "m1", content: "slow stubborn" }, TUNNEL);
    await eventually(async () => (await f.count("turn")) === 1, "the turn reached the agent");

    assert.equal(await f.host.runtimes.stopAgent("fake"), 1);
    await eventually(() => !sessions.isBusy(session.id), "the turn ended");
    const control = store.getControl(session.id);
    assert.equal(control.state, "idle");
    assert.equal(control.error, undefined);
    assert.ok(f.pushes.every((event) => event.event_type !== "error"), JSON.stringify(f.pushes));
  });
});

describe("who may manage agents", () => {
  it("normal device: changing and stopping agents only from a client over a tunnel, never the control plane or MCP", async () => {
    const f = await setup();
    const { deviceService: device } = f.host;
    const change = (ctx: RpcContext) => () => device.update_agent({ id: "fake", command: "/tmp/evil" }, ctx);
    const stop = (ctx: RpcContext) => () => device.stop_agent({ id: "fake", force: true }, ctx);

    for (const run of [change(CONTROL), stop(CONTROL)]) {
      const error = await refusedWith(run, "permission_denied", "tunnel_required");
      assert.ok(error instanceof PermissionDeniedError);
    }
    // MCP off: the gate refuses it; on: still not for this.
    await refusedWith(change(MCP), "permission_denied", "mcp_disabled_on_device");
    f.host.gate.allowMcp = true;
    await refusedWith(change(MCP), "permission_denied", "mcp_not_allowed");
    await refusedWith(stop(MCP), "permission_denied", "mcp_not_allowed");
    // A tunnel claiming to be MCP is held to the MCP rule.
    const mcpTunnel = context({ tunnel: { id: "tun_2", principal: "user:1/mcp" }, metadata: { "aa-via": "mcp" } });
    await refusedWith(change(mcpTunnel), "permission_denied", "mcp_not_allowed");
    assert.equal(f.agent("fake").command, process.execPath, "nothing changed");

    // A client over a tunnel may.
    assert.deepEqual((await device.update_agent({ id: "fake", env: { FROM_WEB: "1" } }, TUNNEL)).env_keys, ["FROM_WEB"]);
    assert.deepEqual(await device.stop_agent({ id: "fake" }, TUNNEL), { stopped: 0 });
  });

  it("encrypted device: only paired end-to-end clients, for listing too", async () => {
    const f = await setup();
    const { deviceService: device, gate } = f.host;
    gate.mode = "encrypted";
    const peerKey = (await generateE2EKey()).publicKey;
    const { payload } = await gate.createPairing();
    assert.equal(await gate.authorizePeer({ peerKey, pairingId: payload.pairing_id }), true);
    const paired = context({ tunnel: { id: "tun_e2e", principal: "user:1/client:ios", sealed: true }, e2e: { peerKey } });
    const stranger = context({ tunnel: { id: "tun_x", principal: "user:1/client:x", sealed: true }, e2e: { peerKey: (await generateE2EKey()).publicKey } });

    for (const [ctx, reason] of [
      [TUNNEL, "e2e_peer_required"],
      [CONTROL, "e2e_peer_required"],
      [MCP, "e2e_peer_required"],
      [stranger, "e2e_not_paired"],
    ] as const) {
      await refusedWith(() => device.agents({}, ctx), "permission_denied", reason);
      await refusedWith(() => device.update_agent({ id: "fake", enabled: false }, ctx), "permission_denied", reason);
      await refusedWith(() => device.stop_agent({ id: "fake" }, ctx), "permission_denied", reason);
    }
    assert.equal(device.agents({}, paired).agents.length, 3);
    assert.equal((await device.update_agent({ id: "fake", enabled: false }, paired)).enabled, false);
    assert.deepEqual(await device.stop_agent({ id: "fake" }, paired), { stopped: 0 });
  });
});

describe("agents.json", () => {
  it("is tightened to 0600 on load, and a damaged entry is an error naming the field, never its value", async () => {
    const dataDir = await mkdtemp(path.join(root, "state-"));
    const store = new StateStore({ dataDir });
    assert.deepEqual(await store.loadAgentSettings(), {});
    const file = store.pathFor("agents.json");
    await writeFile(file, JSON.stringify({ agents: { fake: { enabled: false, env: { TOKEN: SECRET } } } }), { mode: 0o644 });
    assert.deepEqual(await store.loadAgentSettings(), { fake: { enabled: false, env: { TOKEN: SECRET } } });
    if (!IS_WINDOWS) assert.equal((await stat(file)).mode & 0o777, 0o600);

    await writeFile(file, JSON.stringify({ agents: { fake: { enabled: "no", env: { TOKEN: SECRET } } } }));
    await assert.rejects(store.loadAgentSettings(), (error: unknown) => {
      assert.ok(error instanceof StateStoreError);
      assert.equal(error.code, "state_file_invalid");
      assert.match(error.message, /agents\.fake\.enabled/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    await writeFile(file, JSON.stringify({ agents: { fake: { env: { "NOT-A-NAME": SECRET } } } }));
    await assert.rejects(store.loadAgentSettings(), (error: unknown) => error instanceof StateStoreError && !error.message.includes(SECRET));
  });

  it("written when agents could be renamed still loads: the name is ignored and the Connector starts", async () => {
    // A `name` per agent, as the first version of this API saved it; one entry holds nothing else (and a name that
    // would not pass any check).
    const legacy = { agents: { fake: { name: "My Fake", enabled: false, command: nodeAlias }, builtin: { name: "" } } };
    const store = new StateStore({ dataDir: await mkdtemp(path.join(root, "state-")) });
    await writeFile(store.pathFor("agents.json"), JSON.stringify(legacy));
    assert.deepEqual(await store.loadAgentSettings(), { fake: { enabled: false, command: nodeAlias }, builtin: {} });

    const f = await setup({ agentsJson: legacy });
    const fake = f.agent("fake");
    assert.deepEqual([fake.name, fake.enabled, fake.command, fake.customized], ["Fake", false, nodeAlias, true]);
    const builtin = f.agent("builtin");
    assert.deepEqual([builtin.name, builtin.customized], ["Built-in", false]);
    assert.deepEqual(f.host.deviceService.status({}, TUNNEL).runtimes, [
      { id: "slow", name: "Slow" },
      { id: "builtin", name: "Built-in" },
    ]);

    // The next save leaves the old keys (and the entry with nothing else) behind.
    await f.host.deviceService.update_agent({ id: "fake", enabled: true }, TUNNEL);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, "agents.json"), "utf8")), { agents: { fake: { command: nodeAlias } } });
  });
});
