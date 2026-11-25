// The agents the Connector knows (`core/agent-catalog.ts`): which are installed (`runtime/agent-finder.ts`), how they
// are installed (`runtime/agent-installer.ts`), and what that means for a device: on a real `ConnectorHost`
// (initialized, not serving; the services are called directly) with a small catalog of its own, whose agent is a shell
// script around a stdio ACP agent.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { MeshCallError, type RpcContext } from "meshcall";

import { AGENT_CATALOG, agentFolders, installMethods, launcherOf, presetOf, programEnv, type CatalogAgent } from "../src/core/agent-catalog.js";
import { ConnectorHost, type ConnectorHostOptions } from "../src/host/connector-host.js";
import type { AgentEntry } from "../src/rpc/device-service.js";
import { AgentFinder } from "../src/runtime/agent-finder.js";
import { AgentInstaller, cleanOutput } from "../src/runtime/agent-installer.js";
import { spawnCommand } from "../src/runtime/process-tree.js";

const POSIX = { skip: process.platform === "win32" };

function context(fields: Record<string, unknown>): RpcContext {
  return { metadata: {}, tunnel: null, e2e: null, idempotencyKey: undefined, remainingMs: () => null, signal: new AbortController().signal, ...fields } as unknown as RpcContext;
}
/** A client through a plain tunnel (normal device). */
const TUNNEL = context({ tunnel: { id: "tun_1", principal: "user:1/client:web" } });
/** The control plane calling the device directly on behalf of a user. */
const CONTROL = context({ metadata: { "aa-via": "client", "aa-on-behalf-of": "user:1" } });
/** An external agent through the control plane's MCP tools. */
const MCP = context({ metadata: { "aa-via": "mcp", "aa-on-behalf-of": "user:1", "aa-mcp-client": "cursor" } });

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

