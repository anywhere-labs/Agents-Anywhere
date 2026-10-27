import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopSettingsStore, NPMMIRROR_PYTHON_BUILDS } from "./desktop-settings";
import { ConnectorSupervisor, type ConnectorChannel } from "./connector-supervisor";
import { bundledPythonExecutable } from "./connector-python";
import { ConnectorLogStore } from "./log-store";
import { ConnectorRpcError } from "./connector-rpc-error";
import type { OwnershipState } from "./local-runtime";
import type { ConnectorLogEntry } from "./connector-types";

/** What the supervisor needs from one Connector's control channel. */
function fakeChannel(behavior: { conflict?: () => boolean } = {}): ConnectorChannel {
  const state = (running: boolean) => ({ running, authFailed: false, status: running ? "running" : "stopped" });
  const stayOpen = async function* (_since: number | null, options?: { signal?: AbortSignal }) {
    await new Promise<void>(resolve => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  return {
    control: {
      getState: async () => state(false),
      acquireOwnership: async () => {
        if (behavior.conflict?.()) throw { code: "connector_already_running", details: { owner: { kind: "cli", pid: 1234 } } };
        return state(false);
      },
      saveConfig: async () => state(false),
      start: async () => {
        if (behavior.conflict?.()) throw { code: "connector_already_running", details: { owner: { kind: "cli", pid: 1234 } } };
        return state(true);
      },
      stop: async () => state(false),
      restart: async () => state(true),
      events: stayOpen,
    },
    logs: { tail: (_since, _source, options) => stayOpen(null, options),
      read: async () => ({ items: [], firstSeq: null, lastSeq: null, total: 0, hasMoreBefore: false, hasMoreAfter: false }),
      clear: async () => ({ items: [], firstSeq: null, lastSeq: null, total: 0, hasMoreBefore: false, hasMoreAfter: false }) },
    close: async () => {},
  };
}

// Exercise real stdio provisioning without downloading Python or running an AA server.
const runtime = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.argv[2], JSON.stringify({
  defaultIndex: process.env.UV_DEFAULT_INDEX,
  indexUrl: process.env.UV_INDEX_URL,
  index: process.env.UV_INDEX,
  pipIndex: process.env.PIP_INDEX_URL,
  pythonMirror: process.env.UV_PYTHON_INSTALL_MIRROR,
}));
process.stdout.write(JSON.stringify({ kind: 'connector.ready', version: 1, instanceId: 'fake', pid: process.pid, endpoint: { unixPath: '/nonexistent/fake.sock' }, key: 'mk_host_fake' }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));

`;

test("first pre-login provisioning asks the chosen mirror first and falls back to PyPI", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-provision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const script = path.join(root, "runtime.cjs");
  const captured = path.join(root, "environment.json");
  fs.writeFileSync(script, runtime);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    // Windows process-tree termination is not a Connector launch.
    if (command === "taskkill.exe") return spawn(command, args, options);
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(0, 5), ["run", "--project", root, "anywhere-cli", "rpc"]);
    return spawn(process.execPath, [script, captured], options);
  });
  for (const [choice, expected] of [
    [undefined, "https://mirrors.aliyun.com/pypi/simple"],
    ["", undefined],
    ["https://pypi.org/simple/", undefined],
    ["https://pypi.tuna.tsinghua.edu.cn/simple", "https://pypi.tuna.tsinghua.edu.cn/simple"],
  ] as const) {
    const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US", "zh-CN"]);
    settings.save({ uvPath: process.execPath, ...(choice === undefined ? {} : { uvPypiIndexUrl: choice }) });
    const supervisor = new ConnectorSupervisor({
      configPath: path.join(root, "connector.json"), dataPath: root, connectorDir: root, resourcesPath: root,
      uvBundleDir: path.join(root, "build", "uv"),
      pythonBundleDir: path.join(root, "build", "python"),
      packaged: false, homePath: root, settings,
      shellEnvironment: {
        UV_DEFAULT_INDEX: "https://inherited.example/simple",
        UV_INDEX_URL: "https://inherited.example/simple",
        UV_INDEX: "https://inherited.example/simple",
        UV_PYTHON_INSTALL_MIRROR: "https://inherited.example/python",
      },
      binding: new DesktopBindingStore(path.join(root, "binding.json")),
      logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
      onState: () => {}, onLog: () => {},
      connectControl: async () => fakeChannel(),
    });
    try {
      await supervisor.preflightProvisioning();
      // A mirror that lacks a package (TUNA has no openai-codex) still resolves through PyPI.
      assert.deepEqual(JSON.parse(fs.readFileSync(captured, "utf8")), {
        defaultIndex: "https://pypi.org/simple", indexUrl: "https://pypi.org/simple",
        ...(expected ? { index: expected } : {}),
        pipIndex: expected ?? "https://pypi.org/simple", pythonMirror: NPMMIRROR_PYTHON_BUILDS,
      });
    } finally { await supervisor.shutdown(); }
  }
});


test("Python ownership conflicts reach the Desktop gate, retain credentials and allow manual retry", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-rpc-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const script = path.join(root, "runtime.cjs");
  const ready = path.join(root, "owner-stopped");
  fs.writeFileSync(script, `
process.stdout.write(JSON.stringify({ kind: 'connector.ready', version: 1, instanceId: 'fake', pid: process.pid, endpoint: { unixPath: '/nonexistent/fake.sock' }, key: 'mk_host_fake' }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
  const configPath = path.join(root, "connector.json");
  const credentials = { serverUrl: "https://example.test", connectorId: "desktop-id", connectorToken: "private-token" };
  fs.writeFileSync(configPath, JSON.stringify(credentials));
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  settings.save({ uvPath: process.execPath });
  const spawn = childProcess.spawn;
  let launches = 0;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    // Windows process-tree termination is not a Connector launch.
    if (command === "taskkill.exe") return spawn(command, args, options);
    launches += 1;
    assert.equal(options.env?.AA_CONNECTOR_OWNER_KIND, "desktop-workbench");
    return spawn(process.execPath, [script, ready], options);
  });
  const ownership: OwnershipState[] = [];
  const logs: string[] = [];
  const supervisor = new ConnectorSupervisor({
    configPath, dataPath: root, connectorDir: root, resourcesPath: root,
    uvBundleDir: path.join(root, "build", "uv"),
    pythonBundleDir: path.join(root, "build", "python"),
    packaged: false, homePath: root, shellEnvironment: {}, settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")),
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    onOwnership: state => ownership.push(state), onState: () => {}, onLog: entry => logs.push(entry.message),
    connectControl: async () => fakeChannel({ conflict: () => !fs.existsSync(ready) }),
  });
  try {
    const isConflict = (error: unknown) => error instanceof ConnectorRpcError && error.ownershipConflict && error.code === -32009;
    await assert.rejects(supervisor.acquireOwnership(), isConflict);
    await assert.rejects(supervisor.start(), isConflict);
    assert.equal(ownership.at(-1)?.status, "conflict");
    assert.match(ownership.at(-1)?.message ?? "", /其他 Connector/);
    assert.match(ownership.at(-1)?.message ?? "", /cli, PID 1234/);
    assert.deepEqual(ownership.at(-1)?.owner, { kind: "cli", pid: 1234 });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), credentials);
    assert.equal((await supervisor.getState()).running, false);
    assert.equal(logs.some(line => line.includes("will restart")), false);
    fs.writeFileSync(ready, "");
    await supervisor.acquireOwnership();
    assert.equal(ownership.at(-1)?.status, "owned");
    assert.equal((await supervisor.start()).running, true);
    assert.equal(launches, 1, "A failed acquisition keeps its RPC channel available for retry");
  } finally { await supervisor.shutdown(); }
});

