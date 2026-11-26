// `aa.v3.Sessions/prepare` and `create({ prepared_id })`: a session opened before its conversation, against a small
// stdio ACP agent that logs every process start, `session/new`, `session/close` and setting change. The service is
// called directly (the Router end-to-end test covers the wire).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import { DeviceGate } from "../src/core/gate.js";
import { SessionStore } from "../src/core/session-store.js";
import { TunnelStreamTracker } from "../src/rpc/device-admin-service.js";
import { SessionsService } from "../src/rpc/sessions-service.js";
import type { LastSessionConfig } from "../src/core/config.js";
import { AcpRuntimeHost, type AcpRuntimeHostOptions } from "../src/runtime/acp-host.js";
import { StateStore } from "../src/runtime/state-store.js";

// argv: <log file> [--auth] [--slow-init=<ms>]
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f === name || f.startsWith(name + "="));
const note = (line) => fs.appendFileSync(log, line + "\n");
note("spawn " + process.pid);
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const sessions = new Map();
const config = (s) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model,
    options: [{ group: "fake", name: "Fake models", options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart", description: "Slower" }] }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode,
    options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto" }] },
];
async function handle(msg) {
  if (msg.method === undefined) return;
  const { id, method, params } = msg;
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": {
      const slow = flag("--slow-init");
      if (slow) await new Promise((r) => setTimeout(r, Number(slow.split("=")[1])));
      return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [{ id: "login", name: "Log in", description: "Run fake-agent login" }] });
    }
    case "session/new": {
      note("session/new " + process.pid + " " + params.cwd);
      if (flag("--auth")) return fail(-32000, "Authentication required");
      const sessionId = "acp-" + process.pid + "-" + (sessions.size + 1);
      const s = { model: "fast", mode: "ask" };
      sessions.set(sessionId, s);
      // The slash commands in the same write as the answer, as agents do; a mode change a moment later.
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId, configOptions: config(s) } }) + "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the context" }] } } }) + "\n");
      setTimeout(() => { s.mode = "auto"; update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "auto" }); }, 30);
      return;
    }
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      s[params.configId] = params.value;
      note("set " + params.configId + "=" + params.value);
      return reply({ configOptions: config(s) });
    }
    case "session/prompt": {
      const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " + text } });
      return reply({ stopReason: "end_turn" });
    }
    case "session/close":
      sessions.delete(params.sessionId);
      note("closed " + params.sessionId);
      return reply({});
    case "session/cancel":
      return;
    default:
      if (id !== undefined) fail(-32601, "no " + method);
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

/** `send({ wait: true })`'s answer. */
type Reply = { delivered: string; reply_text?: string; turn_result?: string };

/** What the service expects from a MeshCall call: a normal-mode call from the control plane. */
const ctx = { metadata: {}, tunnel: null, e2e: null, idempotencyKey: undefined, remainingMs: () => null } as unknown as RpcContext;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 5_000): Promise<T> {
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

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

let root: string;
let agentScript: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-v3-prepare-"));
  agentScript = path.join(root, "fake-acp-agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Fixture {
  host: AcpRuntimeHost;
  service: SessionsService;
  store: SessionStore;
  /** Project folders a, b, c. */
  dirs: { a: string; b: string; c: string };
  /** The agent log, as lines. */
  log(): Promise<string[]>;
  count(prefix: string): Promise<number>;
  /** Pid of the n-th process start (0-based). */
  pid(n: number): Promise<number>;
}

/** Hosts of the running test: stopped after it, so no agent outlives its test. */
const fixtures: AcpRuntimeHost[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((host) => host.dispose()));
});

