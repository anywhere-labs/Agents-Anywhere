// Agents the user added (`aa.v3.Device/add_agent`, `update_agent`, `remove_agent`) on a real `ConnectorHost`
// (initialized, not serving), each a script around a stdio ACP agent.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import { AGENT_CATALOG } from "../src/core/agent-catalog.js";
import { CUSTOM_AGENT_ID_PREFIX } from "../src/core/config.js";
import { ConnectorHost } from "../src/host/connector-host.js";
import type { AgentEntry } from "../src/rpc/device-service.js";
import { AgentFinder } from "../src/runtime/agent-finder.js";

function context(fields: Record<string, unknown>): RpcContext {
  return { metadata: {}, tunnel: null, e2e: null, idempotencyKey: undefined, remainingMs: () => null, signal: new AbortController().signal, ...fields } as unknown as RpcContext;
}
const TUNNEL = context({ tunnel: { id: "tun_1", principal: "user:1/client:web" } });
const CONTROL = context({ metadata: { "aa-via": "client", "aa-on-behalf-of": "user:1" } });
const MCP = context({ metadata: { "aa-via": "mcp", "aa-on-behalf-of": "user:1", "aa-mcp-client": "cursor" } });
const SECRET = "sk-aa-custom-secret";

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

async function eventually<T>(read: () => T | undefined | false, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A prompt "slow" is answered only when it is cancelled.
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, ...flags] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ flags, token: process.env.TOKEN || null, extra: process.env.EXTRA || null }) + "\n");
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let created = 0;
const waiting = new Map();
function handle(msg) {
  if (msg.method === "session/cancel") { const id = waiting.get(msg.params.sessionId); waiting.delete(msg.params.sessionId); if (id !== undefined) out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } }); return; }
  if (msg.method === undefined || msg.id === undefined) return;
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
    case "session/new": return reply({ sessionId: "acp-" + process.pid + "-" + ++created });
    case "session/prompt":
      if (msg.params.prompt[0].text === "slow") { waiting.set(msg.params.sessionId, msg.id); return; }
      return reply({ stopReason: "end_turn" });
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
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let root: string;
const hosts: ConnectorHost[] = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aa-custom-"));
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(path.join(root, "device-"));
  const [bin, home, project] = [path.join(dir, "bin"), path.join(dir, "home"), path.join(dir, "project")];
  for (const each of [bin, home, project]) await mkdir(each);
  const agentScript = path.join(dir, "agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const put = async (file: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `#!/bin/sh\nexec '${process.execPath}' '${agentScript}' '${logFile}' "$@"\n`);
    await chmod(file, 0o755);
    return file;
  };
  await put(path.join(bin, "my-agent"));
  const logs: string[] = [];
  const start = async (): Promise<ConnectorHost> => {
    const host = new ConnectorHost({
      dataDir: path.join(dir, "state"),
      deviceId: "dev_custom",
      catalog: [{ id: "known", name: "Known Agent", website: "https://known.example", programs: ["known-agent"], args: [], install: [] }],
      finder: new AgentFinder({ env: { PATH: bin }, home, usualFolders: ["/usr/bin", "/bin"], folders: [], readShellPath: async () => undefined }),
      waitTimeoutMs: 5_000,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    hosts.push(host);
    await host.init();
    return host;
  };
  const host = await start();
  const file = path.join(dir, "state", "custom-agents.json");
  return {
    host,
    restart: async () => {
      await hosts.splice(hosts.indexOf(host), 1)[0]?.stop();
      return start();
    },
    device: host.deviceService,
    sessions: host.sessionsService,
    bin,
    home,
    project,
    put,
    logs,
    file,
    list: (of = host): AgentEntry[] => of.deviceService.agents({}, TUNNEL).agents,
    saved: async () => (JSON.parse(await readFile(file, "utf8")) as { agents: unknown[] }).agents,
    spawns: async () =>
      (await readFile(logFile, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { flags: string[]; token: string | null; extra: string | null }),
  };
}

describe("agents the user added", { skip: process.platform === "win32" }, () => {
  it("are offered like the others and run as they were entered; their variables never leave the device", async () => {
    const f = await setup();
    const entry = await f.device.add_agent({ name: " My Agent ", command: "my-agent", args: ["acp", "--quiet mode"], env: { TOKEN: SECRET } }, TUNNEL);
    assert.deepEqual(
      [entry.id, entry.name, entry.custom, entry.builtin, entry.enabled, entry.installed, entry.customized, entry.command, entry.args, entry.env_keys, entry.install],
      ["custom-my-agent", "My Agent", true, false, true, true, false, "my-agent", ["acp", "--quiet mode"], ["TOKEN"], undefined],
    );
    assert.ok(f.device.status({}, TUNNEL).runtimes.some((runtime) => runtime.id === entry.id && runtime.name === "My Agent"));
    await f.sessions.create({ agent: entry.id, cwd: f.project }, TUNNEL);
    assert.deepEqual(await f.spawns(), [{ flags: ["acp", "--quiet mode"], token: SECRET, extra: null }]);

    assert.deepEqual(await f.saved(), [{ id: "custom-my-agent", name: "My Agent", command: "my-agent", args: ["acp", "--quiet mode"], env: { TOKEN: SECRET } }]);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify([f.list(), entry, f.logs]).includes(SECRET), false);
    assert.ok(f.logs.includes("agent custom-my-agent added"));

    const again = await f.restart();
    assert.deepEqual(f.list(again).map((agent) => [agent.id, agent.custom, agent.installed]), [["known", undefined, false], ["custom-my-agent", true, true]]);
  });

  it("get ids of their own, none of the Connector's; a name is used once", async () => {
    const f = await setup();
    const add = (name: string) => f.device.add_agent({ name, command: "my-agent" }, TUNNEL);
    assert.equal((await add("Claude")).id, "custom-claude");
    assert.equal((await add("智能体")).id, "custom-agent");
    assert.equal((await add("助手")).id, "custom-agent-2");
    assert.equal((await add(`${"long ".repeat(20)}name`)).id.length <= 64, true);
    await refusedWith(() => add("claude"), "invalid_argument", "agent_name_taken");
    await refusedWith(() => add("known AGENT"), "invalid_argument", "agent_name_taken");
    assert.equal(AGENT_CATALOG.some((agent) => agent.id.startsWith(CUSTOM_AGENT_ID_PREFIX)), false);
  });

  it("need a command that is there: by name, by path or below the home folder", async () => {
    const f = await setup();
    for (const command of ["no-such-agent", "/opt/no-such-agent", "~/no-such-agent"]) {
      await refusedWith(() => f.device.add_agent({ name: "Nope", command }, TUNNEL), "invalid_argument", "command_not_found");
    }
    const file = await f.put(path.join(f.home, "tools", "home-agent"));
    assert.equal((await f.device.add_agent({ name: "By path", command: file }, TUNNEL)).installed, true);
    const home = await f.device.add_agent({ name: "Below home", command: "~/tools/home-agent", args: ["below-home"] }, TUNNEL);
    await f.sessions.create({ agent: home.id, cwd: f.project }, TUNNEL);
    assert.deepEqual((await f.spawns()).map((spawn) => spawn.flags), [["below-home"]]);

    // Gone later: shown as not there, and not used, until it is back.
    await rm(file);
    const after = (await f.device.refresh_agents({}, TUNNEL)).agents;
    assert.deepEqual(after.filter((agent) => agent.custom).map((agent) => agent.installed), [false, false]);
    await refusedWith(() => f.sessions.create({ agent: "custom-by-path", cwd: f.project }, TUNNEL), "failed_precondition", "agent_not_installed");
    await f.put(file);
    assert.deepEqual((await f.device.refresh_agents({}, TUNNEL)).agents.filter((agent) => agent.custom).map((agent) => agent.installed), [true, true]);
  });

  it("are changed themselves: name, command, arguments and variables", async () => {
    const f = await setup();
    await f.device.add_agent({ name: "Mine", command: "my-agent", args: ["one"], env: { TOKEN: SECRET, EXTRA: "x" } }, TUNNEL);
    await f.sessions.create({ agent: "custom-mine", cwd: f.project }, TUNNEL);
    const entry = await f.device.update_agent({ id: "custom-mine", name: "Mine 2", args: ["two"], env: { EXTRA: null } }, TUNNEL);
    assert.deepEqual([entry.name, entry.args, entry.env_keys, entry.customized], ["Mine 2", ["two"], ["TOKEN"], false]);
    assert.deepEqual(await f.saved(), [{ id: "custom-mine", name: "Mine 2", command: "my-agent", args: ["two"], env: { TOKEN: SECRET } }]);
    await f.sessions.create({ agent: "custom-mine", cwd: f.project }, TUNNEL);
    assert.deepEqual((await f.spawns()).map((spawn) => [spawn.flags, spawn.token, spawn.extra]), [[["one"], SECRET, "x"], [["two"], SECRET, null]]);

    // Its own name in another case is no one else's; a switch is kept apart, and nothing else has a name.
    assert.equal((await f.device.update_agent({ id: "custom-mine", name: "MINE 2", enabled: false }, TUNNEL)).name, "MINE 2");
    await refusedWith(() => f.device.update_agent({ id: "custom-mine", name: "Known agent" }, TUNNEL), "invalid_argument", "agent_name_taken");
    await refusedWith(() => f.device.update_agent({ id: "custom-mine", command: "no-such-agent" }, TUNNEL), "invalid_argument", "command_not_found");
    assert.equal((await f.device.update_agent({ id: "known", name: "Renamed" }, TUNNEL)).name, "Known Agent");
    const again = await f.restart();
    assert.deepEqual(f.list(again).filter((agent) => agent.custom).map((agent) => [agent.name, agent.enabled, agent.args]), [["MINE 2", false, ["two"]]]);
  });

  it("are removed with their processes and settings; their conversations stay, and replying ones are asked about first", async () => {
    const f = await setup();
    await f.device.add_agent({ name: "Mine", command: "my-agent" }, TUNNEL);
    await f.device.update_agent({ id: "custom-mine", idle_close_minutes: 30 }, TUNNEL);
    const session = await f.sessions.create({ agent: "custom-mine", cwd: f.project }, TUNNEL);
    await f.sessions.send({ id: session.id, text: "slow" }, TUNNEL);
    await eventually(() => f.list().find((agent) => agent.id === "custom-mine")?.busy === 1, "it replies");
    await refusedWith(() => f.device.remove_agent({ id: "custom-mine" }, TUNNEL), "failed_precondition", "turns_running");
    assert.deepEqual(await f.device.remove_agent({ id: "custom-mine", force: true }, TUNNEL), { removed: true });
    assert.deepEqual(f.list().map((agent) => agent.id), ["known"]);
    assert.deepEqual([await f.saved(), f.host.store.get(session.id)?.agent], [[], "custom-mine"]);
    await refusedWith(() => f.sessions.send({ id: session.id, text: "hello" }, TUNNEL), "invalid_argument", "unknown_agent");
    assert.ok(f.logs.includes("agent custom-mine removed"));

    await refusedWith(() => f.device.remove_agent({ id: "known" }, TUNNEL), "failed_precondition", "agent_not_custom");
    await refusedWith(() => f.device.remove_agent({ id: "custom-mine" }, TUNNEL), "invalid_argument", "unknown_agent");
    // Added again under its name, its conversations go on, with nothing of the old settings.
    const back = await f.device.add_agent({ name: "Mine", command: "my-agent" }, TUNNEL);
    assert.deepEqual([back.id, back.idle_close_minutes], ["custom-mine", 0]);
    await f.sessions.send({ id: session.id, text: "hello" }, TUNNEL);
  });

  it("only a client over a tunnel may add or remove one", async () => {
    const f = await setup();
    const runs = (ctx: RpcContext) => [
      () => f.device.add_agent({ name: "Mine", command: "my-agent" }, ctx),
      () => f.device.remove_agent({ id: "known" }, ctx),
    ];
    for (const run of runs(CONTROL)) await refusedWith(run, "permission_denied", "tunnel_required");
    f.host.gate.allowMcp = true;
    for (const run of runs(MCP)) await refusedWith(run, "permission_denied", "mcp_not_allowed");
    assert.deepEqual(f.list().map((agent) => agent.id), ["known"]);
  });
});