test("an RPC process that exits before answering reports its exit code and last output", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-rpc-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const script = path.join(root, "runtime.cjs");
  // uv writes one message in several chunks, and its last lines explain the exit.
  fs.writeFileSync(script, `
process.stderr.write('Downloading claude-agent-sdk', () => setTimeout(() => {
  process.stderr.write(' (92.9MiB)\\nerror: Failed to fetch: https://pypi.example/simple/claude-agent-sdk/\\n', () => process.exit(2));
}, 50));
`);
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  settings.save({ uvPath: process.execPath });
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    // Windows process-tree termination is not a Connector launch.
    if (command === "taskkill.exe") return spawn(command, args, options);
    return spawn(process.execPath, [script], options);
  });
  const ownership: OwnershipState[] = [];
  const logs: ConnectorLogEntry[] = [];
  const supervisor = new ConnectorSupervisor({
    configPath: path.join(root, "connector.json"), dataPath: root, connectorDir: root, resourcesPath: root,
    uvBundleDir: path.join(root, "build", "uv"),
    pythonBundleDir: path.join(root, "build", "python"),
    packaged: false, homePath: root, shellEnvironment: {}, settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")),
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    onOwnership: state => ownership.push(state), onState: () => {}, onLog: entry => logs.push(entry),
  });
  try {
    const reason = [
      "Connector RPC exited with code 2",
      "Last output:",
      "Downloading claude-agent-sdk (92.9MiB)",
      "error: Failed to fetch: https://pypi.example/simple/claude-agent-sdk/",
    ].join("\n");
    await assert.rejects(supervisor.acquireOwnership(), { message: reason });
    assert.deepEqual(ownership.at(-1), {
      status: "error",
      message: reason,
      // A failed first install lets the gate switch mirrors or download from scratch.
      recovery: { kind: "provisioning", pypiIndexUrl: "", pythonInstallMirror: "", downloadsPython: true },
    }, "the gate quotes the same reason");
    assert.equal(supervisor.publicState().lastError, reason, "an exit nobody asked for stays visible after the gate");
    const messages = logs.map(entry => entry.message);
    assert.ok(messages.includes("Downloading claude-agent-sdk (92.9MiB)"), "a line split across chunks is logged whole");
    assert.equal(messages.includes("(92.9MiB)"), false);
    assert.ok(logs.some(entry => entry.level === "ERROR"
      && entry.message.startsWith("Could not acquire Connector ownership: Connector RPC exited with code 2")));
  } finally { await supervisor.shutdown(); }
});