async function setup(options: { flags?: string[]; host?: Partial<AcpRuntimeHostOptions> } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(root, "case-"));
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const dirs = { a: path.join(dir, "a"), b: path.join(dir, "b"), c: path.join(dir, "c") };
  for (const project of Object.values(dirs)) await mkdir(project);
  const store = new SessionStore({ device: { id: "dev_test", name: "Test" } });
  const preset = (id: string, flags: string[]) => ({ id, name: `Agent ${id}`, command: process.execPath, args: [agentScript, logFile, ...flags] });
  const host = new AcpRuntimeHost({
    store,
    includeDefaultPresets: false,
    presets: [preset("fake", options.flags ?? []), preset("other", []), preset("auth", ["--auth"]), { id: "missing", name: "Missing", command: path.join(dir, "no-such-agent"), args: [] }],
    killGraceMs: 500,
    ...options.host,
  });
  fixtures.push(host);
  const gate = await DeviceGate.create({ instanceId: "dev_test" });
  const service = new SessionsService({ gate, store, runtimes: host, streams: new TunnelStreamTracker(), waitTimeoutMs: 5_000 });
  const log = async () => (await readFile(logFile, "utf8")).split("\n").filter((line) => line.length > 0);
  return {
    host,
    service,
    store,
    dirs,
    log,
    count: async (prefix) => (await log()).filter((line) => line.startsWith(`${prefix} `)).length,
    pid: async (n) => {
      const line = await eventually(async () => (await log()).filter((l) => l.startsWith("spawn "))[n], `process start #${n}`);
      return Number(line.split(" ")[1]);
    },
  };
}

describe("Sessions/prepare", () => {
  it("starts the agent before the conversation and reports its settings in the shape of Session.config", async () => {
    const f = await setup();
    const prepared = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    assert.equal(prepared.agent, "fake");
    assert.equal(prepared.cwd, f.dirs.a);
    assert.ok(prepared.prepared_id.length > 0);
    assert.deepEqual(prepared.config.map((o) => o.id), ["model", "mode"]);
    assert.deepEqual(prepared.config[0], {
      id: "model",
      name: "Model",
      category: "model",
      current: "fast",
      options: [
        { value: "fast", name: "Fast", group: "Fake models" },
        { value: "smart", name: "Smart", description: "Slower", group: "Fake models" },
      ],
    });
    const expires = Date.parse(prepared.expires_at);
    assert.ok(expires > Date.now() + 9 * 60_000 && expires <= Date.now() + 10 * 60_000, prepared.expires_at);
    assert.equal(await f.count("spawn"), 1);
    assert.equal(await f.count("session/new"), 1);

    // Asking again: the same agent (no new process), a later expiry, and the mode change it reported meanwhile.
    const again = await eventually(async () => {
      const next = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
      return next.config.find((o) => o.id === "mode")?.current === "auto" ? next : undefined;
    }, "the mode change");
    assert.equal(again.prepared_id, prepared.prepared_id);
    assert.ok(Date.parse(again.expires_at) > expires);
    assert.equal(await f.count("spawn"), 1);
    assert.deepEqual(f.host.listPrepared().map((p) => p.id), [prepared.prepared_id]);
  });

  it("shares one start between concurrent calls for the same agent and folder", async () => {
    const f = await setup({ flags: ["--slow-init=300"] });
    const [one, two] = await Promise.all([
      f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx),
      f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx),
    ]);
    assert.equal(one.prepared_id, two.prepared_id);
    assert.equal(await f.count("spawn"), 1);
    // Another folder is another session, in the same process.
    const other = await f.service.prepare({ agent: "fake", cwd: f.dirs.b }, ctx);
    assert.notEqual(other.prepared_id, one.prepared_id);
    assert.equal(await f.count("session/new"), 2);
    assert.equal(await f.count("spawn"), 1);
  });

  it("shares one process between conversations and folders that start at the same time", async () => {
    const f = await setup({ flags: ["--slow-init=200"] });
    const [prepared, first, second] = await Promise.all([
      f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx),
      f.service.create({ agent: "fake", cwd: f.dirs.b }, ctx),
      f.service.create({ agent: "fake", cwd: f.dirs.c }, ctx),
    ]);
    assert.equal(await f.count("spawn"), 1);
    const pid = await f.pid(0);
    assert.deepEqual(new Set((await f.log()).filter((line) => line.startsWith("session/new "))), new Set([f.dirs.a, f.dirs.b, f.dirs.c].map((dir) => `session/new ${pid} ${dir}`)));
    assert.equal(prepared.cwd, f.dirs.a);
    assert.ok(f.host.isLive(first.id) && f.host.isLive(second.id));
    assert.deepEqual([f.host.agent("fake").running, f.host.agent("fake").sessions], [1, 3]);
  });

  it("checks the agent and folder like create", async () => {
    const f = await setup();
    const unknown = await rejection(f.service.prepare({ agent: "nope", cwd: f.dirs.a }, ctx));
    assert.ok(unknown instanceof MeshCallError);
    assert.equal(unknown.code, "invalid_argument");
    assert.equal(unknown.reason, "unknown_agent");
    const file = path.join(f.dirs.a, "file.txt");
    await writeFile(file, "x");
    const notDir = await rejection(f.service.prepare({ agent: "fake", cwd: file }, ctx));
    assert.ok(notDir instanceof MeshCallError);
    assert.equal(notDir.reason, "invalid_cwd");
    assert.equal(await f.count("spawn"), 0);
  });

  it("reports start failures as clear RPC errors: sign-in required, program missing", async () => {
    const f = await setup();
    const auth = await rejection(f.service.prepare({ agent: "auth", cwd: f.dirs.a }, ctx));
    assert.ok(auth instanceof MeshCallError, String(auth));
    assert.equal(auth.code, "failed_precondition");
    assert.equal(auth.reason, "agent_auth_required");
    assert.equal(auth.message, "could not start Agent auth: Authentication required");
    assert.deepEqual(auth.details?.auth_methods, [{ id: "login", name: "Log in", description: "Run fake-agent login", kind: "agent" }]);
    // Nothing is kept: the next call tries again (after the user signed in, say).
    await rejection(f.service.prepare({ agent: "auth", cwd: f.dirs.a }, ctx));
    assert.equal(await f.count("spawn"), 2);
    assert.deepEqual(f.host.listPrepared(), []);
    // The failed processes are gone.
    for (const n of [0, 1]) {
      const pid = await f.pid(n);
      await eventually(() => !alive(pid) || undefined, `failed agent ${pid} exited`);
    }

    const missing = await rejection(f.service.prepare({ agent: "missing", cwd: f.dirs.a }, ctx));
    assert.ok(missing instanceof MeshCallError, String(missing));
    assert.equal(missing.code, "unavailable");
    assert.equal(missing.reason, "agent_start_failed");
    assert.match(missing.message, /^could not start .*no-such-agent.*ENOENT/);

    // create fails the same way, and leaves no session behind.
    const created = await rejection(f.service.create({ agent: "auth", cwd: f.dirs.a }, ctx));
    assert.ok(created instanceof MeshCallError);
    assert.equal(created.reason, "agent_auth_required");
    assert.deepEqual(f.store.list().sessions, []);
  });
});

