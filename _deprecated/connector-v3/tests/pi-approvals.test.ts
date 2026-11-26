// Approvals for Pi (`core/pi-approvals.ts`, `runtime/pi-approvals.ts`): the extension file Pi loads, how it behaves
// inside a Pi (a fake `pi` and `ctx`), how its confirmations become requests about Pi's own calls, and the Connector
// side against a small stdio ACP agent that logs the mode file it was started with and asks as pi-acp does: the agent
// setting, the conversation setting and its mode file, and the approval itself.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { MeshCallError, type RpcContext } from "meshcall";

import type { AcpRequestPermissionParams } from "../src/core/acp-protocol.js";
import {
  PI_APPROVALS_CONFIG_ID,
  PI_APPROVALS_ENV,
  PI_APPROVALS_EXTENSION_FILE,
  PI_APPROVALS_EXTENSION_MARKER,
  piApprovalRequest,
  piApprovalsExtensionSource,
  piToolNeedsApproval,
  type PiApprovalMode,
} from "../src/core/pi-approvals.js";
import { SessionStore } from "../src/core/session-store.js";
import { DeviceGate } from "../src/core/gate.js";
import { TunnelStreamTracker } from "../src/rpc/device-admin-service.js";
import { SessionsService } from "../src/rpc/sessions-service.js";
import { AcpRuntimeHost } from "../src/runtime/acp-host.js";
import { installPiApprovals, PiApprovalsFile, uninstallPiApprovals } from "../src/runtime/pi-approvals.js";

// argv: <log file>. Logs every start with the mode file it was given, every setting change it receives and every answer.
// A prompt starting with "run " runs the rest as a bash call, asking first as pi-acp does: the call reported as running,
// then the extension's confirmation as a permission request about a call of its own.
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(log, line + "\n");
note("spawn " + process.pid + " " + (process.env.AA_APPROVALS_FILE || "-"));
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const waiting = new Map();
const ask = (params) => new Promise((resolve) => {
  const id = "ask-" + (waiting.size + 1);
  waiting.set(id, resolve);
  out({ jsonrpc: "2.0", id, method: "session/request_permission", params });
});
async function run(sessionId, command) {
  const firstLine = command.split("\n")[0];
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: firstLine, kind: "execute", status: "in_progress", rawInput: { command } });
  const answer = await ask({
    sessionId,
    toolCall: {
      toolCallId: "pi-ui-confirm-mie0x1", title: "Run: " + firstLine, kind: "other", status: "pending",
      rawInput: { method: "confirm", message: JSON.stringify({ agents_anywhere_approval: { id: "call_1", tool: "bash", input: { command } } }) },
    },
    options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }],
  });
  note("answer " + (answer.outcome.optionId || answer.outcome.outcome));
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: answer.outcome.optionId === "yes" ? "completed" : "failed" });
}
const config = (s) => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: s.model,
  options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }] }];
const sessions = new Map();
let created = 0;
async function handle(msg) {
  if (msg.method === undefined) {
    const answer = waiting.get(msg.id);
    if (answer) answer(msg.result);
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => out({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
    case "session/new": {
      const sessionId = "acp-" + process.pid + "-" + ++created;
      const s = { model: "fast" };
      sessions.set(sessionId, s);
      return reply({ sessionId, configOptions: config(s) });
    }
    case "session/resume": {
      const s = { model: "fast" };
      sessions.set(params.sessionId, s);
      return reply({ configOptions: config(s) });
    }
    case "session/close":
      sessions.delete(params.sessionId);
      return reply({});
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      s[params.configId] = params.value;
      note("set " + params.configId + "=" + params.value);
      return reply({ configOptions: config(s) });
    }
    case "session/prompt": {
      const text = params.prompt.map((block) => block.text || "").join("");
      if (text.startsWith("run ")) await run(params.sessionId, text.slice(4));
      return reply({ stopReason: "end_turn" });
    }
    case "session/cancel": return;
    default: if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: "no " + method } });
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

