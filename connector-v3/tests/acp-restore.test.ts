// Restoring an agent's context when a conversation's agent process starts again (`session/resume`, `session/load`),
// and closing idle agents, on a real `ConnectorHost` (initialized, not serving; the services are called directly).
// The stdio ACP agent below keeps its sessions in files, so a new process can reopen them: it remembers what it was
// told in a session and says so in every reply, and logs every start, `session/new`, reopen, setting change and
// prompt.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import type { RpcContext } from "meshcall";

import type { AcpRuntimePreset } from "../src/core/config.js";
import { SessionStore } from "../src/core/session-store.js";
import type { Message } from "../src/core/timeline.js";
import { ConnectorHost, type ConnectorHostOptions } from "../src/host/connector-host.js";

// argv: <log file> <sessions dir> [--caps=resume,load] [--fail-restore] [--fail-resume] [--keep-settings] [--resume-replays] [--slow-exit=<ms>]
//   --caps            what initialize advertises: `resume` → sessionCapabilities.resume, `load` → loadSession
//   --fail-restore    session/resume and session/load answer "unknown session"
//   --fail-resume     only session/resume does (as Antigravity does when it cannot read a session it can load)
//   --keep-settings   a reopened session keeps its model and mode (default: back to the agent's defaults)
//   --resume-replays  session/resume replays the history too, as session/load does (an agent off the spec)
//   --slow-exit       ignores SIGTERM and exits that long after its stdin closed
//   --tick=<ms>       every that long, a usage report (metadata) to each of its sessions
//   --busy=<ms>       every that long, a line of text of its own (as an agent working between turns)
//   --late-commands=<ms>  reports its slash commands that long after answering session/new / resume / load
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [log, dir, ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f === name || f.startsWith(name + "="));
const caps = (flag("--caps")?.split("=")[1] ?? "").split(",").filter(Boolean);
const note = (line) => fs.appendFileSync(log, line + "\n");
note("spawn " + process.pid);
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (id) => path.join(dir, encodeURIComponent(id) + ".json");
const save = (s) => fs.writeFileSync(file(s.id), JSON.stringify(s));
const open = (id) => { try { return JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { return undefined; } };
const sessions = new Map();
let created = 0;
const config = (s) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto" }] },
];
const commands = (id) => {
  const late = flag("--late-commands");
  const send = () => update(id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the context" }] });
  if (late) setTimeout(send, Number(late.split("=")[1]));
  else send();
};
async function handle(msg) {
  if (msg.method === undefined) return;
  const { id, method, params } = msg;
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": {
      const agentCapabilities = {};
      if (caps.includes("load")) agentCapabilities.loadSession = true;
      if (caps.includes("resume")) agentCapabilities.sessionCapabilities = { resume: {}, close: {} };
      return reply({ protocolVersion: 1, agentCapabilities });
    }
    case "session/new": {
      const s = { id: "acp-" + process.pid + "-" + ++created, model: "fast", mode: "ask", history: [] };
      sessions.set(s.id, s);
      save(s);
      note("session/new " + s.id);
      reply({ sessionId: s.id, configOptions: config(s) });
      commands(s.id);
      return;
    }
    case "session/resume":
    case "session/load": {
      const how = method.slice("session/".length);
      note(how + " " + params.sessionId + " " + params.cwd);
      const s = open(params.sessionId);
      if (s === undefined || flag("--fail-restore") || (how === "resume" && flag("--fail-resume"))) {
        return out({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: { details: "unknown session: " + params.sessionId } } });
      }
      if (!flag("--keep-settings")) Object.assign(s, { model: "fast", mode: "ask" });
      sessions.set(s.id, s);
      if (how === "load" || flag("--resume-replays")) {
        // The whole conversation again, before the answer (ACP session/load).
        for (const [i, turn] of s.history.entries()) {
          update(s.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.user } });
          update(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about " + turn.user } });
          update(s.id, { sessionUpdate: "tool_call", toolCallId: "replayed-" + i, title: "Read notes", kind: "read", status: "completed" });
          update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.agent } });
        }
        update(s.id, { sessionUpdate: "plan", entries: [{ content: "replayed plan", priority: "low", status: "completed" }] });
      }
      commands(s.id);
      return reply({ configOptions: config(s) });
    }
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      s[params.configId] = params.value;
      save(s);
      note("set " + params.configId + "=" + params.value);
      return reply({ configOptions: config(s) });
    }
    case "session/prompt": {
      const s = sessions.get(params.sessionId);
      const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
      note("prompt " + s.id + " " + text);
      // "slow <ms> …" takes that long.
      if (text.startsWith("slow ")) await sleep(Number(text.split(" ")[1]));
      const answer = "echo: " + text + " | remembers: " + (s.history.map((t) => t.user).join(", ") || "nothing") + " | model: " + s.model;
      s.history.push({ user: text, agent: answer });
      save(s);
      update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
      return reply({ stopReason: "end_turn" });
    }
    case "session/close":
      sessions.delete(params.sessionId);
      note("close " + params.sessionId);
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
const slowExit = flag("--slow-exit");
if (slowExit) process.on("SIGTERM", () => note("sigterm " + process.pid));
process.stdin.on("end", () => setTimeout(() => { note("exit " + process.pid); process.exit(0); }, slowExit ? Number(slowExit.split("=")[1]) : 0));
const tick = flag("--tick");
if (tick) setInterval(() => { for (const id of sessions.keys()) update(id, { sessionUpdate: "usage_update", used: 1, size: 100 }); }, Number(tick.split("=")[1]));
const busy = flag("--busy");
if (busy) setInterval(() => { for (const id of sessions.keys()) update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } }); }, Number(busy.split("=")[1]));
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