test("development launches the bundled uv instead of the developer's PATH", { timeout: 15_000 }, async (t) => {
  if (process.env.WORKBENCH_CONNECTOR_CLI?.trim()) {
    t.skip("WORKBENCH_CONNECTOR_CLI overrides launcher resolution");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-uv-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const uvBundleDir = path.join(root, "build", "uv");
  const bundledUv = path.join(uvBundleDir, `${process.platform}-${process.arch}`, process.platform === "win32" ? "uv.exe" : "uv");
  fs.mkdirSync(path.dirname(bundledUv), { recursive: true });
  fs.writeFileSync(bundledUv, "");
  const script = path.join(root, "runtime.cjs");
  fs.writeFileSync(script, `
process.stdout.write(JSON.stringify({ kind: 'connector.ready', version: 1, instanceId: 'fake', pid: process.pid, endpoint: { unixPath: '/nonexistent/fake.sock' }, key: 'mk_host_fake' }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  const spawn = childProcess.spawn;
  const launches: Array<{ command: string; args: readonly string[] }> = [];
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    launches.push({ command, args });
    return spawn(process.execPath, [script], options);
  });
  const supervisor = new ConnectorSupervisor({
    configPath: path.join(root, "connector.json"), dataPath: root, connectorDir: root, resourcesPath: root,
    uvBundleDir, pythonBundleDir: path.join(root, "build", "python"),
    packaged: false, homePath: root, shellEnvironment: {}, settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")),
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    onState: () => {}, onLog: () => {},
    connectControl: async () => fakeChannel(),
  });
  try {
    await supervisor.getState();
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.command, bundledUv, "development must run the uv that packaging bundles");
    assert.deepEqual(
      [...(launches[0]?.args ?? [])],
      ["run", "--project", root, "anywhere-cli", "rpc", "--config", path.join(root, "connector.json")],
    );
  } finally { await supervisor.shutdown(); }
});

test("the bundled Python pins the Connector environment, and replacing another interpreter's is provisioning", { timeout: 15_000 }, async (t) => {
  if (process.env.WORKBENCH_CONNECTOR_CLI?.trim() || process.env.UV_PROJECT_ENVIRONMENT?.trim()) {
    t.skip("the environment overrides launcher or project environment resolution");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-python-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const pythonBundleDir = path.join(root, "build", "python");
  const bundledPython = bundledPythonExecutable(pythonBundleDir);
  const savedPython = path.join(root, "custom-python", process.platform === "win32" ? "python.exe" : "python3");
  for (const interpreter of [bundledPython, savedPython]) {
    fs.mkdirSync(path.dirname(interpreter), { recursive: true });
    fs.writeFileSync(interpreter, "");
  }
  const script = path.join(root, "runtime.cjs");
  fs.writeFileSync(script, `
process.stdout.write(JSON.stringify({ kind: 'connector.ready', version: 1, instanceId: 'fake', pid: process.pid, endpoint: { unixPath: '/nonexistent/fake.sock' }, key: 'mk_host_fake' }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
  const configPath = path.join(root, "connector.json");
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  settings.save({ uvPath: process.execPath });
  const spawn = childProcess.spawn;
  const launches: Array<readonly string[]> = [];
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    // Windows process-tree termination is not a Connector launch.
    if (command === "taskkill.exe") return spawn(command, args, options);
    launches.push(args);
    return spawn(process.execPath, [script], options);
  });
  const ownership: OwnershipState[] = [];
  const supervisor = new ConnectorSupervisor({
    configPath, dataPath: root, connectorDir: root, resourcesPath: root,
    uvBundleDir: path.join(root, "build", "uv"), pythonBundleDir,
    packaged: false, homePath: root, shellEnvironment: {}, settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")),
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    onOwnership: state => ownership.push(state), onState: () => {}, onLog: () => {},
    connectControl: async () => fakeChannel(),
  });
  // Acquire ownership over a project environment whose pyvenv.cfg records
  // `home` (none when null) and report whether that counted as provisioning.
  const environment = path.join(root, ".venv");
  const provisions = async (home: string | null, installed = true) => {
    fs.rmSync(environment, { recursive: true, force: true });
    if (home !== null) {
      fs.mkdirSync(environment);
      fs.writeFileSync(path.join(environment, "pyvenv.cfg"), `home = ${home}\nimplementation = CPython\nversion_info = 3.12.14\n`);
      if (installed) {
        const script = process.platform === "win32" ? path.join(environment, "Scripts", "anywhere-cli.exe") : path.join(environment, "bin", "anywhere-cli");
        fs.mkdirSync(path.dirname(script), { recursive: true });
        fs.writeFileSync(script, "");
      }
    }
    ownership.length = 0;
    await supervisor.acquireOwnership();
    assert.equal(ownership.at(-1)?.status, "owned");
    return ownership[0]?.status === "preparing";
  };
  try {
    assert.equal(await provisions(null), true, "a missing environment is built first");
    assert.deepEqual(
      [...(launches[0] ?? [])],
      ["run", "--project", root, "--python", bundledPython, "anywhere-cli", "rpc", "--config", configPath],
    );
    assert.equal(supervisor.publicState().resolvedPythonPath, bundledPython);
    assert.equal(
      await provisions(path.join(root, "uv", "python", "cpython-3.14-windows-x86_64-none")),
      true,
      "uv rebuilds an environment another interpreter created",
    );
    assert.equal(await provisions(path.dirname(bundledPython)), false, "the bundled interpreter's environment is ready");
    assert.equal(
      await provisions(path.dirname(bundledPython), false),
      true,
      "a sync that failed before installing the Connector left only pyvenv.cfg",
    );

    const previous = settings.get();
    settings.save({ pythonPath: savedPython });
    await supervisor.applySettings(previous);
    assert.equal(supervisor.publicState().resolvedPythonPath, savedPython, "a saved pythonPath wins over the bundle");
    assert.equal(await provisions(path.dirname(bundledPython)), true);
    assert.deepEqual([...(launches.at(-1) ?? [])].slice(3, 5), ["--python", savedPython]);
  } finally { await supervisor.shutdown(); }
});

test("runtime logs retain central sequences, paginate and export without a second Desktop copy", { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-central-logs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const script = path.join(root, "runtime.cjs");
  fs.writeFileSync(script, runtime);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (command === "taskkill.exe") return spawn(command, args, options);
    return spawn(process.execPath, [script, path.join(root, "environment.json")], options);
  });
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  settings.save({ uvPath: process.execPath });
  const store = new ConnectorLogStore(path.join(root, "logs"), () => settings.get());
  const entries = Array.from({ length: 1205 }, (_, i) => ({ seq: 9000 + i, time: "now", name: "connector", level: "INFO", message: `runtime-${i}` }));
  const channel = fakeChannel();
  const originalTail = channel.logs.tail;
  channel.logs.tail = async function* (since, source, options) {
    yield entries[0]!;
    yield* originalTail(since, source, options);
  };
  const seenSources: Array<string | null | undefined> = [];
  channel.logs.read = async (source, before, after, limit = 200) => {
    seenSources.push(source);
    const rows = entries.filter(e => (before == null || e.seq < before) && (after == null || e.seq > after));
    const items = after == null ? rows.slice(-limit) : rows.slice(0, limit);
    return { items, firstSeq: entries[0]!.seq, lastSeq: entries.at(-1)!.seq, total: entries.length,
      hasMoreBefore: Boolean(items.length && items[0]!.seq > entries[0]!.seq),
      hasMoreAfter: Boolean(items.length && items.at(-1)!.seq < entries.at(-1)!.seq),
      logsPath: path.join(root, "central-logs") };
  };
  const live: ConnectorLogEntry[] = [];
  const supervisor = new ConnectorSupervisor({
    configPath: path.join(root, "connector.json"), dataPath: root, connectorDir: root, resourcesPath: root,
    uvBundleDir: path.join(root, "uv"), pythonBundleDir: path.join(root, "python"),
    packaged: false, homePath: root, shellEnvironment: {}, settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")), logs: store,
    onState: () => {}, onLog: () => {}, onRuntimeLog: e => live.push(e), connectControl: async () => channel,
  });
  try {
    await supervisor.preflightProvisioning();
    assert.equal(live[0]!.seq, 9000);
    assert.ok(!store.read({ pageSize: 5000 }).items.some(e => e.message.startsWith("runtime-")));
    const page = await supervisor.readLogs({ beforeSeq: 9100, pageSize: 30, source: "bridge" });
    assert.equal(seenSources[0], "bridge");
    assert.equal(page.logsPath, path.join(root, "central-logs"));
    assert.equal(supervisor.publicState().logsPath, path.join(root, "central-logs"));
    assert.equal(page.items.length, 30);
    assert.equal(page.items.at(-1)!.seq, 9099);
    const exported = path.join(root, "export.jsonl");
    assert.equal(await supervisor.exportLogs(exported), entries.length);
    assert.deepEqual(fs.readFileSync(exported, "utf8").trim().split("\n").map(line => JSON.parse(line).seq), entries.map(e => e.seq));
    assert.equal((await supervisor.clearLogs()).total, 0);
  } finally { await supervisor.shutdown(); }
});