let root: string;
let agentScript: string;
const hosts: AcpRuntimeHost[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-v3-pi-approvals-"));
  agentScript = path.join(root, "fake-acp-agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const modesIn = async (file: string) => JSON.parse(await readFile(file, "utf8")) as { default: string; modes: Record<string, string> };

describe("the extension file", () => {
  it("is installed, brought up to date, and removed only when it is AA's", async () => {
    const dir = await mkdtemp(path.join(root, "extensions-"));
    const file = path.join(dir, PI_APPROVALS_EXTENSION_FILE);
    await installPiApprovals(dir);
    assert.equal(await readFile(file, "utf8"), piApprovalsExtensionSource());
    assert.ok(piApprovalsExtensionSource().startsWith(PI_APPROVALS_EXTENSION_MARKER));

    await writeFile(file, `${PI_APPROVALS_EXTENSION_MARKER}: from an older Connector\n`);
    await installPiApprovals(dir);
    assert.equal(await readFile(file, "utf8"), piApprovalsExtensionSource(), "an older one is replaced");
    await uninstallPiApprovals(dir);
    assert.equal(existsSync(file), false);
    await uninstallPiApprovals(dir); // nothing there: fine

    // The user's own file of the same name is never replaced or removed.
    await writeFile(file, "// mine\n");
    await assert.rejects(installPiApprovals(dir), /not the Agents Anywhere extension/);
    await uninstallPiApprovals(dir);
    assert.equal(await readFile(file, "utf8"), "// mine\n");
  });
});

describe("which tool calls ask", () => {
  // Pi's own tools, and ones it does not have: a PowerShell call, an MCP server's, an extension's, one that only sounds
  // harmless.
  const reading = ["read", "grep", "find", "ls"];
  const editing = ["edit", "write"];
  const unknown = ["bash", "powershell", "mcp__github__create_issue", "deploy", "get_weather", "read_file", ""];
  const asking = (mode: string, tools: string[]) => tools.filter((tool) => piToolNeedsApproval(mode, tool));

  it("full access: none", () => {
    assert.deepEqual(asking("full_access", [...reading, ...editing, ...unknown]), []);
  });

  it("ask: everything but reading; a tool AA does not know asks", () => {
    assert.deepEqual(asking("ask", [...reading, ...editing, ...unknown]), [...editing, ...unknown]);
  });

  it("accept edits: file changes go ahead, a tool AA does not know still asks", () => {
    assert.deepEqual(asking("accept_edits", [...reading, ...editing, ...unknown]), unknown);
  });

  it("any other mode counts as ask", () => {
    for (const mode of ["", "nonsense", "FULL_ACCESS"]) assert.deepEqual(asking(mode, [...editing, ...unknown]), [...editing, ...unknown]);
  });
});

type Handler = (event: { toolCallId: string; toolName: string; input: unknown }, ctx: unknown) => Promise<{ block: true; reason: string } | undefined>;

/** A dialog of a Pi extension, as pi-acp reports it. */
function dialog(title: string, message: string): AcpRequestPermissionParams {
  return {
    sessionId: "acp",
    toolCall: { toolCallId: "pi-ui-confirm-mie0x1", title, kind: "other", status: "pending", rawInput: { method: "confirm", message } },
    options: [
      { optionId: "yes", name: "Yes", kind: "allow_once" },
      { optionId: "no", name: "No", kind: "reject_once" },
    ],
  };
}

describe("the extension inside Pi", () => {
  /** Load the extension as Pi would (a fresh module each time) and run its default export with a fake `pi`. */
  async function load(): Promise<Handler[]> {
    const dir = await mkdtemp(path.join(root, "extensions-"));
    await installPiApprovals(dir);
    const url = `${pathToFileURL(path.join(dir, PI_APPROVALS_EXTENSION_FILE)).href}?v=${Math.random()}`;
    const extension = (await import(url)) as { default: (pi: { on: (event: string, handler: Handler) => void }) => void };
    const handlers: Handler[] = [];
    extension.default({ on: (event, handler) => event === "tool_call" && handlers.push(handler) });
    return handlers;
  }

  afterEach(() => {
    delete process.env[PI_APPROVALS_ENV];
  });

  it("does nothing in a Pi that AA did not start", async () => {
    delete process.env[PI_APPROVALS_ENV];
    assert.deepEqual(await load(), []);
  });

  it("asks as the conversation's mode says, and blocks what is declined or cannot be asked", async () => {
    const modes = await PiApprovalsFile.create(path.join(root, "modes"));
    const mode = { set: (value: PiApprovalMode) => modes.set("session-1", value) };
    await mode.set("full_access");
    process.env[PI_APPROVALS_ENV] = modes.path;
    const [onToolCall] = await load();
    assert.ok(onToolCall);
    const asked: string[] = [];
    const sessionManager = { getSessionId: () => "session-1" };
    const answering = (answer: boolean) => ({ sessionManager, hasUI: true, ui: { confirm: async (title: string) => (asked.push(title), answer) } });
    const call = (toolName: string, input: unknown, answer = true) => onToolCall({ toolCallId: "call_1", toolName, input }, answering(answer));
    const command = { command: "rm -rf build\necho done" };

    // Full access: never asks.
    assert.equal(await call("bash", command, false), undefined);
    assert.equal(await call("edit", { path: "src/a.ts", oldText: "a", newText: "b" }, false), undefined);
    assert.deepEqual(asked, []);

    // Ask: commands and file changes are confirmed first; a decline blocks the call.
    await mode.set("ask");
    assert.deepEqual(await call("bash", command, false), { block: true, reason: "The user declined this in Agents Anywhere." });
    assert.equal(await call("write", { path: "notes.md", content: "x" }, true), undefined);
    assert.deepEqual(asked, ["Run: rm -rf build", "Write: notes.md"]);

    // Accept edits: file changes go ahead, commands are confirmed.
    asked.length = 0;
    await mode.set("accept_edits");
    assert.equal(await call("edit", { path: "src/a.ts", oldText: "a", newText: "b" }, false), undefined);
    assert.equal((await call("bash", { command: "npm test" }, false))?.block, true);
    assert.deepEqual(asked, ["Run: npm test"]);

    // A tool AA does not know: confirmed in both.
    asked.length = 0;
    assert.equal((await call("deploy", { env: "prod" }, false))?.block, true);
    await mode.set("ask");
    assert.equal((await call("deploy", { env: "prod" }, false))?.block, true);
    assert.deepEqual(asked, ["Use deploy", "Use deploy"]);

    // Asking is impossible (no UI): blocked rather than done unasked.
    assert.equal((await onToolCall({ toolCallId: "call_1", toolName: "bash", input: command }, { sessionManager, hasUI: false }))?.block, true);
    // An unreadable file: the safest mode.
    await modes.remove();
    assert.equal((await call("bash", command, false))?.block, true);
  });

  it("keeps a mode per session: one process runs many, and a session without one asks", async () => {
    const modes = await PiApprovalsFile.create(path.join(root, "modes"));
    process.env[PI_APPROVALS_ENV] = modes.path;
    const [onToolCall] = await load();
    assert.ok(onToolCall);
    /** Whether a command asks in that session (declined, so it is blocked when it does). */
    const asks = async (sessionId: unknown) => {
      const ctx = { sessionManager: { getSessionId: () => sessionId }, hasUI: true, ui: { confirm: async () => false } };
      return (await onToolCall({ toolCallId: "call_1", toolName: "bash", input: { command: "ls" } }, ctx)) !== undefined;
    };
    await modes.set("trusted", "full_access");
    assert.deepEqual([await asks("trusted"), await asks("other"), await asks(undefined), await asks("constructor")], [false, true, true, true]);
    await modes.set("other", "full_access");
    await modes.forget("trusted");
    assert.deepEqual([await asks("trusted"), await asks("other")], [true, false]);
    assert.deepEqual([modes.mode("trusted"), modes.mode("other")], ["ask", "full_access"]);
    // Turned off while the process runs: no session asks any more.
    await modes.turnOff();
    assert.deepEqual([await asks("trusted"), await asks("new")], [false, false]);
    await modes.remove();
  });

  it("names the call it asks about, so the request is about that call and not about the dialog", async () => {
    const modes = await PiApprovalsFile.create(path.join(root, "modes"));
    process.env[PI_APPROVALS_ENV] = modes.path;
    const [onToolCall] = await load();
    assert.ok(onToolCall);
    /** The permission request a call of Pi's leads to, as the Connector asks it. */
    const requestFor = async (toolName: string, input: unknown, known: boolean) => {
      const shown: AcpRequestPermissionParams[] = [];
      const confirm = async (title: string, message: string) => (shown.push(dialog(title, message)), true);
      await onToolCall({ toolCallId: "call_1", toolName, input }, { hasUI: true, ui: { confirm } });
      assert.equal(shown.length, 1);
      return piApprovalRequest(shown[0]!, (id) => known && id === "call_1");
    };
    const command = { command: "ls\nrm -rf build" };

    // The call is in the conversation: nothing of it is replaced, but a command is titled whole, not by its first line.
    const run = await requestFor("bash", command, true);
    assert.deepEqual(run.toolCall, { toolCallId: "call_1", title: "ls\nrm -rf build" });
    assert.deepEqual(run.options, [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ]);
    assert.deepEqual((await requestFor("write", { path: "notes.md", content: "x" }, true)).toolCall, { toolCallId: "call_1" });
    assert.deepEqual((await requestFor("deploy", { env: "prod" }, true)).toolCall, { toolCallId: "call_1" });

    // It is not (yet): all there is to know comes with the request.
    const pending = { toolCallId: "call_1", status: "pending" };
    assert.deepEqual((await requestFor("bash", command, false)).toolCall, { ...pending, title: "ls\nrm -rf build", kind: "execute", rawInput: command });
    assert.deepEqual((await requestFor("edit", { path: "a.ts" }, false)).toolCall, { ...pending, title: "Edit: a.ts", kind: "edit", rawInput: { path: "a.ts" } });
    assert.deepEqual((await requestFor("deploy", { env: "prod" }, false)).toolCall, { ...pending, title: "Use deploy", kind: "other", rawInput: { env: "prod" } });
  });

  it("leaves other extensions' dialogs as they are", () => {
    for (const message of ["Delete everything?", "", "null", "[]", '"text"', "{}", '{"agents_anywhere_approval":null}', '{"agents_anywhere_approval":{"id":""}}', '{"agents_anywhere_approval":{"id":1,"tool":"bash"}}']) {
      const request = dialog("Sure?", message);
      assert.equal(piApprovalRequest(request, () => true), request, message);
    }
    const select = dialog("Which one?", "{}");
    select.toolCall.rawInput = { method: "select", options: ["a", "b"], message: '{"agents_anywhere_approval":{"id":"call_1","tool":"bash","input":{}}}' };
    assert.equal(piApprovalRequest(select, () => true), select);
    const call: AcpRequestPermissionParams = { sessionId: "acp", toolCall: { toolCallId: "t" }, options: [] };
    assert.equal(piApprovalRequest(call, () => true), call);
  });
});

describe("approvals as an agent setting", () => {
  async function setup() {
    const dir = await mkdtemp(path.join(root, "case-"));
    const logFile = path.join(dir, "agent.log");
    await writeFile(logFile, "");
    const project = path.join(dir, "project");
    await mkdir(project);
    const extensions = path.join(dir, "pi-agent", "extensions");
    const store = new SessionStore({ device: { id: "dev_test", name: "Test" } });
    const preset = (id: string, approvals: boolean) => ({
      id,
      name: id,
      command: process.execPath,
      args: [agentScript, logFile],
      ...(approvals ? { approvals: "pi" as const } : {}),
    });
    const saved: unknown[] = [];
    const host = new AcpRuntimeHost({
      store,
      includeDefaultPresets: false,
      presets: [preset("pi", true), preset("other", false)],
      killGraceMs: 500,
      piExtensionsDir: extensions,
      approvalsDir: path.join(dir, "modes"),
      onAgentSettingsChange: (settings) => void saved.push(settings),
    });
    hosts.push(host);
    const gate = await DeviceGate.create({ instanceId: "dev_test" });
    const service = new SessionsService({ gate, store, runtimes: host, streams: new TunnelStreamTracker(), waitTimeoutMs: 5_000 });
    const log = async () => (await readFile(logFile, "utf8")).split("\n").filter((line) => line.length > 0);
    /** The mode file the n-th process was started with ("-": none). */
    const startedWith = async (n: number) => {
      const line = await eventually(async () => (await log()).filter((l) => l.startsWith("spawn "))[n], `process start #${n}`);
      return line.split(" ")[2] ?? "-";
    };
    return { host, service, store, project, extensions, saved, log, startedWith };
  }

  const approvalsOf = (config: { id: string; current: string }[]) => config.find((o) => o.id === PI_APPROVALS_CONFIG_ID)?.current;

  it("is offered only for agents AA can add approvals to, and off until turned on", async () => {
    const f = await setup();
    assert.equal(f.host.agent("pi").approvals, false);
    assert.equal("approvals" in f.host.agent("other"), false);
    await assert.rejects(f.host.updateAgent("other", { approvals: true }), (error: unknown) => {
      assert.ok(error instanceof MeshCallError);
      assert.equal(error.details?.reason, "approvals_unsupported");
      return true;
    });

    const session = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    assert.equal(approvalsOf(session.config), undefined, "no setting while off");
    assert.equal(await f.startedWith(0), "-", "no mode file while off");
    assert.equal(existsSync(path.join(f.extensions, PI_APPROVALS_EXTENSION_FILE)), false);
  });

  it("turned on: installs the extension, and each conversation gets the setting and a mode of its own", async () => {
    const f = await setup();
    const on = await f.host.updateAgent("pi", { approvals: true });
    assert.equal(on.approvals, true);
    assert.deepEqual(f.saved.at(-1), { pi: { approvals: true } });
    assert.equal(await readFile(path.join(f.extensions, PI_APPROVALS_EXTENSION_FILE), "utf8"), piApprovalsExtensionSource());

    const session = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    assert.equal(approvalsOf(session.config), "ask", "asks until told otherwise");
    const file = await f.startedWith(0);
    assert.notEqual(file, "-");
    const modeOf = async (id: string) => {
      const state = await modesIn(file);
      return state.modes[f.store.acpSessionId(id) ?? ""] ?? state.default;
    };
    assert.equal(await modeOf(session.id), "ask");

    // The setting is the Connector's: the agent never hears of it.
    const changed = await f.service.set_config({ id: session.id, config_id: PI_APPROVALS_CONFIG_ID, value: "accept_edits" }, ctx);
    assert.equal(approvalsOf(changed.config), "accept_edits");
    assert.equal(await modeOf(session.id), "accept_edits");
    assert.ok(!(await f.log()).some((line) => line.startsWith(`set ${PI_APPROVALS_CONFIG_ID}`)));
    await assert.rejects(f.service.set_config({ id: session.id, config_id: PI_APPROVALS_CONFIG_ID, value: "sometimes" }, ctx));
    // The agent's own settings keep it.
    const model = await f.service.set_config({ id: session.id, config_id: "model", value: "smart" }, ctx);
    assert.equal(approvalsOf(model.config), "accept_edits");

    // A new conversation starts with what the newest one was created with: changes made in it later do not count.
    const second = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    assert.equal(approvalsOf(second.config), "ask");
    const third = await f.service.create({ agent: "pi", cwd: f.project, config: { [PI_APPROVALS_CONFIG_ID]: "full_access" } }, ctx);
    assert.equal(approvalsOf(third.config), "full_access");
    const fourth = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    assert.equal(approvalsOf(fourth.config), "full_access", "the newest conversation's");
    // All of them in one process: its file says so for each.
    assert.equal((await f.log()).filter((line) => line.startsWith("spawn ")).length, 1);
    assert.deepEqual(await Promise.all([session, second, third, fourth].map((s) => modeOf(s.id))), ["accept_edits", "ask", "full_access", "full_access"]);

    // A conversation's mode goes with it; the file with the process, no later than the Connector when it stops.
    const gone = f.store.acpSessionId(session.id) ?? "";
    await f.service.delete({ id: session.id }, ctx);
    await eventually(async () => !(gone in (await modesIn(file)).modes) || undefined, "its mode forgotten");
    assert.ok(existsSync(file));
    await f.host.dispose();
    assert.equal(existsSync(file), false);
  });

  it("turned on while conversations run: idle ones move to a process with approvals", async () => {
    const f = await setup();
    const session = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    assert.equal(await f.startedWith(0), "-");
    await f.host.updateAgent("pi", { approvals: true });
    await eventually(() => f.host.agent("pi").running === 0 || undefined, "the process without approvals stopped");
    await f.service.send({ id: session.id, client_msg_id: "m1", content: "hello", wait: true }, ctx);
    const file = await f.startedWith(1);
    assert.notEqual(file, "-");
    assert.equal(approvalsOf(f.store.get(session.id)?.config ?? []), "ask");

    // Its mode comes along when it moves again (its process exits, say).
    await f.service.set_config({ id: session.id, config_id: PI_APPROVALS_CONFIG_ID, value: "full_access" }, ctx);
    await f.host.stopAgent("pi");
    await f.service.send({ id: session.id, client_msg_id: "m2", content: "hello", wait: true }, ctx);
    const next = await f.startedWith(2);
    assert.notEqual(next, file);
    assert.equal((await modesIn(next)).modes[f.store.acpSessionId(session.id) ?? ""], "full_access");
    assert.equal(approvalsOf(f.store.get(session.id)?.config ?? []), "full_access");
  });

  it("turned on: conversations from before can choose at once, open or not, and what is chosen is used", async () => {
    const f = await setup();
    const [idle, closed, untouched] = [
      await f.service.create({ agent: "pi", cwd: f.project }, ctx),
      await f.service.create({ agent: "pi", cwd: f.project }, ctx),
      await f.service.create({ agent: "pi", cwd: f.project }, ctx),
    ];
    const other = await f.service.create({ agent: "other", cwd: f.project }, ctx);
    await f.host.closeSession(closed.id);
    const modeOf = (id: string) => approvalsOf(f.store.get(id)?.config ?? []);
    const times = () => [idle, closed, untouched].map((s) => f.store.get(s.id)?.updated_at);
    const before = times();
    await f.host.updateAgent("pi", { approvals: true });
    assert.deepEqual([idle, closed, untouched, other].map((s) => modeOf(s.id)), ["ask", "ask", "ask", undefined]);
    assert.deepEqual(times(), before, "they keep their places in the list");

    // Chosen without a message having opened them.
    for (const [session, value] of [[idle, "accept_edits"], [closed, "full_access"]] as const) {
      const changed = await f.service.set_config({ id: session.id, config_id: PI_APPROVALS_CONFIG_ID, value }, ctx);
      assert.equal(approvalsOf(changed.config), value);
    }
    for (const session of [idle, closed, untouched]) await f.service.send({ id: session.id, client_msg_id: "m1", content: "hello", wait: true }, ctx);
    const file = await f.startedWith(2);
    const modes = (await modesIn(file)).modes;
    assert.deepEqual([idle, closed, untouched].map((s) => modes[f.store.acpSessionId(s.id) ?? ""] ?? "ask"), ["accept_edits", "full_access", "ask"]);
    assert.deepEqual([idle, closed, untouched].map((s) => modeOf(s.id)), ["accept_edits", "full_access", "ask"]);

    // Closed again (idle, or the agent stopped), they keep it; turned off, none has it any more.
    await f.host.closeSession(idle.id);
    await f.host.stopAgent("pi");
    assert.deepEqual([idle, closed, untouched].map((s) => modeOf(s.id)), ["accept_edits", "full_access", "ask"]);
    await f.host.updateAgent("pi", { approvals: false });
    assert.deepEqual([idle, closed, untouched].map((s) => modeOf(s.id)), [undefined, undefined, undefined]);
  });

  it("turned on before the Connector started: conversations saved without it have the setting", async () => {
    const store = new SessionStore({ device: { id: "dev_test", name: "Test" } });
    const saved = [store.create({ agent: "pi", cwd: "/tmp" }), store.create({ agent: "other", cwd: "/tmp" })];
    const host = new AcpRuntimeHost({
      store,
      includeDefaultPresets: false,
      presets: ["pi", "other"].map((id) => ({ id, name: id, command: process.execPath, args: [agentScript, "/dev/null"], ...(id === "pi" ? { approvals: "pi" as const } : {}) })),
      agentSettings: { pi: { approvals: true } },
      piExtensionsDir: path.join(root, "no-extensions"),
    });
    hosts.push(host);
    assert.deepEqual(saved.map((s) => approvalsOf(store.get(s.id)?.config ?? [])), ["ask", undefined]);
  });

  it("asks about Pi's own call: one step, with the whole command, answered by the agent's option", async () => {
    const f = await setup();
    await f.host.updateAgent("pi", { approvals: true });
    const session = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    const tools = () => f.store.listMessages(session.id).messages.flatMap((m) => (m.role === "assistant" ? m.parts : [])).filter((part) => part.type === "tool");
    const ask = async (n: number, decision: "approve" | "reject") => {
      await f.service.send({ id: session.id, client_msg_id: `m${n}`, content: "run ls\nrm -rf build" }, ctx);
      const request = await eventually(() => f.store.getControl(session.id).pending[0], "the request");
      assert.equal(request.tool_call_id, "call_1");
      assert.equal(request.title, "ls\nrm -rf build");
      assert.deepEqual(request.options.map((o) => o.name), ["Allow", "Reject"]);
      assert.equal(tools().length, n, "the dialog is not a step of its own");
      f.service.answer({ id: session.id, request_id: request.request_id, decision }, ctx);
      await eventually(() => f.store.getControl(session.id).state === "idle" || undefined, "the turn's end");
      return tools().at(-1);
    };

    const allowed = await ask(1, "approve");
    assert.deepEqual([allowed?.id, allowed?.kind, allowed?.status, allowed?.input], ["call_1", "execute", "completed", { command: "ls\nrm -rf build" }]);
    const declined = await ask(2, "reject");
    assert.equal(declined?.status, "failed");
    assert.deepEqual((await f.log()).filter((line) => line.startsWith("answer ")), ["answer yes", "answer no"]);
  });

  it("turned off: removes the extension, and running conversations stop asking and lose the setting", async () => {
    const f = await setup();
    await f.host.updateAgent("pi", { approvals: true });
    const session = await f.service.create({ agent: "pi", cwd: f.project }, ctx);
    const file = await f.startedWith(0);

    const off = await f.host.updateAgent("pi", { approvals: false });
    assert.equal(off.approvals, false);
    assert.deepEqual(f.saved.at(-1), {});
    assert.equal(existsSync(path.join(f.extensions, PI_APPROVALS_EXTENSION_FILE)), false);
    assert.equal(approvalsOf(f.store.get(session.id)?.config ?? []), undefined);
    await eventually(async () => (await modesIn(file)).default === "full_access" || undefined, "never asks from now on");
  });
});