describe("Sessions/create with prepared_id", () => {
  it("takes the prepared agent over: no second session/new, replayed updates, settings applied, first turn works", async () => {
    const f = await setup();
    const prepared = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    const pid = await f.pid(0);
    // Let the agent report its mode change while it waits.
    await eventually(async () => (await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx)).config.find((o) => o.id === "mode")?.current === "auto" || undefined, "mode change");

    const session = await f.service.create({ agent: "fake", cwd: f.dirs.a, prepared_id: prepared.prepared_id, config: { model: "smart" } }, ctx);
    assert.equal(session.cwd, f.dirs.a);
    assert.deepEqual(
      session.config.map((o) => [o.id, o.current]),
      [["model", "smart"], ["mode", "auto"]],
    );
    assert.equal(await f.count("spawn"), 1, "no second process");
    assert.equal(await f.count("session/new"), 1, "no second session/new");
    assert.ok((await f.log()).includes("set model=smart"));
    assert.ok(f.host.isLive(session.id));
    // Sent before the session existed (in the same write as the session/new answer), replayed into it.
    assert.deepEqual(f.host.availableCommands(session.id).map((c) => c.name), ["compact"]);
    assert.deepEqual(f.host.listPrepared(), [], "taken out of the pool");

    const sent: Reply = await f.service.send({ id: session.id, client_msg_id: "m1", content: "hello", wait: true }, ctx);
    assert.equal(sent.delivered, "started");
    assert.equal(sent.turn_result, "end_turn");
    assert.equal(sent.reply_text, "echo: hello");
    assert.equal(f.store.getControl(session.id).state, "idle");

    // It is the conversation's now: a new one is prepared, and deleting the conversation closes only its own session.
    const acpSession = f.store.acpSessionId(session.id);
    const next = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    assert.notEqual(next.prepared_id, prepared.prepared_id);
    assert.equal(await f.count("spawn"), 1);
    assert.equal(await f.count("closed"), 0);
    await f.service.delete({ id: session.id }, ctx);
    assert.deepEqual((await f.log()).filter((line) => line.startsWith("closed ")), [`closed ${acpSession}`]);
    assert.ok(alive(pid), "the process serves the others");
    assert.deepEqual(f.host.listPrepared().map((p) => p.id), [next.prepared_id]);
  });

  it("starts the agent as usual when prepared_id is unknown, for another agent or folder, exited or expired", async () => {
    const f = await setup();
    const newSessions = () => f.count("session/new");

    // Unknown id.
    const unknown = await f.service.create({ agent: "fake", cwd: f.dirs.a, prepared_id: "no-such-id" }, ctx);
    assert.equal(unknown.config[0]?.current, "fast");
    assert.equal(await newSessions(), 1);

    // Another folder, then another agent: both start their own; the prepared one stays for its own folder.
    const prepared = await f.service.prepare({ agent: "fake", cwd: f.dirs.b }, ctx);
    assert.equal(await newSessions(), 2);
    await f.service.create({ agent: "fake", cwd: f.dirs.c, prepared_id: prepared.prepared_id }, ctx);
    assert.equal(await newSessions(), 3);
    await f.service.create({ agent: "other", cwd: f.dirs.b, prepared_id: prepared.prepared_id }, ctx);
    assert.equal(await newSessions(), 4);
    assert.deepEqual(f.host.listPrepared().map((p) => p.id), [prepared.prepared_id]);
    const taken = await f.service.create({ agent: "fake", cwd: f.dirs.b, prepared_id: prepared.prepared_id }, ctx);
    assert.equal(await newSessions(), 4, "the matching create took it over");
    assert.ok(f.host.isLive(taken.id));

    // Exited on its own (crashed): dropped from the pool, create starts a new one.
    const crashed = await f.service.prepare({ agent: "fake", cwd: f.dirs.c }, ctx);
    assert.equal(await newSessions(), 5);
    process.kill(await f.pid(0), "SIGKILL");
    await eventually(() => f.host.listPrepared().length === 0 || undefined, "crashed agent dropped");
    const afterCrash = await f.service.create({ agent: "fake", cwd: f.dirs.c, prepared_id: crashed.prepared_id }, ctx);
    assert.equal(await newSessions(), 6);
    const turn: Reply = await f.service.send({ id: afterCrash.id, client_msg_id: "m1", content: "still fine", wait: true }, ctx);
    assert.equal(turn.reply_text, "echo: still fine");

    // Expired: closed after its TTL, so create starts a new one.
    const g = await setup({ host: { preparedTtlMs: 300 } });
    const expiring = await g.service.prepare({ agent: "fake", cwd: g.dirs.a }, ctx);
    await eventually(async () => (await g.count("closed")) === 1 || undefined, "closed after its TTL");
    assert.deepEqual(g.host.listPrepared(), []);
    const afterTtl = await g.service.create({ agent: "fake", cwd: g.dirs.a, prepared_id: expiring.prepared_id }, ctx);
    assert.equal(await g.count("session/new"), 2);
    assert.ok(g.host.isLive(afterTtl.id));
  });
});