function supervisorFixture(root: string, options: { packaged?: boolean; onOwnership?: (state: OwnershipState) => void } = {}) {
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  settings.save({ uvPath: process.execPath });
  return new ConnectorSupervisor({
    configPath: path.join(root, "connector.json"), dataPath: root, connectorDir: root, resourcesPath: root,
    uvBundleDir: path.join(root, "build", "uv"),
    pythonBundleDir: path.join(root, "build", "python"),
    packaged: options.packaged ?? false, homePath: root, shellEnvironment: {}, settings,
    binding: new DesktopBindingStore(path.join(root, "binding.json")),
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    onOwnership: options.onOwnership, onState: () => {}, onLog: () => {},
    connectControl: async () => fakeChannel(),
  });
}

function launchScript(t: TestContext, script: string): void {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    // Windows process-tree termination is not a Connector launch.
    if (command === "taskkill.exe") return spawn(command, args, options);
    return spawn(process.execPath, [script], options);
  });
}

const READY_LINE = `process.stdout.write(JSON.stringify({ kind: 'connector.ready', version: 1, instanceId: 'fake', pid: process.pid, endpoint: { unixPath: '/nonexistent/fake.sock' }, key: 'mk_host_fake' }) + '\\n');`;

test("a Connector that exits on its own records why in lastError, a stopped one does not", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-rpc-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "runtime.cjs");
  fs.writeFileSync(script, `${READY_LINE}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
if (process.env.AA_TEST_CRASH) setTimeout(() => process.stderr.write('Traceback: boom\\n', () => process.exit(3)), 100);
`);
  launchScript(t, script);
  const stopped = supervisorFixture(root);
  try {
    await stopped.acquireOwnership();
  } finally { await stopped.shutdown(); }
  assert.equal(stopped.publicState().lastError, null, "a shutdown is not a crash");

  process.env.AA_TEST_CRASH = "1";
  t.after(() => { delete process.env.AA_TEST_CRASH; });
  const states: Array<string | null> = [];
  const crashed = supervisorFixture(root);
  try {
    await crashed.acquireOwnership();
    const deadline = Date.now() + 5_000;
    while (!crashed.publicState().lastError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(crashed.publicState().lastError, "Connector RPC exited with code 3\nLast output:\nTraceback: boom");
    assert.equal(crashed.publicState().running, false);
    states.push(crashed.reportError("Could not start the local Connector on launch: offline").lastError);
    assert.deepEqual(states, ["Could not start the local Connector on launch: offline"]);
  } finally { await crashed.shutdown(); }
});

