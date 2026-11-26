// One agent process for all of an agent's conversations (`runtime/agent-process.ts`, `AcpRuntime`), on a real
// `ConnectorHost` (initialized, not serving; the services are called directly) with a small stdio ACP agent that can
// be told what it supports and logs every start, session and prompt.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import type { AcpRuntimePreset } from "../src/core/config.js";
import { ConnectorHost, type ConnectorHostOptions } from "../src/host/connector-host.js";

// argv: <log file> [--caps=resume,load,close] [--needs-auth] [--silent-close]
//   --caps          what initialize advertises
//   --needs-auth    session/new answers AUTH_REQUIRED while the file `<log>.signed-out` exists
//   --silent-close  session/close is never answered, nor is the prompt that ran
// Prompts: "ask …" asks for a permission first; "slow <ms>" takes that long, or until cancelled; "where" answers with
// the folder of its session; "crash" exits.
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, ...flags] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(log, line + "\n");
note("spawn " + process.pid + " " + (process.env.AA_TEST_TOKEN || "-") + " " + process.cwd());
const caps = (flags.find((f) => f.startsWith("--caps=")) || "--caps=").slice("--caps=".length).split(",");
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = new Map();
const waiting = new Map();
let created = 0;
const ask = (sessionId, title) => new Promise((resolve) => {
  const id = "ask-" + (waiting.size + 1);
  waiting.set(id, resolve);
  out({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
    sessionId, toolCall: { toolCallId: "call-" + sessionId, title, kind: "execute", status: "pending" },
    options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }],
  } });
});
async function handle(msg) {
  if (msg.method === undefined) {
    const answer = waiting.get(msg.id);
    if (answer) answer(msg.result);
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
  const open = (sessionId) => sessions.set(sessionId, { cwd: params.cwd, cancelled: false, turns: 0 });
  switch (method) {
    case "initialize": {
      const sessionCapabilities = {};
      if (caps.includes("resume")) sessionCapabilities.resume = {};
      if (caps.includes("close")) sessionCapabilities.close = {};
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: caps.includes("load"), sessionCapabilities }, authMethods: [{ id: "login", name: "Sign in" }] });
    }
    case "session/new": {
      if (flags.includes("--needs-auth") && fs.existsSync(log + ".signed-out")) return fail(-32000, "Authentication required");
      const sessionId = "acp-" + process.pid + "-" + ++created;
      open(sessionId);
      note("new " + sessionId + " " + params.cwd);
      return reply({ sessionId });
    }
    case "session/resume":
    case "session/load":
      open(params.sessionId);
      note(method.slice("session/".length) + " " + params.sessionId + " " + process.pid);
      return reply({});
    case "session/close": {
      note("close " + params.sessionId);
      if (flags.includes("--silent-close")) return;
      const s = sessions.get(params.sessionId);
      if (s) s.cancelled = true;
      sessions.delete(params.sessionId);
      return reply({});
    }
    case "session/cancel": {
      note("cancel " + params.sessionId);
      const s = sessions.get(params.sessionId);
      if (s) s.cancelled = true;
      return;
    }
    case "session/prompt": {
      const s = sessions.get(params.sessionId);
      if (s === undefined) return fail(-32602, "no session " + params.sessionId);
      s.cancelled = false;
      const text = params.prompt.map((b) => b.text || "").join("");
      note("prompt " + params.sessionId + " " + text);
      if (text === "crash") process.exit(3);
      if (text === "where") { say(params.sessionId, s.cwd); return reply({ stopReason: "end_turn" }); }
      if (text.startsWith("ask ")) {
        const answer = await ask(params.sessionId, text.slice(4));
        say(params.sessionId, "answered " + (answer.outcome.optionId || answer.outcome.outcome));
        return reply({ stopReason: s.cancelled ? "cancelled" : "end_turn" });
      }
      if (text.startsWith("slow ")) {
        const until = Date.now() + Number(text.split(" ")[1]);
        while (Date.now() < until && !s.cancelled) { say(params.sessionId, "."); await sleep(20); }
        if (s.cancelled) return reply({ stopReason: "cancelled" });
      }
      say(params.sessionId, "echo: " + text + " #" + ++s.turns);
      return reply({ stopReason: "end_turn" });
    }
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
process.stdin.on("end", () => { note("exit " + process.pid); process.exit(0); });
`;

/** A client through a plain tunnel (normal device), as MeshCall hands it to the services. */
const TUNNEL = {
  metadata: {},
  tunnel: { id: "tun_1", principal: "user:1/client:web" },
  e2e: null,
  idempotencyKey: undefined,
  remainingMs: () => null,
  signal: new AbortController().signal,
} as unknown as RpcContext;

type Reply = { delivered: string; reply_text?: string; turn_result?: string };

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

let root: string;
let agentScript: string;
const hosts: ConnectorHost[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-v3-shared-"));
  agentScript = path.join(root, "fake-acp-agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop().catch(() => undefined)));
});

async function setup(options: { caps?: string; flags?: string[]; preset?: Partial<AcpRuntimePreset>; host?: Partial<ConnectorHostOptions> } = {}) {
  const dir = await mkdtemp(path.join(root, "case-"));
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const dirs = { a: path.join(dir, "a"), b: path.join(dir, "b"), c: path.join(dir, "c") };
  for (const project of Object.values(dirs)) await mkdir(project);
  const preset: AcpRuntimePreset = {
    id: "fake",
    name: "Fake",
    command: process.execPath,
    args: [agentScript, logFile, `--caps=${options.caps ?? "resume,close"}`, ...(options.flags ?? [])],
    ...options.preset,
  };
  const logs: string[] = [];
  const host = new ConnectorHost({
    dataDir: path.join(dir, "state"),
    deviceId: "dev_shared",
    presets: [preset],
    defaultPresets: [],
    waitTimeoutMs: 5_000,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...options.host,
  });
  hosts.push(host);
  await host.init();
  const log = async () => (await readFile(logFile, "utf8")).split("\n").filter((line) => line.length > 0);
  const lines = async (prefix: string) => (await log()).filter((line) => line.startsWith(`${prefix} `)).map((line) => line.slice(prefix.length + 1));
  return {
    host,
    store: host.store,
    sessions: host.sessionsService,
    dirs,
    logs,
    logFile,
    log,
    lines,
    /** Pid of the n-th process start (0-based). */
    pid: async (n: number) => Number((await eventually(async () => (await lines("spawn"))[n], `process start #${n}`)).split(" ")[0]),
    create: (cwd: string) => host.sessionsService.create({ agent: "fake", cwd }, TUNNEL),
    send: (id: string, content: string): Promise<Reply> => host.sessionsService.send({ id, client_msg_id: `${content}-${Math.random()}`, content, wait: true }, TUNNEL),
    start: (id: string, content: string) => host.sessionsService.send({ id, client_msg_id: `${content}-${Math.random()}`, content }, TUNNEL),
    acp: (id: string) => {
      const acpSession = host.store.acpSessionId(id);
      assert.ok(acpSession);
      return acpSession;
    },
    counts: () => {
      const { running, sessions } = host.runtimes.agent("fake");
      return { running, sessions };
    },
    replyOf: (id: string) =>
      host.store
        .listMessages(id, { limit: 500 })
        .messages.flatMap((m) => (m.role === "assistant" && m.parts[0].type === "text" ? [m.parts[0].text] : []))
        .join(""),
  };
}

