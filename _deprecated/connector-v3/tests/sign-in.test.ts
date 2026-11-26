// Signing in to an agent that wants it before it opens sessions (`aa.v3.Device/sign_in_agent`, `sign_in_terminal`), on
// a real `ConnectorHost` (initialized, not serving), with a fake agent whose sign-in is a file next to its log: like
// Cursor's, a process reads it once, when it starts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import { AGENT_CATALOG } from "../src/core/agent-catalog.js";
import { ConnectorHost } from "../src/host/connector-host.js";
import { AcpRequestError } from "../src/runtime/acp-connection.js";
import { agentErrorText } from "../src/runtime/agent-process.js";
import { offeredMethods, PROGRAM_SIGN_IN, signInMethods } from "../src/runtime/sign-in.js";

function context(fields: Record<string, unknown>): RpcContext {
  return { metadata: {}, tunnel: null, e2e: null, idempotencyKey: undefined, remainingMs: () => null, signal: new AbortController().signal, ...fields } as unknown as RpcContext;
}
const TUNNEL = context({ tunnel: { id: "tun_1", principal: "user:1/client:web" } });
const CONTROL = context({ metadata: { "aa-via": "client", "aa-on-behalf-of": "user:1" } });
const MCP = context({ metadata: { "aa-via": "mcp", "aa-on-behalf-of": "user:1", "aa-mcp-client": "cursor" } });

async function refused(run: () => unknown): Promise<MeshCallError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof MeshCallError, String(error));
    return error;
  }
  assert.fail("not refused");
}

async function eventually<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// `--tui`: what it runs in a terminal to sign in. `authenticate`: `browser` waits until `<log>.browser` exists, `broken` is refused.
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, ...args] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(log, line + "\n");
const signedInFile = log + ".signed-in";
if (args.includes("--tui")) {
  note("tui " + JSON.stringify({ args, env: process.env.SIGN_IN_WITH || null, own: process.env.OWN || null, tty: process.stdout.isTTY === true }));
  fs.writeFileSync(signedInFile, "");
  console.log("Signed in.");
  process.exit(0);
}
note("spawn " + process.pid);
let signedIn = fs.existsSync(signedInFile);
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let created = 0;
async function handle(msg) {
  if (msg.method === undefined || msg.id === undefined) return;
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message, data) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message, data } });
  switch (msg.method) {
    case "initialize":
      note("auth " + JSON.stringify(msg.params.clientCapabilities.auth));
      return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, authMethods: [
        { id: "browser", name: "Browser", description: "Opens a browser." },
        { id: "broken", name: "Broken" },
        { id: "each", name: "Each process" },
        { id: "tui", name: "Terminal", type: "terminal", args: ["--tui", "now"], env: { SIGN_IN_WITH: "tui" } },
        { id: "old", name: "Old terminal", _meta: { "terminal-auth": { command: process.execPath, args: [__filename, log, "--tui", "old"], env: { SIGN_IN_WITH: "old" }, label: "x" } } },
        { id: "key", name: "API key", _meta: { "api-key": { provider: "x" } } },
        { id: "later", name: "Something new", type: "hologram" },
      ] });
    case "session/new":
      if (!signedIn) return fail(-32000, "Authentication required", { message: "Authentication required. Run fake login." });
      return reply({ sessionId: "acp-" + process.pid + "-" + ++created });
    case "authenticate":
      note("authenticate " + msg.params.methodId);
      if (msg.params.methodId === "each") { if (fs.existsSync(log + ".expired")) return fail(-32000, "Expired"); signedIn = true; return reply({}); }
      if (msg.params.methodId === "broken") return fail(-32602, "Invalid params", { message: "Failed to open browser." });
      while (!fs.existsSync(log + ".browser")) await new Promise((r) => setTimeout(r, 20));
      signedIn = true;
      return reply({});
    default: return reply({});
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
    if (line.trim()) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let root: string;