/** A message as `[role, text]`, for comparing whole conversations. */
function brief(message: Message): [string, string] {
  const part = message.parts[0];
  const text = part === undefined ? "" : part.type === "text" || part.type === "thinking" ? part.text : part.type;
  return [message.role, text];
}

let root: string;
let agentScript: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-v3-restore-"));
  agentScript = path.join(root, "fake-acp-agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Hosts of the running test: stopped after it, so no agent outlives its test. */
const hosts: ConnectorHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop().catch(() => undefined)));
});

interface Fixture {
  host: ConnectorHost;
  dataDir: string;
  /** A project folder. */
  cwd: string;
  /** What the Connector logged (restores, lost contexts, idle closes). */
  logs: string[];
  /** Stop this host and start another on the same data directory (the Connector restarts). */
  restart(): Promise<void>;
  /** The agent log, as lines. */
  log(): Promise<string[]>;
  /** Agent log lines starting with `prefix ` (the prefix dropped). */
  lines(prefix: string): Promise<string[]>;
  /** Pid of the n-th process start (0-based). */
  pid(n: number): Promise<number>;
  send(id: string, content: string, clientMsgId?: string): Promise<Reply>;
  /** The conversation, briefly. */
  conversation(id: string): [string, string][];
  running(): number;
}

/**
 * `flags`: the fake agent's (`--caps=…` and the others above). `sessionsJson`: a `sessions.json` there already when
 * the Connector starts, given the project folder.
 */
async function setup(options: { flags?: string[]; host?: Partial<ConnectorHostOptions>; sessionsJson?: (cwd: string) => unknown } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(root, "case-"));
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const agentSessions = path.join(dir, "agent-sessions");
  await mkdir(agentSessions);
  const cwd = path.join(dir, "project");
  await mkdir(cwd);
  const dataDir = path.join(dir, "state");
  if (options.sessionsJson !== undefined) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dataDir, "sessions.json"), JSON.stringify(options.sessionsJson(cwd)), { mode: 0o600 });
  }
  const preset: AcpRuntimePreset = { id: "fake", name: "Fake", command: process.execPath, args: [agentScript, logFile, agentSessions, ...(options.flags ?? [])] };
  const logs: string[] = [];
  const make = async () => {
    const host = new ConnectorHost({
      dataDir,
      deviceId: "dev_restore",
      presets: [preset],
      defaultPresets: [],
      waitTimeoutMs: 5_000,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      ...options.host,
    });
    hosts.push(host);
    await host.init();
    return host;
  };
  const log = async () => (await readFile(logFile, "utf8")).split("\n").filter((line) => line.length > 0);
  const fixture: Fixture = {
    host: await make(),
    dataDir,
    cwd,
    logs,
    restart: async () => {
      await fixture.host.stop();
      fixture.host = await make();
    },
    log,
    lines: async (prefix) => (await log()).filter((line) => line.startsWith(`${prefix} `)).map((line) => line.slice(prefix.length + 1)),
    pid: async (n) => {
      const line = await eventually(async () => (await log()).filter((l) => l.startsWith("spawn "))[n], `process start #${n}`);
      return Number(line.split(" ")[1]);
    },
    send: (id, content, clientMsgId = content) => fixture.host.sessionsService.send({ id, client_msg_id: clientMsgId, content, wait: true }, TUNNEL),
    conversation: (id) => fixture.host.store.listMessages(id, { limit: 500 }).messages.map(brief),
    running: () => fixture.host.runtimes.agent("fake").running,
  };
  return fixture;
}