describe("the settings of the newest conversation", () => {
  const model = (config: { id: string; current: string }[]) => config.find((o) => o.id === "model")?.current;

  it("start the next conversation with that agent, and show on an agent prepared for it; other agents keep their own", async () => {
    const saved: LastSessionConfig[] = [];
    const f = await setup({ host: { onLastSessionConfigChange: (config) => void saved.push(config) } });
    const first = await f.service.create({ agent: "fake", cwd: f.dirs.a, config: { model: "smart" } }, ctx);
    assert.equal(model(first.config), "smart");
    assert.equal(saved.at(-1)?.fake?.model, "smart", "saved on the device");
    assert.equal(f.host.lastSessionConfig("fake").model, "smart");

    // Created without settings (an MCP client, say): the newest conversation's.
    const second = await f.service.create({ agent: "fake", cwd: f.dirs.b }, ctx);
    assert.equal(model(second.config), "smart");
    // Prepared for a new conversation: shown with them before it exists, and the conversation keeps them.
    const prepared = await f.service.prepare({ agent: "fake", cwd: f.dirs.c }, ctx);
    assert.equal(model(prepared.config), "smart");
    const third = await f.service.create({ agent: "fake", cwd: f.dirs.c, prepared_id: prepared.prepared_id }, ctx);
    assert.equal(model(third.config), "smart");
    assert.equal(await f.count("session/new"), 3, "the prepared agent was taken over");

    // Picked for this one: on top, and the newest from now on.
    const fourth = await f.service.create({ agent: "fake", cwd: f.dirs.a, config: { model: "fast" } }, ctx);
    assert.equal(model(fourth.config), "fast");
    assert.equal(f.host.lastSessionConfig("fake").model, "fast");

    const other = await f.service.create({ agent: "other", cwd: f.dirs.a }, ctx);
    assert.equal(model(other.config), "fast", "the agent's own default");
    assert.equal(saved.at(-1)?.fake?.model, "fast");
  });

  it("skip values the agent no longer offers", async () => {
    const f = await setup({ host: { lastSessionConfig: { fake: { model: "retired" } } } });
    const session = await f.service.create({ agent: "fake", cwd: f.dirs.a }, ctx);
    assert.equal(model(session.config), "fast");
    assert.equal(await f.count("set"), 0, "nothing sent to the agent");
  });

  it("are kept in last-session-config.json", async () => {
    const store = new StateStore({ dataDir: await mkdtemp(path.join(root, "state-")) });
    assert.deepEqual(await store.loadLastSessionConfig(), {});
    await store.saveLastSessionConfig({ fake: { model: "smart", mode: "auto" } });
    assert.deepEqual(await store.loadLastSessionConfig(), { fake: { model: "smart", mode: "auto" } });
    await writeFile(store.pathFor("last-session-config.json"), JSON.stringify({ agents: { fake: { model: 1 } } }));
    await assert.rejects(store.loadLastSessionConfig(), /agents\.fake\.model/);
  });
});