describe("conversations in one process", () => {
  it("run at the same time, each in its own folder and with its own output and requests", async () => {
    const f = await setup();
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    assert.equal((await f.lines("spawn")).length, 1);
    assert.deepEqual(f.counts(), { running: 1, sessions: 2 });
    // Started in a folder that belongs to no conversation; each session has its own.
    const [spawned] = await f.lines("spawn");
    assert.equal(path.basename(spawned?.split(" ")[2] ?? ""), "agents");
    assert.equal((await f.send(a.id, "where")).reply_text, f.dirs.a);
    assert.equal((await f.send(b.id, "where")).reply_text, f.dirs.b);

    await Promise.all([f.start(a.id, "slow 400"), f.start(b.id, "ask delete b")]);
    const request = await eventually(() => f.store.getControl(b.id).pending[0], "b's request");
    assert.equal(request.title, "delete b");
    assert.deepEqual(f.store.getControl(a.id).pending, [], "a is not asked what b was");
    f.sessions.answer({ id: b.id, request_id: request.request_id, decision: "approve" }, TUNNEL);
    await eventually(() => !f.sessions.isBusy(b.id), "b's turn ended");
    assert.ok(f.sessions.isBusy(a.id), "a still works");
    await eventually(() => !f.sessions.isBusy(a.id), "a's turn ended");
    assert.equal(f.replyOf(b.id), `${f.dirs.b}answered yes`);
    assert.match(f.replyOf(a.id), /\.+echo: slow 400 #1$/u);
  });

  it("stopping one leaves the others' turns alone", async () => {
    const f = await setup();
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    await Promise.all([f.start(a.id, "slow 5000"), f.start(b.id, "slow 600")]);
    await eventually(async () => (await f.lines("prompt")).length === 2, "both turns run");
    await f.sessions.stop({ id: a.id }, TUNNEL);
    await eventually(() => !f.sessions.isBusy(a.id), "a's turn ended");
    assert.ok(f.sessions.isBusy(b.id));
    await eventually(() => !f.sessions.isBusy(b.id), "b's turn ended");
    assert.match(f.replyOf(b.id), /echo: slow 600 #1$/u);
    assert.deepEqual(await f.lines("cancel"), [f.acp(a.id)]);
  });

  it("deleting one mid-turn closes its session only; a permission it waits for is withdrawn", async () => {
    const f = await setup();
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    await Promise.all([f.start(a.id, "ask delete a"), f.start(b.id, "slow 500")]);
    await eventually(() => f.store.getControl(a.id).pending[0], "a's request");
    const acp = f.acp(a.id);
    await f.sessions.delete({ id: a.id }, TUNNEL);
    assert.deepEqual(await f.lines("close"), [acp]);
    assert.ok(f.sessions.isBusy(b.id));
    await eventually(() => !f.sessions.isBusy(b.id), "b's turn ended");
    assert.deepEqual(f.counts(), { running: 1, sessions: 1 });
    assert.equal((await f.send(b.id, "still here")).reply_text, "echo: still here #2");
    assert.equal((await f.lines("spawn")).length, 1);
  });

  it("a session whose agent never answers session/close (nor the turn in it) is let go of", async () => {
    const f = await setup({ flags: ["--silent-close"] });
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    await f.start(a.id, "ask forever");
    await eventually(() => f.store.getControl(a.id).pending[0], "a's request");
    const closing = f.host.runtimes.closeSession(a.id);
    await eventually(() => !f.sessions.isBusy(a.id), "its turn ended");
    assert.equal(f.store.getControl(a.id).state, "idle");
    assert.equal((await f.send(b.id, "hello")).reply_text, "echo: hello #1");
    await f.host.stopAgent("fake");
    await closing;
  });

  it("a crash ends the turns in it as failed; every conversation's next message reopens it in one new process", async () => {
    const f = await setup();
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    const c = await f.create(f.dirs.c);
    const [acpA, acpB, acpC] = [f.acp(a.id), f.acp(b.id), f.acp(c.id)];
    await f.start(a.id, "slow 5000");
    await eventually(async () => (await f.lines("prompt")).length === 1, "a's turn runs");
    await f.send(b.id, "crash");
    await eventually(() => !f.sessions.isBusy(a.id) && !f.sessions.isBusy(b.id), "both turns ended");
    for (const id of [a.id, b.id]) {
      assert.equal(f.store.getControl(id).state, "error");
      assert.match(f.store.getControl(id).error ?? "", /the agent exited \(3\)/u);
    }
    assert.equal(f.store.getControl(c.id).state, "idle", "nothing ran in it");
    assert.deepEqual(f.counts(), { running: 0, sessions: 0 });

    const replies = await Promise.all([a, b, c].map((session) => f.send(session.id, "again")));
    assert.deepEqual(replies.map((reply) => reply.reply_text), Array(3).fill("echo: again #1"));
    assert.equal((await f.lines("spawn")).length, 2, "one process for all three");
    const pid = await f.pid(1);
    assert.deepEqual(new Set(await f.lines("resume")), new Set([acpA, acpB, acpC].map((acp) => `${acp} ${pid}`)));
    assert.deepEqual([f.acp(a.id), f.acp(b.id), f.acp(c.id)], [acpA, acpB, acpC]);
  });

  it("a refused session (sign-in required) leaves no process behind when nothing else needs it, and one that does alone", async () => {
    const f = await setup({ flags: ["--needs-auth"] });
    const signedOut = `${f.logFile}.signed-out`;
    const refused = async () => {
      await assert.rejects(f.create(f.dirs.b), (error: unknown) => {
        assert.ok(error instanceof MeshCallError);
        assert.equal(error.details?.reason, "agent_auth_required");
        return true;
      });
    };
    await writeFile(signedOut, "");
    await refused();
    assert.deepEqual(f.counts(), { running: 0, sessions: 0 });
    assert.equal(alive(await f.pid(0)), false, "the next try starts anew");

    await rm(signedOut);
    const a = await f.create(f.dirs.a);
    await writeFile(signedOut, "");
    await refused();
    assert.deepEqual(f.counts(), { running: 1, sessions: 1 });
    assert.equal((await f.send(a.id, "hello")).reply_text, "echo: hello #1");
    assert.equal((await f.lines("spawn")).length, 2);
  });
});

describe("settings that need another process", () => {
  it("idle conversations move right away, a busy one when its turn has ended; then the old process exits", async () => {
    const f = await setup();
    const idle = await f.create(f.dirs.a);
    const busy = await f.create(f.dirs.b);
    await f.send(idle.id, "one");
    await f.start(busy.id, "slow 900");
    await eventually(async () => (await f.lines("prompt")).length === 2, "the turn runs");
    const old = await f.pid(0);

    await f.host.deviceService.update_agent({ id: "fake", env: { AA_TEST_TOKEN: "v2" } }, TUNNEL);
    assert.equal((await f.send(idle.id, "two")).reply_text, "echo: two #1", "reopened in the new one");
    assert.deepEqual((await f.lines("spawn")).map((line) => line.split(" ")[1]), ["-", "v2"]);
    assert.ok(f.sessions.isBusy(busy.id), "not cut short");
    assert.deepEqual(f.counts(), { running: 2, sessions: 2 });

    await eventually(() => !f.sessions.isBusy(busy.id), "the turn ended");
    assert.match(f.replyOf(busy.id), /echo: slow 900 #1$/u);
    await eventually(() => !alive(old), "the old process exited");
    assert.deepEqual(f.counts(), { running: 1, sessions: 1 });
    const acp = f.acp(busy.id);
    assert.equal((await f.send(busy.id, "three")).reply_text, "echo: three #1");
    assert.deepEqual((await f.lines("resume")).at(-1), `${acp} ${await f.pid(1)}`);
    assert.equal((await f.lines("spawn")).length, 2);
  });

  it("a message queued behind the turn runs in the new process", async () => {
    const f = await setup();
    const a = await f.create(f.dirs.a);
    await f.start(a.id, "slow 500");
    await eventually(async () => (await f.lines("prompt")).length === 1, "the turn runs");
    await f.sessions.send({ id: a.id, client_msg_id: "queued", content: "next", delivery: "queue" }, TUNNEL);
    await f.host.deviceService.update_agent({ id: "fake", env: { AA_TEST_TOKEN: "v2" } }, TUNNEL);
    await eventually(() => f.replyOf(a.id).includes("echo: next"), "the queued message ran");
    const pid = await f.pid(1);
    assert.deepEqual(await f.lines("resume"), [`${f.acp(a.id)} ${pid}`]);
    await eventually(() => f.counts().running === 1, "the old process exited");
  });

  it("an agent that cannot restore keeps its conversations where they are; new ones get the new process", async () => {
    const f = await setup({ caps: "close" });
    const a = await f.create(f.dirs.a);
    await f.send(a.id, "one");
    await f.host.deviceService.update_agent({ id: "fake", env: { AA_TEST_TOKEN: "v2" } }, TUNNEL);
    assert.equal((await f.send(a.id, "two")).reply_text, "echo: two #2", "the same session");
    const b = await f.create(f.dirs.b);
    assert.equal((await f.send(b.id, "one")).reply_text, "echo: one #1");
    assert.deepEqual(f.counts(), { running: 2, sessions: 2 });
    assert.deepEqual((await f.lines("new")).map((line) => line.split(" ")[0]), [f.acp(a.id), f.acp(b.id)]);

    const old = await f.pid(0);
    await f.sessions.delete({ id: a.id }, TUNNEL);
    await eventually(() => !alive(old), "it exits with its last conversation");
    assert.deepEqual(f.counts(), { running: 1, sessions: 1 });
  });

  it("changed twice in a row: only the last settings get a process", async () => {
    const f = await setup();
    const a = await f.create(f.dirs.a);
    await f.host.deviceService.update_agent({ id: "fake", env: { AA_TEST_TOKEN: "v2" } }, TUNNEL);
    await f.host.deviceService.update_agent({ id: "fake", env: { AA_TEST_TOKEN: "v3" } }, TUNNEL);
    assert.equal((await f.send(a.id, "one")).reply_text, "echo: one #1");
    assert.deepEqual((await f.lines("spawn")).map((line) => line.split(" ")[1]), ["-", "v3"]);
    await eventually(() => f.counts().running === 1, "the old process exited");
  });
});

describe("idle close", () => {
  it("closes an idle session alone while another works, and the process once none does; each is reopened on its next message", async () => {
    const f = await setup({ host: { idleTtlMs: 300 } });
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    await f.send(a.id, "one");
    await f.start(b.id, "slow 1200");
    await eventually(async () => (await f.lines("close")).length === 1, "a closed", 3_000);
    assert.deepEqual(await f.lines("close"), [f.acp(a.id)]);
    assert.deepEqual(f.counts(), { running: 1, sessions: 1 });
    assert.ok(f.logs.includes(`Fake: closing the session of conversation ${a.id} after 300 ms idle; its next message restores it`), f.logs.join("\n"));

    // Reopened in the running process.
    assert.equal((await f.send(a.id, "two")).reply_text, "echo: two #1");
    assert.equal((await f.lines("spawn")).length, 1);
    await eventually(() => !f.sessions.isBusy(b.id), "b's turn ended");
    const pid = await f.pid(0);
    await eventually(() => !alive(pid), "the process closed once both were idle", 3_000);
    assert.deepEqual(f.counts(), { running: 0, sessions: 0 });
    assert.equal((await f.send(b.id, "three")).reply_text, "echo: three #1");
    assert.equal((await f.lines("spawn")).length, 2);
  });

  it("an agent that cannot close single sessions keeps them until all are idle", async () => {
    const f = await setup({ caps: "load", host: { idleTtlMs: 300 } });
    const a = await f.create(f.dirs.a);
    const b = await f.create(f.dirs.b);
    await f.start(b.id, "slow 900");
    await sleep(600);
    assert.deepEqual(f.counts(), { running: 1, sessions: 2 }, "a is past its idle close, b works");
    assert.ok(f.host.runtimes.isLive(a.id));
    const pid = await f.pid(0);
    await eventually(() => !alive(pid), "the process closed once both were idle", 3_000);
    assert.deepEqual(await f.lines("close"), []);
    assert.deepEqual(f.counts(), { running: 0, sessions: 0 });
    assert.equal((await f.send(a.id, "back")).reply_text, "echo: back #1");
    assert.deepEqual(await f.lines("load"), [`${f.acp(a.id)} ${await f.pid(1)}`]);
  });

  it("a process left without a conversation is closed after the idle close, unless one comes meanwhile", async () => {
    const f = await setup({ host: { idleTtlMs: 400 } });
    const a = await f.create(f.dirs.a);
    const pid = await f.pid(0);
    await f.sessions.delete({ id: a.id }, TUNNEL);
    await sleep(200);
    const b = await f.create(f.dirs.b);
    await f.start(b.id, "slow 600");
    await sleep(500);
    assert.ok(alive(pid), "in use again");
    await eventually(() => !f.sessions.isBusy(b.id), "the turn ended");
    await f.sessions.delete({ id: b.id }, TUNNEL);
    assert.ok(alive(pid));
    await eventually(() => !alive(pid), "closed", 3_000);
    assert.ok(f.logs.includes("Fake: closing its process after 400 ms without a conversation"), f.logs.join("\n"));
  });
});

describe("an agent with a process per conversation (own_process)", () => {
  it("starts one each, which exits with its conversation", async () => {
    const f = await setup({ preset: { own_process: true } });
    const [a, b] = await Promise.all([f.create(f.dirs.a), f.create(f.dirs.b)]);
    assert.deepEqual(f.counts(), { running: 2, sessions: 2 });
    const processOf = (id: string) => Number(f.acp(id).split("-")[1]);
    assert.notEqual(processOf(a.id), processOf(b.id));
    const gone = processOf(a.id);
    await f.sessions.delete({ id: a.id }, TUNNEL);
    assert.equal(alive(gone), false);
    assert.equal((await f.send(b.id, "hello")).reply_text, "echo: hello #1");
    assert.deepEqual(f.counts(), { running: 1, sessions: 1 });
  });
});