async function refusedWith(run: () => unknown, code: string, reason: string): Promise<MeshCallError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof MeshCallError, `expected a MeshCallError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.details?.reason, reason);
    return error;
  }
  return assert.fail("expected a refusal");
}

let root: string;
const hosts: ConnectorHost[] = [];

before(async () => {
  // The real path: macOS has its temporary folder behind a link.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "aa-v3-catalog-")));
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop().catch(() => undefined)));
});

const folder = async (...parts: string[]) => {
  const dir = path.join(root, ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
};

async function program(file: string, body = "exit 0", mode = 0o755): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, mode);
  return file;
}

describe("the catalog", () => {
  it("names every agent once, with a program, a way to start it and official ways to install it", () => {
    const ids = AGENT_CATALOG.map((agent) => agent.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(AGENT_CATALOG.map((agent) => agent.name.toLowerCase())).size, ids.length);
    const programs = AGENT_CATALOG.flatMap((agent) => agent.programs);
    assert.equal(new Set(programs).size, programs.length, "a program belongs to one agent");
    for (const agent of AGENT_CATALOG) {
      assert.match(agent.id, /^[a-z][a-z0-9-]*$/u);
      assert.match(agent.website, /^https:\/\//u, agent.id);
      assert.ok(agent.programs.length > 0, agent.id);
      assert.ok(agent.adapter !== undefined || agent.args !== undefined, agent.id);
      for (const platform of ["macos", "linux", "windows"] as const) {
        const methods = installMethods(agent, platform);
        if (platform !== "windows") assert.ok(methods.length > 0, `${agent.id} on ${platform}`);
        assert.equal(new Set(methods.map((m) => m.id)).size, methods.length, `${agent.id} on ${platform}`);
        for (const method of methods) {
          assert.ok(!/\n/u.test(method.command), agent.id);
          assert.ok(!/\bsudo\b/u.test(method.command), `${agent.id}: nothing may ask for a password`);
          assert.ok(!/http:\/\//u.test(method.command), agent.id);
        }
      }
    }
  });

  it("still has the agents there were, started as before, in the same order", () => {
    assert.deepEqual(AGENT_CATALOG.slice(0, 4).map((agent) => agent.id), ["claude", "codex", "antigravity", "pi"]);
    const preset = (id: string) => presetOf(AGENT_CATALOG.find((agent) => agent.id === id) as CatalogAgent);
    assert.deepEqual(preset("claude"), { id: "claude", name: "Claude Code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] });
    assert.deepEqual(preset("codex"), { id: "codex", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] });
    assert.deepEqual(preset("antigravity"), { id: "antigravity", name: "Antigravity", command: "agy", args: ["acp"] });
    // Pi without its startup banner, which would otherwise show up as a reply.
    assert.deepEqual(preset("pi"), { id: "pi", name: "Pi", command: "npx", args: ["-y", "@openma/pi-acp", "--quiet-startup"], approvals: "pi" });
  });

  it("runs the program the user named: as the command, or through the adapter's own variable", () => {
    const own: CatalogAgent = { id: "own", name: "Own", website: "https://own.example", programs: ["own"], args: ["acp"], install: [] };
    assert.equal(launcherOf(own), undefined);
    assert.deepEqual([presetOf(own, "/opt/own").command, programEnv(own, "/opt/own")], ["/opt/own", {}]);
    const adapted: CatalogAgent = { id: "adapted", name: "Adapted", website: "https://a.example", programs: ["adapted"], adapter: "adapted-acp", programEnv: "ADAPTED", install: [] };
    assert.equal(launcherOf(adapted), "npx");
    assert.deepEqual([presetOf(adapted, "/opt/a").command, programEnv(adapted, "/opt/a"), programEnv(adapted, undefined)], ["npx", { ADAPTED: "/opt/a" }, {}]);
  });
});

describe("looking for programs", POSIX, () => {
  it("searches PATH, then the login shell's PATH, then the usual folders; a file that cannot be run does not count", async () => {
    const [onPath, shell, home] = [await folder("find", "path"), await folder("find", "shell"), await folder("find", "home")];
    const finder = new AgentFinder({
      env: { PATH: `${onPath}:relative:` },
      home,
      usualFolders: ["~/.local/bin"],
      folders: ["~/.own/bin", "~/.versions/*/bin"],
      readShellPath: async () => `${shell}:${onPath}`,
    });
    assert.deepEqual(finder.folders, [onPath, path.join(home, ".local/bin"), path.join(home, ".own/bin")]);
    await program(path.join(home, ".local/bin", "a"));
    await program(path.join(home, ".own/bin", "b"));
    await program(path.join(shell, "a"));
    await program(path.join(onPath, "b"), "exit 0", 0o644);
    await mkdir(path.join(onPath, "a"));

    assert.equal(finder.find(["a"]), path.join(home, ".local/bin", "a"), "a folder named so is no program");
    assert.equal(finder.find(["b"]), path.join(home, ".own/bin", "b"), "nor is a file without the permission");
    assert.equal(finder.find(["c"]), undefined);
    await finder.refresh();
    assert.equal(finder.find(["a"]), path.join(shell, "a"), "the login shell's PATH comes before the usual folders");
    assert.deepEqual(finder.path.split(":").slice(0, 2), [onPath, shell]);

    // Newer versions first; what is installed meanwhile is seen by the next look.
    await program(path.join(home, ".versions/v9.1.0/bin", "c"));
    await program(path.join(home, ".versions/v24.2.0/bin", "c"));
    assert.equal(finder.find(["c"]), undefined, "the folders as they were");
    finder.rescan();
    assert.equal(finder.find(["c"]), path.join(home, ".versions/v24.2.0/bin", "c"));
    assert.equal(finder.find(["nope", "a"]), path.join(shell, "a"), "the first name that is there");
  });

  it("resolves commands: names by looking, paths as they are, ~ as the home folder", async () => {
    const home = await folder("resolve", "home");
    const tool = await program(path.join(home, "tools", "tool"));
    const finder = new AgentFinder({ env: { PATH: path.dirname(tool) }, home, usualFolders: [], readShellPath: async () => undefined });
    assert.equal(finder.resolve("tool"), tool);
    assert.equal(finder.resolve("~/tools/tool"), tool);
    assert.equal(finder.resolve(tool), tool);
    assert.equal(finder.resolve("~/tools"), undefined);
    assert.equal(finder.resolve("~/tools/none"), undefined);
  });

  it("keeps what it knew when the login shell does not answer", async () => {
    const shell = await folder("keeps", "shell");
    let answers = true;
    const finder = new AgentFinder({ env: { PATH: "" }, home: root, usualFolders: [], readShellPath: () => (answers ? Promise.resolve(shell) : Promise.reject(new Error("no"))) });
    await finder.refresh();
    answers = false;
    await finder.refresh();
    assert.deepEqual(finder.folders, [shell]);
  });

  it("asks a real login shell", async () => {
    const home = await folder("login", "home");
    const extra = await folder("login", "extra");
    // Something a profile prints does not end up in the PATH.
    for (const file of [".bash_profile", ".bashrc", ".profile"]) await writeFile(path.join(home, file), `echo hello from the profile\nexport PATH="${extra}:$PATH"\n`);
    const finder = new AgentFinder({ env: { PATH: "/usr/bin:/bin", HOME: home, SHELL: "/bin/bash" }, home, usualFolders: [] });
    await finder.refresh();
    assert.ok(finder.folders.includes(extra), finder.path);
    assert.ok(!finder.path.includes("hello"), finder.path);
  });
});

describe("looking for programs on Windows", () => {
  it("has the folders of Path and of environment variables", () => {
    const finder = new AgentFinder({
      platform: "win32",
      env: { Path: "C:\\Windows;C:\\Tools\\", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      home: "C:\\Users\\me",
      usualFolders: ["~/.local/bin", "%APPDATA%/npm", "%NOT_SET%/bin"],
      readShellPath: async () => undefined,
    });
    assert.deepEqual(finder.folders, ["C:\\Windows", "C:\\Tools\\", "C:\\Users\\me\\.local\\bin", "C:\\Users\\me\\AppData\\Roaming\\npm"]);
  });

  it("runs .cmd files through cmd.exe with everything quoted, other programs as they are", () => {
    assert.deepEqual(spawnCommand("/usr/bin/agent", ["a b"], "linux"), { command: "/usr/bin/agent", args: ["a b"], verbatim: false });
    assert.deepEqual(spawnCommand("C:\\agent.exe", ["a b"], "win32"), { command: "C:\\agent.exe", args: ["a b"], verbatim: false });
    assert.deepEqual(spawnCommand("C:\\Program Files\\nodejs\\npx.cmd", ["-y", 'a"b', "50%"], "win32", "C:\\cmd.exe"), {
      command: "C:\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"a\\^^^"b^^^" ^^^"50^^^%^^^""'],
      verbatim: true,
    });
  });
});

describe("installing", POSIX, () => {
  const make = (options: Partial<ConstructorParameters<typeof AgentInstaller>[0]> = {}) => new AgentInstaller({ path: () => "/usr/bin:/bin", ...options });
  const ended = (installer: AgentInstaller, agent: string, timeoutMs = 10_000) =>
    eventually(() => {
      const job = installer.job(agent);
      return job !== undefined && job.state !== "waiting" && job.state !== "running" ? job : undefined;
    }, `the install of ${agent} to end`, timeoutMs);

  it("runs the command without a terminal, with the given PATH, in a folder that is gone afterwards; keeps the end of its output", async () => {
    const installer = make();
    installer.start("a", "script", 'echo "$PATH|$CI"; pwd; touch leftover; if read -r line; then echo "read $line"; fi; printf "\\033[32mgreen\\033[0m\\n10%%\\r55%%\\r100%%\\n"');
    const job = await ended(installer, "a");
    assert.equal(job.state, "succeeded");
    assert.equal(job.exitCode, 0);
    const [first, cwd, ...rest] = job.output.split("\n");
    assert.equal(first, "/usr/bin:/bin|1");
    assert.deepEqual(rest, ["green", "100%"]);
    assert.ok(cwd && !existsSync(cwd), `${cwd} removed`);
    assert.ok((job.endedAt ?? 0) >= job.startedAt);
  });

  it("one after another; one that waits or runs is not started twice", async () => {
    const installer = make();
    const file = path.join(root, "order.log");
    installer.start("a", "script", `sleep 0.3; echo a >> '${file}'`);
    installer.start("b", "npm", `echo b >> '${file}'`);
    await eventually(() => installer.job("a")?.state === "running", "a runs");
    assert.equal(installer.job("b")?.state, "waiting");
    assert.equal(installer.start("a", "npm", "echo again").command, `sleep 0.3; echo a >> '${file}'`);
    await ended(installer, "b");
    assert.equal(await readFile(file, "utf8"), "a\nb\n");
    // Done: it can be installed again.
    assert.equal(installer.start("a", "npm", "echo again").state, "waiting");
    assert.equal((await ended(installer, "a")).output, "again");
  });

  it("fails with what it printed and its exit code, or the time it took", async () => {
    const installer = make({ timeoutMs: 400 });
    installer.start("a", "script", "echo out; echo problem >&2; exit 3");
    const failed = await ended(installer, "a");
    assert.deepEqual([failed.state, failed.exitCode], ["failed", 3]);
    assert.match(failed.output, /problem/u);
    installer.start("b", "script", "sleep 30");
    const late = await ended(installer, "b");
    assert.equal(late.state, "failed");
    assert.match(late.error ?? "", /^stopped after/u);
    assert.equal(late.exitCode, undefined);
  });

  it("succeeds when the agent is there although its installer failed afterwards", async () => {
    const there = new Set<string>();
    const installer = make({ isInstalled: async (agent) => there.has(agent) });
    there.add("a");
    installer.start("a", "script", "echo installed; exit 1");
    const job = await ended(installer, "a");
    assert.deepEqual([job.state, job.exitCode], ["succeeded", 1]);
    installer.start("b", "script", "exit 1");
    assert.equal((await ended(installer, "b")).state, "failed");
  });

  it("is cancelled with everything it started, waiting ones too; stop cancels all", async () => {
    const installer = make();
    const file = path.join(root, "child.pid");
    installer.start("a", "script", `sleep 60 & echo $! > '${file}'; wait`);
    installer.start("b", "script", "echo b");
    const pid = Number(await eventually(async () => (existsSync(file) ? (await readFile(file, "utf8")).trim() || undefined : undefined), "the child's pid"));
    await installer.cancel("b");
    assert.equal(installer.job("b")?.state, "cancelled");
    await installer.cancel("a");
    assert.equal(installer.job("a")?.state, "cancelled");
    await eventually(() => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }, "the child ended");
    await installer.cancel("a"); // ended already: nothing
    await installer.cancel("unknown");

    installer.start("c", "script", "sleep 60");
    installer.start("d", "script", "sleep 60");
    await eventually(() => installer.job("c")?.state === "running", "c runs");
    await installer.stop();
    assert.deepEqual([installer.job("c")?.state, installer.job("d")?.state], ["cancelled", "cancelled"]);
  });

  it("shows output as a terminal ends up showing it", () => {
    assert.equal(cleanOutput("\u001b]0;title\u0007\u001b[1;32m✓\u001b[0m done\r\n"), "✓ done");
    assert.equal(cleanOutput("##  10%\r###  55%\r#### 100%\nnext"), "#### 100%\nnext");
    assert.equal(cleanOutput("a\n\n\n\n\nb\u0008\u0000"), "a\n\nb");
    assert.equal(cleanOutput("\u001b[?25l⠋ Working\r\u001b[K"), "⠋ Working");
  });
});

// ── On a device ──

const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const [log, ...flags] = process.argv.slice(2);
fs.appendFileSync(log, "spawn " + JSON.stringify({ flags, adapted: process.env.ADAPTED_PROGRAM || null, path: process.env.PATH }) + "\n");
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let created = 0;
function handle(msg) {
  if (msg.method === undefined || msg.id === undefined) return;
  const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } });
    case "session/new": return reply({ sessionId: "acp-" + process.pid + "-" + ++created });
    case "session/prompt":
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
      return reply({ stopReason: "end_turn" });
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

/** A device with three agents in its catalog: `own` speaks ACP itself, `adapted` through `npx`, `other` is never there. */
async function setup(options: { installed?: string[]; host?: Partial<ConnectorHostOptions> } = {}) {
  const dir = await mkdtemp(path.join(root, "device-"));
  const [bin, home, project] = [path.join(dir, "bin"), path.join(dir, "home"), path.join(dir, "project")];
  for (const each of [bin, home, project]) await mkdir(each);
  const agentScript = path.join(dir, "agent.cjs");
  await writeFile(agentScript, FAKE_AGENT);
  const logFile = path.join(dir, "agent.log");
  await writeFile(logFile, "");
  const body = `exec '${process.execPath}' '${agentScript}' '${logFile}' "$@"`;
  const put = (name: string, where = bin) => program(path.join(where, name), body);
  // Stands in for npx: it is given `-y <package>` and runs the fake agent.
  for (const name of options.installed ?? []) await put(name);
  const staged = await put("own-agent", path.join(dir, "staged"));
  const catalog: CatalogAgent[] = [
    {
      id: "own",
      name: "Own Agent",
      website: "https://own.example",
      programs: ["own-agent"],
      args: ["acp"],
      env: { OWN_UPDATES: "off" },
      install: [
        { id: "script", platforms: ["macos", "linux"], command: `echo fetching; sleep 0.2; cp '${staged}' '${bin}/own-agent'; echo done` },
        { id: "brew", platforms: ["macos", "linux"], command: "brew install own", needs: "aa-no-such-program" },
        { id: "script", platforms: ["windows"], command: "exit 0" },
      ],
    },
    { id: "adapted", name: "Adapted", website: "https://adapted.example", programs: ["adapted-agent"], adapter: "adapted-acp", programEnv: "ADAPTED_PROGRAM", install: [] },
    { id: "other", name: "Other", website: "https://other.example", programs: ["other-agent"], args: [], install: [{ id: "script", platforms: ["macos", "linux"], command: "echo 'no luck' >&2; exit 7" }] },
  ];
  const logs: string[] = [];
  const finder = new AgentFinder({ env: { PATH: bin }, home, usualFolders: ["/usr/bin", "/bin"], folders: agentFolders(catalog), readShellPath: async () => undefined });
  const host = new ConnectorHost({
    dataDir: path.join(dir, "state"),
    deviceId: "dev_catalog",
    catalog,
    finder,
    waitTimeoutMs: 5_000,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...options.host,
  });
  hosts.push(host);
  await host.init();
  const entry = (id: string): AgentEntry => {
    const found = host.deviceService.agents({}, TUNNEL).agents.find((agent) => agent.id === id);
    assert.ok(found, `agent ${id} listed`);
    return found;
  };
  return {
    host,
    device: host.deviceService,
    sessions: host.sessionsService,
    dir,
    bin,
    home,
    project,
    put,
    logs,
    entry,
    runtimes: () => host.deviceService.status({}, TUNNEL).runtimes.map((runtime) => runtime.id),
    spawns: async () =>
      (await readFile(logFile, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("spawn "))
        .map((line) => JSON.parse(line.slice("spawn ".length)) as { flags: string[]; adapted: string | null; path: string }),
  };
}

describe("agents of the catalog on a device", POSIX, () => {
  it("lists every agent, installed or not; only installed ones can be used", async () => {
    const f = await setup({ installed: ["own-agent"] });
    assert.deepEqual(f.device.agents({}, TUNNEL).agents.map((a) => [a.id, a.installed, a.enabled, a.builtin]), [
      ["own", true, true, true],
      ["adapted", false, true, true],
      ["other", false, true, true],
    ]);
    const own = f.entry("own");
    assert.deepEqual([own.program, own.program_set, own.command, own.args, own.env_keys, own.website], [path.join(f.bin, "own-agent"), undefined, "own-agent", ["acp"], ["OWN_UPDATES"], "https://own.example"]);
    assert.deepEqual(own.install?.methods.map(({ id, available, needs }) => [id, available, needs]), [["script", true, undefined], ["brew", false, "aa-no-such-program"]]);
    assert.deepEqual(f.runtimes(), ["own"]);
    assert.deepEqual(f.host.presenceSummary().runtimes, ["own"]);

    for (const run of [
      () => f.sessions.create({ agent: "other", cwd: f.project }, TUNNEL),
      () => f.sessions.prepare({ agent: "other", cwd: f.project }, TUNNEL),
      () => f.device.update_agent({ id: "other", enabled: true }, TUNNEL),
    ]) {
      const error = await refusedWith(run, "failed_precondition", "agent_not_installed");
      assert.equal(error.message, "Other is not installed on this device");
    }
    assert.equal(f.host.store.list().sessions.length, 0);

    const session = await f.sessions.create({ agent: "own", cwd: f.project }, TUNNEL);
    const reply = await f.sessions.send({ id: session.id, client_msg_id: "m1", content: "hi", wait: true }, TUNNEL);
    assert.equal((reply as { reply_text?: string }).reply_text, "hello");
    const [spawned] = await f.spawns();
    assert.deepEqual(spawned?.flags, ["acp"]);
    assert.equal(spawned?.path.split(":")[0], f.bin, "the agent finds what AA finds");
  });

  it("an agent behind npx needs npx, too", async () => {
    const f = await setup({ installed: ["adapted-agent"] });
    const without = f.entry("adapted");
    assert.deepEqual([without.installed, without.program, without.missing], [false, path.join(f.bin, "adapted-agent"), "npx"]);
    const error = await refusedWith(() => f.sessions.create({ agent: "adapted", cwd: f.project }, TUNNEL), "failed_precondition", "agent_not_installed");
    assert.equal(error.message, "Adapted needs npx, which is not installed on this device");

    await f.put("npx");
    const { agents } = await f.device.refresh_agents({}, TUNNEL);
    assert.deepEqual(agents.find((a) => a.id === "adapted")?.installed, true);
    await f.sessions.create({ agent: "adapted", cwd: f.project }, TUNNEL);
    assert.deepEqual((await f.spawns())[0]?.flags, ["-y", "adapted-acp"]);
  });

  it("notices what is installed or removed outside AA", async () => {
    const f = await setup();
    assert.deepEqual(f.runtimes(), []);
    await f.put("own-agent");
    assert.equal((await f.device.refresh_agents({}, TUNNEL)).agents.find((a) => a.id === "own")?.installed, true);
    assert.ok(f.logs.includes("agents that can be used here: own"), f.logs.join("\n"));
    const session = await f.sessions.create({ agent: "own", cwd: f.project }, TUNNEL);
    await rm(path.join(f.bin, "own-agent"));
    f.host.runtimes.rescanAgents();
    assert.deepEqual(f.runtimes(), []);
    await refusedWith(() => f.sessions.send({ id: session.id, client_msg_id: "m1", content: "hi" }, TUNNEL), "failed_precondition", "agent_not_installed");
  });

  it("installs one with a fixed command, and it can be used as soon as that is done", async () => {
    const f = await setup();
    const started = await f.device.install_agent({ id: "own", method: "script" }, TUNNEL);
    assert.ok(["waiting", "running"].includes(started.install?.job?.state ?? ""), started.install?.job?.state);
    assert.equal(started.installed, false);
    const done = await eventually(() => (f.entry("own").install?.job?.state === "succeeded" ? f.entry("own") : undefined), "installed");
    assert.equal(done.installed, true);
    assert.equal(done.install?.job?.output, "fetching\ndone");
    assert.deepEqual(f.runtimes(), ["own"]);
    await f.sessions.create({ agent: "own", cwd: f.project }, TUNNEL);

    // A failing one says why; a method it does not have, or that needs something else, is refused.
    await f.device.install_agent({ id: "other", method: "script" }, TUNNEL);
    const failed = await eventually(() => (f.entry("other").install?.job?.state === "failed" ? f.entry("other").install?.job : undefined), "failed");
    assert.deepEqual([failed.exit_code, failed.output], [7, "no luck"]);
    await refusedWith(() => f.device.install_agent({ id: "own", method: "npm" }, TUNNEL), "invalid_argument", "unknown_install_method");
    await refusedWith(() => f.device.install_agent({ id: "nope", method: "script" }, TUNNEL), "invalid_argument", "unknown_agent");
    const needs = await refusedWith(() => f.device.install_agent({ id: "own", method: "brew" }, TUNNEL), "failed_precondition", "install_needs_program");
    assert.equal(needs.details?.program, "aa-no-such-program");
  });

  it("an install can be cancelled", async () => {
    const f = await setup();
    await f.device.install_agent({ id: "own", method: "script" }, TUNNEL);
    await eventually(() => f.entry("own").install?.job?.state === "running", "it runs");
    const cancelled = await f.device.cancel_install({ id: "own" }, TUNNEL);
    assert.equal(cancelled.install?.job?.state, "cancelled");
    assert.equal(cancelled.installed, false);
  });

  it("takes a program the user names when none is found, and goes back to looking", async () => {
    const f = await setup();
    const elsewhere = await f.put("my-own", path.join(f.home, "tools"));
    const notRunnable = path.join(f.home, "tools", "notes.txt");
    await writeFile(notRunnable, "text");
    for (const [bad, reason] of [
      ["tools/my-own", "program_path_relative"],
      [path.join(f.home, "nothing"), "program_not_found"],
      [path.join(f.home, "tools"), "program_not_found"],
      [notRunnable, "program_not_found"],
    ] as const) {
      await refusedWith(() => f.device.update_agent({ id: "own", program: bad }, TUNNEL), "invalid_argument", reason);
    }
    const named = await f.device.update_agent({ id: "own", program: "~/tools/my-own" }, TUNNEL);
    assert.deepEqual([named.installed, named.program, named.program_set, named.command, named.customized], [true, elsewhere, true, elsewhere, false]);
    assert.deepEqual(f.runtimes(), ["own"]);
    const saved = JSON.parse(await readFile(path.join(f.dir, "state", "agents.json"), "utf8")) as { agents: Record<string, unknown> };
    assert.deepEqual(saved.agents.own, { program: elsewhere });
    await f.sessions.create({ agent: "own", cwd: f.project }, TUNNEL);
    assert.equal((await f.spawns()).length, 1);

    // It stays with a reset of how it is started, and wins over one that is found; gone, the one found is used.
    await f.put("own-agent");
    const reset = await f.device.update_agent({ id: "own", args: ["acp", "--x"], reset: true }, TUNNEL);
    assert.deepEqual([reset.program, reset.args], [elsewhere, ["acp", "--x"]]);
    await rm(elsewhere);
    const { agents } = await f.device.refresh_agents({}, TUNNEL);
    const found = agents.find((a) => a.id === "own");
    assert.deepEqual([found?.installed, found?.program, found?.program_set, found?.command], [true, path.join(f.bin, "own-agent"), undefined, "own-agent"]);
    const back = await f.device.update_agent({ id: "own", program: "" }, TUNNEL);
    assert.equal(back.program_set, undefined);
  });

  it("an adapter is told which program to run, and the variable shows up nowhere else", async () => {
    const f = await setup({ installed: ["npx"] });
    const elsewhere = await f.put("my-adapted", path.join(f.home, "tools"));
    const named = await f.device.update_agent({ id: "adapted", program: elsewhere, env: { MINE: "1" } }, TUNNEL);
    assert.deepEqual([named.installed, named.command, named.env_keys], [true, "npx", ["MINE"]]);
    await f.sessions.create({ agent: "adapted", cwd: f.project }, TUNNEL);
    assert.equal((await f.spawns())[0]?.adapted, elsewhere);

    // Another program is another process; the user's own variable of that name wins.
    const other = await f.put("other-adapted", path.join(f.home, "tools"));
    await f.device.update_agent({ id: "adapted", program: other }, TUNNEL);
    await f.sessions.create({ agent: "adapted", cwd: f.project }, TUNNEL);
    assert.equal((await f.spawns())[1]?.adapted, other);
    await f.device.update_agent({ id: "adapted", env: { ADAPTED_PROGRAM: "/opt/mine" } }, TUNNEL);
    await f.sessions.create({ agent: "adapted", cwd: f.project }, TUNNEL);
    assert.equal((await f.spawns())[2]?.adapted, "/opt/mine");
  });

  it("a command of the user's own counts as installed, and an agent of their own with a catalog id is theirs", async () => {
    const f = await setup();
    const mine = await f.put("my-command", path.join(f.home, "tools"));
    const custom = await f.device.update_agent({ id: "other", command: mine }, TUNNEL);
    assert.deepEqual([custom.installed, custom.customized, custom.program], [true, true, undefined]);
    assert.equal((await f.device.update_agent({ id: "other", enabled: false }, TUNNEL)).enabled, false);
    assert.equal((await f.device.update_agent({ id: "other", enabled: true }, TUNNEL)).enabled, true);

    const g = await setup({ host: { presets: [{ id: "own", name: "My Own", command: process.execPath, args: [] }] } });
    const own = g.entry("own");
    assert.deepEqual([own.name, own.builtin, own.installed, own.install, own.program], ["My Own", false, true, undefined, undefined]);
    await refusedWith(() => g.device.update_agent({ id: "own", program: process.execPath }, TUNNEL), "failed_precondition", "agent_not_configurable");
    await refusedWith(() => g.device.install_agent({ id: "own", method: "script" }, TUNNEL), "invalid_argument", "unknown_install_method");
  });

  it("only a client over a tunnel may install, as with other changes to agents", async () => {
    const f = await setup();
    for (const run of [
      () => f.device.install_agent({ id: "own", method: "script" }, CONTROL),
      () => f.device.cancel_install({ id: "own" }, CONTROL),
    ]) await refusedWith(run, "permission_denied", "tunnel_required");
    f.host.gate.allowMcp = true;
    await refusedWith(() => f.device.install_agent({ id: "own", method: "script" }, MCP), "permission_denied", "mcp_not_allowed");
    assert.equal(f.entry("own").install?.job, undefined);
    assert.equal((await f.device.refresh_agents({}, CONTROL)).agents.length, 3);
  });

  it("stops installs when the Connector stops", async () => {
    const f = await setup();
    await f.device.install_agent({ id: "own", method: "script" }, TUNNEL);
    await eventually(() => f.entry("own").install?.job?.state === "running", "it runs");
    await f.host.stop();
    assert.equal(f.entry("own").install?.job?.state, "cancelled");
  });
});