/** The fake agent's reply to `text` when it remembers `earlier` (none: nothing) and runs `model`. */
const echo = (text: string, earlier: string[] = [], model = "fast") => `echo: ${text} | remembers: ${earlier.join(", ") || "nothing"} | model: ${model}`;

describe("restoring the agent's context", () => {
  it("resume: the next message after stop_agent reopens the agent's session, with its context and nothing replayed", async () => {
    const f = await setup({ flags: ["--caps=resume,load"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [acpId] = await f.lines("session/new");
    assert.ok(acpId);
    assert.equal(f.host.store.acpSessionId(session.id), acpId, "saved after session/new");
    assert.equal((await f.send(session.id, "the word is PLUM")).reply_text, echo("the word is PLUM"));

    assert.equal(await f.host.stopAgent("fake"), 1);
    const reply = await f.send(session.id, "what was the word?");
    assert.equal(reply.reply_text, echo("what was the word?", ["the word is PLUM"]));
    // Preferred over session/load when both are offered; the same ACP session, in the session's folder.
    assert.deepEqual(await f.lines("resume"), [`${acpId} ${f.cwd}`]);
    assert.deepEqual(await f.lines("load"), []);
    assert.equal((await f.lines("session/new")).length, 1);
    assert.equal(f.host.store.acpSessionId(session.id), acpId);
    assert.deepEqual(f.conversation(session.id), [
      ["user", "the word is PLUM"],
      ["assistant", echo("the word is PLUM")],
      ["user", "what was the word?"],
      ["assistant", echo("what was the word?", ["the word is PLUM"])],
    ]);
    assert.deepEqual(f.host.runtimes.availableCommands(session.id).map((c) => c.name), ["compact"]);
    assert.ok(f.logs.some((line) => line.includes("reopened its session") && line.includes("session/resume")), f.logs.join("\n"));
    assert.ok(!f.logs.some((line) => line.includes("could not restore")), f.logs.join("\n"));
  });

  it("load: the agent's replay of the conversation is dropped, its commands and settings are kept", async () => {
    const f = await setup({ flags: ["--caps=load"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [acpId] = await f.lines("session/new");
    await f.send(session.id, "one");
    await f.send(session.id, "two");
    const before = f.conversation(session.id);
    assert.equal(before.length, 4);

    await f.host.stopAgent("fake");
    const reply = await f.send(session.id, "three");
    assert.equal(reply.reply_text, echo("three", ["one", "two"]));
    assert.deepEqual(await f.lines("load"), [`${acpId} ${f.cwd}`]);
    assert.deepEqual(await f.lines("resume"), []);
    // Exactly what was there, plus the new turn: no replayed user message, thought, tool, text or plan.
    assert.deepEqual(f.conversation(session.id), [...before, ["user", "three"], ["assistant", echo("three", ["one", "two"])]]);
    const messages = f.host.store.listMessages(session.id, { limit: 500 }).messages;
    assert.ok(messages.every((m) => m.role !== "user" || !m.client_msg_id?.startsWith("acp-replay:")));
    // Sent during the load: kept.
    assert.deepEqual(f.host.runtimes.availableCommands(session.id).map((c) => c.name), ["compact"]);
    assert.deepEqual(f.host.store.get(session.id)?.config.map((o) => o.id), ["model", "mode"]);

    // Again, after a Connector restart: still nothing doubled.
    await f.restart();
    await f.send(session.id, "four");
    assert.equal(f.conversation(session.id).length, 8);
    assert.equal((await f.lines("load")).length, 2);
  });

  it("an agent that crashed comes back with its context on the next message", async () => {
    const f = await setup({ flags: ["--caps=resume"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [acpId] = await f.lines("session/new");
    await f.send(session.id, "one");
    process.kill(await f.pid(0), "SIGKILL");
    await eventually(() => !f.host.runtimes.isLive(session.id), "the crash noticed");
    assert.equal(f.host.store.getControl(session.id).state, "idle");

    assert.equal((await f.send(session.id, "two")).reply_text, echo("two", ["one"]));
    assert.deepEqual(await f.lines("resume"), [`${acpId} ${f.cwd}`]);
    assert.equal(f.conversation(session.id).length, 4);
  });

  it("an agent that replays on session/resume too (off the spec) doubles nothing either", async () => {
    const f = await setup({ flags: ["--caps=resume", "--resume-replays"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.send(session.id, "one");
    await f.host.stopAgent("fake");
    await f.send(session.id, "two");
    assert.equal((await f.lines("resume")).length, 1);
    assert.deepEqual(f.conversation(session.id), [
      ["user", "one"],
      ["assistant", echo("one")],
      ["user", "two"],
      ["assistant", echo("two", ["one"])],
    ]);
  });

  it("an agent that can do neither starts a new session, says it lost the context, and is never closed when idle", async () => {
    const f = await setup({ flags: [], host: { idleTtlMs: 200 } });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.send(session.id, "one");
    const pid = await f.pid(0);
    await sleep(600); // well past the idle TTL
    assert.ok(alive(pid), "not closed: it could not come back with its context");
    assert.equal(f.running(), 1);

    await f.host.stopAgent("fake");
    const reply = await f.send(session.id, "two");
    assert.equal(reply.reply_text, echo("two"), "a new session: the context is gone");
    const news = await f.lines("session/new");
    assert.equal(news.length, 2);
    assert.deepEqual([...(await f.lines("resume")), ...(await f.lines("load"))], []);
    assert.equal(f.host.store.acpSessionId(session.id), news[1], "the new session is the one saved");
    const lost = f.logs.filter((line) => line.includes("could not restore its earlier context"));
    assert.equal(lost.length, 1, f.logs.join("\n"));
    assert.match(lost[0] ?? "", /Fake could not restore its earlier context for conversation .* offers neither session\/resume nor session\/load/);
    assert.equal(f.conversation(session.id).length, 4);
  });

  it("a restore the agent refuses falls back to a new session and says the context was lost", async () => {
    const f = await setup({ flags: ["--caps=resume,load", "--fail-restore"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [first] = await f.lines("session/new");
    await f.send(session.id, "one");
    await f.host.stopAgent("fake");

    const reply = await f.send(session.id, "two");
    assert.equal(reply.turn_result, "end_turn");
    assert.equal(reply.reply_text, echo("two"));
    // Resume first; refused, so load; refused too, so a new session.
    assert.deepEqual(await f.lines("resume"), [`${first} ${f.cwd}`]);
    assert.deepEqual(await f.lines("load"), [`${first} ${f.cwd}`]);
    const news = await f.lines("session/new");
    assert.equal(news.length, 2);
    assert.equal(f.host.store.acpSessionId(session.id), news[1]);
    const lost = f.logs.filter((line) => line.includes("could not restore its earlier context"));
    assert.equal(lost.length, 1, f.logs.join("\n"));
    // The agent's reason, with its details.
    assert.match(lost[0] ?? "", /session\/resume failed: Internal error \(unknown session: .*\); session\/load failed: Internal error \(unknown session/);
    assert.equal(f.host.store.getControl(session.id).state, "idle");
    assert.deepEqual(f.conversation(session.id).length, 4);

    // Nothing to lose (the agent never answered in this conversation): no notice.
    const quiet = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.host.stopAgent("fake");
    await f.send(quiet.id, "first");
    assert.equal(f.logs.filter((line) => line.includes("could not restore")).length, 1, f.logs.join("\n"));
  });

  it("an agent that refuses the resume but can load gets its context back through session/load", async () => {
    const f = await setup({ flags: ["--caps=resume,load", "--fail-resume"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [acpId] = await f.lines("session/new");
    await f.send(session.id, "one");
    await f.host.stopAgent("fake");

    assert.equal((await f.send(session.id, "two")).reply_text, echo("two", ["one"]));
    assert.deepEqual(await f.lines("resume"), [`${acpId} ${f.cwd}`]);
    assert.deepEqual(await f.lines("load"), [`${acpId} ${f.cwd}`]);
    assert.equal((await f.lines("session/new")).length, 1);
    assert.equal(f.host.store.acpSessionId(session.id), acpId);
    assert.equal(f.conversation(session.id).length, 4, "the load's replay is dropped");
    assert.ok(f.logs.some((line) => line.includes("reopened its session") && line.includes("session/load")), f.logs.join("\n"));
    assert.ok(!f.logs.some((line) => line.includes("could not restore")), f.logs.join("\n"));
  });

  it("a Connector restart restores: the id is in sessions.json and the new host reopens it", async () => {
    const f = await setup({ flags: ["--caps=resume"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [acpId] = await f.lines("session/new");
    await f.send(session.id, "the word is PLUM");

    await f.restart();
    const saved = JSON.parse(await readFile(path.join(f.dataDir, "sessions.json"), "utf8")) as { session: { id: string }; acp_session_id?: string }[];
    assert.equal(saved.find((s) => s.session.id === session.id)?.acp_session_id, acpId);
    assert.equal(f.host.store.acpSessionId(session.id), acpId);
    assert.equal(f.running(), 0);

    const reply = await f.send(session.id, "what was the word?");
    assert.equal(reply.reply_text, echo("what was the word?", ["the word is PLUM"]));
    assert.deepEqual(await f.lines("resume"), [`${acpId} ${f.cwd}`]);
    assert.equal(f.conversation(session.id).length, 4);
  });

  it("sets the conversation's settings again where the reopened session reports others", async () => {
    const f = await setup({ flags: ["--caps=resume"] });
    const { sessionsService: sessions } = f.host;
    const session = await sessions.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await sessions.set_config({ id: session.id, config_id: "model", value: "smart" }, TUNNEL);
    await sessions.set_config({ id: session.id, config_id: "mode", value: "auto" }, TUNNEL);
    assert.equal((await f.send(session.id, "one")).reply_text, echo("one", [], "smart"));

    // The agent reopens its session with its defaults (fast, ask): AA's settings win before the next turn runs.
    await f.host.stopAgent("fake");
    assert.equal((await f.send(session.id, "two")).reply_text, echo("two", ["one"], "smart"));
    const log = await f.log();
    const resumed = log.findIndex((line) => line.startsWith("resume "));
    assert.deepEqual(log.slice(resumed + 1, resumed + 3), ["set model=smart", "set mode=auto"]);
    assert.ok(log.findIndex((line) => line.startsWith("prompt ") && line.endsWith(" two")) > resumed + 2, "set before the turn");
    assert.deepEqual(f.host.store.get(session.id)?.config.map((o) => [o.id, o.current]), [["model", "smart"], ["mode", "auto"]]);

    // A setting chosen while the agent was not running wins, and is set once.
    await f.host.stopAgent("fake");
    await sessions.set_config({ id: session.id, config_id: "model", value: "fast" }, TUNNEL);
    assert.equal((await f.send(session.id, "three")).reply_text, echo("three", ["one", "two"], "fast"));
    const after = (await f.log()).slice(log.length);
    assert.deepEqual(after.filter((line) => line.startsWith("set ")), ["set mode=auto"], "fast is the agent's default: nothing to set");
  });

  it("an agent that keeps its settings is not set again; a fresh start after a lost context gets them back too", async () => {
    const keeps = await setup({ flags: ["--caps=resume", "--keep-settings"] });
    const one = await keeps.host.sessionsService.create({ agent: "fake", cwd: keeps.cwd }, TUNNEL);
    await keeps.host.sessionsService.set_config({ id: one.id, config_id: "model", value: "smart" }, TUNNEL);
    await keeps.send(one.id, "one");
    await keeps.host.stopAgent("fake");
    assert.equal((await keeps.send(one.id, "two")).reply_text, echo("two", ["one"], "smart"));
    assert.deepEqual(await keeps.lines("set"), ["model=smart"], "only the user's own change");

    const forgets = await setup({ flags: ["--caps=resume", "--fail-restore"] });
    const two = await forgets.host.sessionsService.create({ agent: "fake", cwd: forgets.cwd }, TUNNEL);
    await forgets.host.sessionsService.set_config({ id: two.id, config_id: "model", value: "smart" }, TUNNEL);
    await forgets.send(two.id, "one");
    await forgets.host.stopAgent("fake");
    assert.equal((await forgets.send(two.id, "two")).reply_text, echo("two", [], "smart"), "a new session, with the conversation's model");
  });

  it("saves the prepared agent's session when create takes it over, and reopens it later", async () => {
    const f = await setup({ flags: ["--caps=resume"] });
    const { sessionsService: sessions } = f.host;
    const prepared = await sessions.prepare({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const [acpId] = await f.lines("session/new");
    const session = await sessions.create({ agent: "fake", cwd: f.cwd, prepared_id: prepared.prepared_id }, TUNNEL);
    assert.equal((await f.lines("spawn")).length, 1, "taken over");
    assert.equal(f.host.store.acpSessionId(session.id), acpId);

    await f.send(session.id, "one");
    await f.host.stopAgent("fake");
    assert.equal((await f.send(session.id, "two")).reply_text, echo("two", ["one"]));
    assert.deepEqual(await f.lines("resume"), [`${acpId} ${f.cwd}`]);
  });

  it("rewind forgets the agent's session: the agent starts a new one instead of reopening the old context", async () => {
    const f = await setup({ flags: ["--caps=resume"] });
    const { sessionsService: sessions, store } = f.host;
    const session = await sessions.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.send(session.id, "one");
    await f.send(session.id, "two");
    const two = store.listMessages(session.id).messages.find((m) => m.role === "user" && brief(m)[1] === "two");
    assert.ok(two);
    const { message_id } = await sessions.rewind({ id: session.id, message_id: two.id, content: "again" }, TUNNEL);
    assert.ok(message_id);
    await eventually(() => !sessions.isBusy(session.id), "the rewound turn ended");
    assert.deepEqual(await f.lines("resume"), []);
    const news = await f.lines("session/new");
    assert.equal(news.length, 2);
    assert.equal(store.acpSessionId(session.id), news[1]);
    assert.equal(f.conversation(session.id).at(-1)?.[1], echo("again"));
  });
});

describe("idle agents", () => {
  it("closes an agent that can restore once nothing is in flight; the next message restores it", async () => {
    const f = await setup({ flags: ["--caps=resume"], host: { idleTtlMs: 400 } });
    const { sessionsService: sessions } = f.host;
    const session = await sessions.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    // A turn longer than the TTL is not cut short.
    assert.equal((await f.send(session.id, "slow 900 one")).reply_text, echo("slow 900 one"));
    const first = await f.pid(0);
    assert.equal(f.running(), 1);

    await eventually(() => !alive(first), "the idle agent closed", 3_000);
    assert.equal(f.running(), 0);
    assert.equal(f.host.runtimes.isLive(session.id), false);
    assert.equal(f.host.store.getControl(session.id).state, "idle");
    assert.ok(f.logs.includes("Fake: closing its process after 400 ms idle; the next message of a conversation restores it"), f.logs.join("\n"));
    // The conversation is untouched.
    assert.equal(f.conversation(session.id).length, 2);

    const reply = await f.send(session.id, "two");
    assert.equal(reply.reply_text, echo("two", ["slow 900 one"]));
    assert.equal((await f.lines("resume")).length, 1);
    assert.equal((await f.lines("spawn")).length, 2);
    assert.equal(f.running(), 1);
    await eventually(() => f.running() === 0, "closed again when idle", 3_000);
  });

  it("an idle close does not touch prepared agents, and 0 / null turn it off", async () => {
    const f = await setup({ flags: ["--caps=resume"], host: { idleTtlMs: 200 } });
    await f.host.sessionsService.prepare({ agent: "fake", cwd: f.cwd }, TUNNEL);
    const prepared = await f.pid(0);
    await sleep(600);
    assert.ok(alive(prepared), "a prepared agent keeps its own TTL");
    assert.equal(f.host.runtimes.listPrepared().length, 1);

    for (const idleTtlMs of [0, null]) {
      const g = await setup({ flags: ["--caps=resume"], host: { idleTtlMs } });
      const session = await g.host.sessionsService.create({ agent: "fake", cwd: g.cwd }, TUNNEL);
      await g.send(session.id, "one");
      await sleep(300);
      assert.equal(g.running(), 1, `idleTtlMs: ${idleTtlMs}`);
    }
  });

  it("never closes by default; an agent's own idle close (its settings) applies at once, also to agents idle already", async () => {
    const f = await setup({ flags: ["--caps=resume"] });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.send(session.id, "one");
    await sleep(300);
    assert.equal(f.running(), 1, "never closed by default");

    await f.host.deviceService.update_agent({ id: "fake", idle_close_minutes: 30 }, TUNNEL);
    assert.equal(f.host.runtimes.agent("fake").idleCloseMinutes, 30);
    // Minutes are too long for a test: the runtime takes milliseconds.
    f.host.runtimes.runtime("fake").configureIdle?.(200);
    await eventually(() => f.running() === 0 || undefined, "closed once idle for the agent's own time", 3_000);
    const reply = await f.send(session.id, "two");
    assert.equal(reply.turn_result, "end_turn", "its next message restores it");

    f.host.runtimes.runtime("fake").configureIdle?.(0);
    await sleep(400);
    assert.equal(f.running(), 1, "0: never");
  });

  it("output of its own between turns keeps an agent; metadata alone (usage reports) does not", async () => {
    const chatty = await setup({ flags: ["--caps=resume", "--tick=100"], host: { idleTtlMs: 400 } });
    const one = await chatty.host.sessionsService.create({ agent: "fake", cwd: chatty.cwd }, TUNNEL);
    await chatty.send(one.id, "one");
    await eventually(() => chatty.running() === 0, "closed despite the usage reports", 3_000);

    const busy = await setup({ flags: ["--caps=resume", "--busy=100"], host: { idleTtlMs: 400 } });
    const two = await busy.host.sessionsService.create({ agent: "fake", cwd: busy.cwd }, TUNNEL);
    await busy.send(two.id, "one");
    await sleep(1_000);
    assert.equal(busy.running(), 1, "working on its own: kept");
  });

  it("compact on a stopped agent waits for the restarted agent to report its commands", async () => {
    // Real agents report their commands a moment after answering session/resume: compact must not miss them.
    const f = await setup({ flags: ["--caps=resume", "--late-commands=300"] });
    const { sessionsService: sessions, store } = f.host;
    const session = await sessions.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.send(session.id, "one");
    await f.host.stopAgent("fake"); // as an idle close does

    const { message_id } = await sessions.compact({ id: session.id }, TUNNEL);
    await eventually(() => !sessions.isBusy(session.id), "the compaction ended");
    const item = store.getMessage(session.id, message_id);
    assert.equal(item?.role === "assistant" ? item.parts[0].type === "compaction" && item.parts[0].status : undefined, "completed");
    assert.deepEqual((await f.lines("prompt")).map((line) => line.split(" ").slice(1).join(" ")), ["one", "/compact"]);
    assert.equal((await f.lines("resume")).length, 1);
  });

  it("a message sent while the idle agent is closing waits for it to exit, then restores", async () => {
    // A slow exit: the agent ignores SIGTERM and takes 600 ms to exit, long enough for a message to arrive meanwhile.
    const f = await setup({ flags: ["--caps=resume", "--slow-exit=600"], host: { idleTtlMs: 300 } });
    const session = await f.host.sessionsService.create({ agent: "fake", cwd: f.cwd }, TUNNEL);
    await f.send(session.id, "one");
    const first = await f.pid(0);
    await eventually(() => f.running() === 0, "the idle close began", 3_000);
    assert.ok(alive(first), "still exiting");
    const reply = await f.send(session.id, "two");
    assert.equal(reply.reply_text, echo("two", ["one"]));
    const log = await f.log();
    assert.ok(log.indexOf(`exit ${first}`) >= 0 && log.indexOf(`exit ${first}`) < log.lastIndexOf(`spawn ${await f.pid(1)}`), log.join("\n"));
    assert.equal(f.running(), 1);
  });
});

describe("sessions.json", () => {
  it("written before agents' sessions were saved still loads: the first message starts a new session, quietly", async () => {
    let oldId = "";
    const f = await setup({
      flags: ["--caps=resume"],
      // A conversation with a reply, as an older Connector saved it: no acp_session_id.
      sessionsJson: (cwd) => {
        const store = new SessionStore({ device: { id: "dev_restore", name: "Test" } });
        const old = store.create({ agent: "fake", cwd, title: "Old" });
        oldId = old.id;
        const user = store.appendUserMessage(old.id, { client_msg_id: "m0", content: "from before" }).message;
        store.upsertAssistantItem(old.id, { id: "a0", turn_id: user.id, done: true, parts: [{ type: "text", text: "reply from before" }] });
        const sessions = store.exportSnapshot().sessions;
        assert.ok(sessions.every((s) => !("acp_session_id" in s)));
        return sessions;
      },
    });
    assert.equal(f.host.store.acpSessionId(oldId), undefined);
    const reply = await f.send(oldId, "hello");
    assert.equal(reply.reply_text, echo("hello"));
    assert.deepEqual(await f.lines("resume"), [], "nothing to reopen");
    const news = await f.lines("session/new");
    assert.equal(news.length, 1);
    assert.ok(!f.logs.some((line) => line.includes("could not restore")), f.logs.join("\n"));
    assert.equal(f.host.store.acpSessionId(oldId), news[0]);
    assert.deepEqual(f.conversation(oldId), [
      ["user", "from before"],
      ["assistant", "reply from before"],
      ["user", "hello"],
      ["assistant", echo("hello")],
    ]);
  });

  it("keeps the agent's session with the conversation: exported, loaded, never copied by fork, dropped on a new agent or folder", () => {
    const store = new SessionStore({ device: { id: "dev_restore", name: "Test" } });
    const session = store.create({ agent: "fake", cwd: "/repo" });
    const user = store.appendUserMessage(session.id, { client_msg_id: "m1", content: "hi" }).message;
    store.setAcpSessionId(session.id, "acp-1");

    const saved = JSON.parse(JSON.stringify(store.exportSnapshot())) as { sessions: { acp_session_id?: string }[] };
    assert.equal(saved.sessions[0]?.acp_session_id, "acp-1");
    const loaded = new SessionStore({ device: { id: "dev_restore", name: "Test" } });
    loaded.loadSnapshot(saved);
    assert.equal(loaded.acpSessionId(session.id), "acp-1");

    const forked = store.fork(session.id, user.id);
    assert.equal(store.acpSessionId(forked.id), undefined, "a fork starts its own agent session");
    store.updateSession(session.id, { title: "Renamed", config: [] });
    assert.equal(store.acpSessionId(session.id), "acp-1");
    store.updateSession(session.id, { cwd: "/elsewhere" });
    assert.equal(store.acpSessionId(session.id), undefined, "another folder: not the same agent session");
    store.setAcpSessionId(session.id, "acp-2");
    store.updateSession(session.id, { agent: "other" });
    assert.equal(store.acpSessionId(session.id), undefined, "another agent");
    store.setAcpSessionId(session.id, "acp-3");
    store.rewind(session.id, user.id);
    assert.equal(store.acpSessionId(session.id), undefined, "rewound: the agent's context holds the removed items");
  });
});