test("a uv failure on a normal launch also offers the provisioning recovery", { timeout: 15_000 }, async (t) => {
  if (process.env.WORKBENCH_CONNECTOR_CLI?.trim() || process.env.UV_PROJECT_ENVIRONMENT?.trim()) {
    t.skip("WORKBENCH_CONNECTOR_CLI or UV_PROJECT_ENVIRONMENT overrides the launch");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-rpc-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // An existing environment: the launch is not first-run provisioning.
  fs.mkdirSync(path.join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), `home = ${path.dirname(process.execPath)}\n`);
  fs.writeFileSync(path.join(root, ".venv", process.platform === "win32" ? "Scripts/anywhere-cli.exe" : "bin/anywhere-cli"), "");
  const script = path.join(root, "runtime.cjs");
  const ownership: OwnershipState[] = [];
  launchScript(t, script);
  for (const [output, recovers] of [
    ["error: Request failed after 3 retries\\n  Caused by: dns error", true],
    ["Traceback (most recent call last):\\nValueError: bad config", false],
  ] as const) {
    fs.writeFileSync(script, `process.stderr.write('${output}\\n', () => process.exit(1));`);
    const supervisor = supervisorFixture(root, { onOwnership: state => ownership.push(state) });
    try {
      await assert.rejects(supervisor.acquireOwnership());
      assert.equal(ownership.at(-1)?.status, "error");
      assert.equal(ownership.at(-1)?.recovery?.kind, recovers ? "provisioning" : undefined, output);
      assert.equal(ownership.some(state => state.status === "preparing"), false);
    } finally { await supervisor.shutdown(); }
  }
});