describe("prepared agent lifecycle", () => {
  it("closes an unused session after its TTL; asking again restarts the TTL; the process stays", async () => {
    const f = await setup({ host: { preparedTtlMs: 1_500 } });
    const first = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    await sleep(700);
    const again = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    assert.equal(again.prepared_id, first.prepared_id);
    await sleep(1_100); // past the first expiry (1.5 s), before the second (2.2 s)
    assert.equal(await f.count("closed"), 0, "the second prepare kept it");
    assert.equal(f.host.listPrepared().length, 1);
    await eventually(async () => (await f.count("closed")) === 1 || undefined, "the session closed after its TTL", 5_000);
    assert.deepEqual(f.host.listPrepared(), []);
    assert.ok(alive(await f.pid(0)), "never closed by default");
    assert.deepEqual([f.host.agent("fake").running, f.host.agent("fake").sessions], [1, 0]);
  });

  it("keeps at most maxPrepared and closes the least recently used one first", async () => {
    const f = await setup({ host: { maxPrepared: 2 } });
    const a = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    const b = await f.service.prepare({ agent: "fake", cwd: f.dirs.b }, ctx);
    // Using a again makes b the least recently used.
    assert.equal((await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx)).prepared_id, a.prepared_id);
    const c = await f.service.prepare({ agent: "fake", cwd: f.dirs.c }, ctx);
    const closed = await eventually(async () => (await f.log()).find((line) => line.startsWith("closed ")), "b closed");
    assert.equal(closed, `closed acp-${await f.pid(0)}-2`);
    assert.deepEqual(new Set(f.host.listPrepared().map((p) => p.id)), new Set([a.prepared_id, c.prepared_id]));
    assert.equal(await f.count("session/new"), 3);
    // b's id is gone: create opens a new session.
    await f.service.create({ agent: "fake", cwd: f.dirs.b, prepared_id: b.prepared_id }, ctx);
    assert.equal(await f.count("session/new"), 4);
    assert.equal(await f.count("spawn"), 1);
  });

  it("closes prepared agents, and fails starts still under way, when the Connector stops", async () => {
    const f = await setup();
    await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    const pid = await f.pid(0);
    const slow = await setup({ flags: ["--slow-init=2000"] });
    const starting = rejection(slow.service.prepare({ agent: "fake", cwd: slow.dirs.a }, ctx));
    const slowPid = await slow.pid(0);

    await Promise.all([f.host.dispose(), slow.host.dispose()]);
    await eventually(() => !alive(pid) || undefined, "prepared agent closed");
    assert.deepEqual(f.host.listPrepared(), []);
    const error = await starting;
    assert.ok(error instanceof MeshCallError, String(error));
    assert.equal(error.reason, "agent_start_failed");
    await eventually(() => !alive(slowPid) || undefined, "starting agent closed");

    // The host keeps working after a stop (the Connector can start again).
    const again = await f.service.prepare({ agent: "fake", cwd: f.dirs.a }, ctx);
    assert.equal(again.config[0]?.current, "fast");
  });
});