const hosts: ConnectorHost[] = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-sign-in-"));
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});
after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup() {
  const dir = await mkdtemp(path.join(root, "device-"));
  const project = path.join(dir, "project");
  await mkdir(project);
  const agentScript = path.join(dir, "agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const host = new ConnectorHost({
    dataDir: path.join(dir, "data"),
    deviceId: "dev_sign_in",
    defaultPresets: [{ id: "fake", name: "Fake", command: process.execPath, args: [agentScript, logFile], env: { OWN: "yes" } }],
    waitTimeoutMs: 5_000,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  hosts.push(host);
  await host.init();
  const lines = async (word: string) => (await readFile(logFile, "utf8")).split("\n").filter((line) => line.startsWith(`${word} `)).map((line) => line.slice(word.length + 1));
  return {
    host,
    dataDir: path.join(dir, "data"),
    logFile,
    lines,
    prepare: () => host.sessionsService.prepare({ agent: "fake", cwd: project }, TUNNEL),
    entry: () => host.deviceService.agents({}, TUNNEL).agents.find(({ id }) => id === "fake"),
    running: () => host.agents().find(({ id }) => id === "fake")?.running,
    signIn: (method: string) => host.deviceService.sign_in_agent({ id: "fake", method }, TUNNEL),
  };
}

describe("signing in to an agent", () => {
  it("a refused start says how to sign in, in the agent's own words", async () => {
    const f = await setup();
    const error = await refused(f.prepare);
    assert.deepEqual([error.code, error.reason], ["failed_precondition", "agent_auth_required"]);
    assert.equal(error.details?.agent_message, "Authentication required. Run fake login.");
    // Ways AA cannot serve (a key sent along, a type it does not know) are left out.
    assert.deepEqual(error.details?.auth_methods, [
      { id: "browser", name: "Browser", description: "Opens a browser.", kind: "agent" },
      { id: "broken", name: "Broken", kind: "agent" },
      { id: "each", name: "Each process", kind: "agent" },
      { id: "tui", name: "Terminal", kind: "terminal" },
      { id: "old", name: "Old terminal", kind: "terminal" },
    ]);
    assert.deepEqual(f.entry()?.sign_in, error.details?.auth_methods, "known from then on");
    assert.deepEqual(await f.lines("auth"), ['{"terminal":true}']);
  });

  it("the agent signs in itself: asking again joins, starts meanwhile leave it alone, and its process can be used then", async () => {
    const f = await setup();
    await refused(f.prepare);
    const [first, second] = [f.signIn("browser"), f.signIn("browser")];
    await eventually(async () => (await f.lines("authenticate")).length > 0, "authenticate");
    // A start in the same process is refused as before, and does not end the sign-in.
    assert.equal((await refused(f.prepare)).reason, "agent_auth_required");
    assert.equal(f.running(), 1);
    await writeFile(`${f.logFile}.browser`, "");
    assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
    assert.deepEqual(await f.lines("authenticate"), ["browser"]);
    const spawned = await f.lines("spawn");
    await f.prepare();
    assert.deepEqual(await f.lines("spawn"), spawned, "the session is opened in the process that was signed in to");
  });

  it("a sign-in the agent refuses says why, and leaves no process behind", async () => {
    const f = await setup();
    const error = await refused(() => f.signIn("broken"));
    assert.deepEqual([error.code, error.reason, error.message], ["failed_precondition", "sign_in_failed", "Invalid params (Failed to open browser.)"]);
    assert.equal(f.running(), 0);
    for (const method of ["tui", "key", "later", "nothing"]) {
      assert.equal((await refused(() => f.signIn(method))).reason, "unknown_sign_in_method", method);
    }
    assert.equal(f.running(), 0);
  });

  it("a sign-in can be ended, and another way takes its place", async () => {
    const f = await setup();
    const waiting = refused(() => f.signIn("browser"));
    await eventually(async () => (await f.lines("authenticate")).length > 0, "authenticate");
    await f.host.deviceService.cancel_sign_in({ id: "fake" }, TUNNEL);
    assert.equal((await waiting).reason, "sign_in_cancelled");
    await eventually(() => f.running() === 0, "the process to end");

    const replaced = refused(() => f.signIn("browser"));
    await eventually(async () => (await f.lines("authenticate")).length > 1, "authenticate");
    assert.equal((await refused(() => f.signIn("broken"))).reason, "sign_in_failed");
    assert.equal((await replaced).reason, "sign_in_cancelled");
  });

  it("an agent that wants it from every process is signed in to again, until that no longer works", async () => {
    const f = await setup();
    await f.signIn("each");
    await f.prepare();
    const saved = async () => (JSON.parse(await readFile(path.join(f.dataDir, "agents.json"), "utf8").catch(() => "{}")) as { agents?: Record<string, unknown> }).agents ?? {};
    await eventually(async () => JSON.stringify(await saved()) === JSON.stringify({ fake: { sign_in: "each" } }), "it to be saved");
    assert.equal(f.entry()?.customized, false);
    // Another change to the agent keeps it.
    await f.host.deviceService.update_agent({ id: "fake", idle_close_minutes: 5 }, TUNNEL);
    assert.deepEqual(await saved(), { fake: { idle_close_minutes: 5, sign_in: "each" } });
    await f.host.deviceService.update_agent({ id: "fake", idle_close_minutes: 0 }, TUNNEL);
    await f.host.deviceService.stop_agent({ id: "fake" }, TUNNEL);
    await f.prepare();
    assert.deepEqual(await f.lines("authenticate"), ["each", "each"]);
    assert.equal((await f.lines("spawn")).length, 2);

    await f.host.deviceService.stop_agent({ id: "fake" }, TUNNEL);
    await writeFile(`${f.logFile}.expired`, "");
    assert.equal((await refused(f.prepare)).reason, "agent_auth_required");
    assert.equal((await refused(f.prepare)).reason, "agent_auth_required");
    assert.deepEqual(await f.lines("authenticate"), ["each", "each", "each"], "tried once");
    await eventually(async () => !("fake" in (await saved())), "it to be forgotten");
  });

  it("in a terminal: the agent's program with what the method adds, after which a new process is signed in", async () => {
    const f = await setup();
    await refused(f.prepare);
    const terminal = await f.host.deviceService.sign_in_terminal({ id: "fake", method: "tui", cols: 100, rows: 30 }, TUNNEL);
    assert.deepEqual([terminal.cols, terminal.rows], [100, 30]);
    await eventually(() => f.host.terminals.list().find(({ id }) => id === terminal.id)?.running === false, "the terminal to end");
    assert.equal(f.host.terminals.list().find(({ id }) => id === terminal.id)?.exit_code, 0);
    const [ran] = (await f.lines("tui")).map((line) => JSON.parse(line) as { args: string[]; env: string; own: string; tty: boolean });
    assert.deepEqual([ran?.args, ran?.env, ran?.own], [["--tui", "now"], "tui", "yes"]);
    await f.prepare();
    const old = await f.host.deviceService.sign_in_terminal({ id: "fake", method: "old" }, TUNNEL);
    await eventually(() => f.host.terminals.list().find(({ id }) => id === old.id)?.running === false, "the terminal to end");
    assert.deepEqual((await f.lines("tui")).map((line) => (JSON.parse(line) as { args: string[] }).args), [["--tui", "now"], ["--tui", "old"]]);
    assert.equal((await refused(() => f.host.deviceService.sign_in_terminal({ id: "fake", method: "browser" }, TUNNEL))).reason, "unknown_sign_in_method");
  });

  it("only from a client over a tunnel, and for an agent that is on", async () => {
    const f = await setup();
    for (const ctx of [CONTROL, MCP]) {
      for (const run of [
        () => f.host.deviceService.sign_in_agent({ id: "fake", method: "browser" }, ctx),
        () => f.host.deviceService.cancel_sign_in({ id: "fake" }, ctx),
        () => f.host.deviceService.sign_in_terminal({ id: "fake", method: "tui" }, ctx),
      ]) {
        assert.equal((await refused(run)).code, "permission_denied");
      }
    }
    await f.host.deviceService.update_agent({ id: "fake", enabled: false }, TUNNEL);
    assert.equal((await refused(() => f.signIn("browser"))).reason, "agent_disabled");
    assert.deepEqual(await f.lines("spawn"), []);
  });
});

describe("the ways to sign in", () => {
  it("its program's own sign-in is added only when the agent offers none for a terminal", () => {
    const program = { command: "/usr/local/bin/cursor-agent", args: ["login"] };
    const own = { id: PROGRAM_SIGN_IN, name: "cursor-agent login", kind: "terminal" };
    assert.deepEqual(signInMethods([], program), [own]);
    assert.deepEqual(signInMethods([{ id: "a", name: "A", description: null }], program), [{ id: "a", name: "A", kind: "agent" }, own]);
    assert.deepEqual(signInMethods([{ id: "t", name: "T", type: "terminal" }], program), [{ id: "t", name: "T", kind: "terminal" }]);
    assert.equal(signInMethods([], { command: "C:\\bin\\grok.cmd", args: ["login"] })[0]?.name, "grok login");
    assert.deepEqual(signInMethods([], undefined), []);
    assert.deepEqual(offeredMethods({ id: "x" }), []);
    assert.deepEqual(offeredMethods([null, { id: "" , name: "" }, { id: "ok", name: "OK" }]), [{ id: "ok", name: "OK" }]);
  });

  it("catalog sign-ins are plain arguments", () => {
    for (const agent of AGENT_CATALOG) for (const arg of agent.login ?? []) assert.match(arg, /^-{0,2}[a-z][a-z-]*$/u, agent.id);
  });

  it("an agent's error is told once, with the reason it gives", () => {
    const text = (message: string, data?: unknown) => agentErrorText(new AcpRequestError(-32000, message, data));
    assert.equal(text("Authentication required", { message: "Authentication required. Run x login." }), "Authentication required. Run x login.");
    assert.equal(text("Internal error", { details: "No such provider." }), "Internal error (No such provider.)");
    assert.equal(text("Internal error: No such provider.", { details: "No such provider." }), "Internal error: No such provider.");
    assert.equal(text("Internal error", "No provider."), "Internal error (No provider.)");
    assert.equal(text("Nope", { message: 3 }), "Nope");
    assert.equal(text("Nope", null), "Nope");
  });
});