test("resetting the environment removes only what uv built for this Desktop", { timeout: 15_000 }, async (t) => {
  if (process.env.WORKBENCH_CONNECTOR_CLI?.trim() || process.env.UV_PROJECT_ENVIRONMENT?.trim()) {
    t.skip("WORKBENCH_CONNECTOR_CLI or UV_PROJECT_ENVIRONMENT overrides the launch");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-reset-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "runtime.cjs");
  fs.writeFileSync(script, `${READY_LINE}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
  launchScript(t, script);
  const venv = path.join(root, ".venv");
  for (const directory of [path.join(venv, "lib"), path.join(root, "uv-cache", "wheels"), path.join(root, "connector-source", "abc")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
  fs.writeFileSync(path.join(root, "connector.json"), "{}");

  const development = supervisorFixture(root);
  try {
    await development.acquireOwnership();
    await development.resetEnvironment();
    assert.equal(fs.existsSync(venv), false, "the running RPC process is stopped and its environment removed");
    assert.equal(fs.existsSync(path.join(root, "uv-cache")), true, "development keeps the developer's uv cache");
    // A directory that is not a virtualenv is never deleted, whatever UV_PROJECT_ENVIRONMENT says.
    fs.mkdirSync(venv);
    fs.writeFileSync(path.join(venv, "keep.txt"), "");
    await development.resetEnvironment();
    assert.equal(fs.existsSync(path.join(venv, "keep.txt")), true);
  } finally { await development.shutdown(); }

  fs.writeFileSync(path.join(venv, "pyvenv.cfg"), "home = /usr/bin\n");
  const packaged = supervisorFixture(root, { packaged: true });
  try {
    await packaged.resetEnvironment();
    for (const name of [".venv", "uv-cache", "connector-source"]) assert.equal(fs.existsSync(path.join(root, name)), false, name);
    assert.equal(fs.existsSync(path.join(root, "connector.json")), true, "credentials survive");
  } finally { await packaged.shutdown(); }
});
