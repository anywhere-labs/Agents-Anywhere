import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopSettingsStore, NPMMIRROR_PYTHON_BUILDS } from "./desktop-settings";
import { ConnectorSupervisor } from "./connector-supervisor";
import { bundledPythonExecutable } from "./connector-python";
import { ConnectorLogStore } from "./log-store";
import { ConnectorRpcError } from "./connector-rpc-error";
import type { OwnershipState } from "./local-runtime";
import type { ConnectorLogEntry } from "./connector-types";

// Exercise real stdio provisioning without downloading Python or running an AA server.
const runtime = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.argv[2], JSON.stringify({
  defaultIndex: process.env.UV_DEFAULT_INDEX,
  indexUrl: process.env.UV_INDEX_URL,
  pipIndex: process.env.PIP_INDEX_URL,
  pythonMirror: process.env.UV_PYTHON_INSTALL_MIRROR,
}));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { running: false, status: 'stopped' } }) + '\\n');
});

`;

test("first pre-login provisioning receives the initialized mirror and honors saved choices", { timeout: 15_000 }, async (t) => {
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
    ["", "https://pypi.org/simple"],
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
        UV_PYTHON_INSTALL_MIRROR: "https://inherited.example/python",
      },
      binding: new DesktopBindingStore(path.join(root, "binding.json")),
      logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
      onState: () => {}, onLog: () => {},
    });
    try {
      await supervisor.preflightProvisioning();
      assert.deepEqual(JSON.parse(fs.readFileSync(captured, "utf8")), {
        defaultIndex: expected, indexUrl: expected, pipIndex: expected, pythonMirror: NPMMIRROR_PYTHON_BUILDS,
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
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const conflict = ['connector.acquireOwnership', 'connector.start'].includes(request.method) && !fs.existsSync(process.argv[2]);
  const response = conflict
    ? { error: { code: -32009, message: 'Another Connector is running.', data: { reason: 'connector_already_running', owner: { kind: 'cli', pid: 1234 } } } }
    : { result: { running: request.method === 'connector.start', status: request.method === 'connector.start' ? 'running' : 'stopped' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\\n');
});
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
  });
  try {
    const isConflict = (error: unknown) => error instanceof ConnectorRpcError && error.ownershipConflict && error.code === -32009;
    await assert.rejects(supervisor.acquireOwnership(), isConflict);
    await assert.rejects(supervisor.start(), isConflict);
    assert.equal(ownership.at(-1)?.status, "conflict");
    assert.match(ownership.at(-1)?.message ?? "", /其他 Connector/);
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
    assert.deepEqual(ownership.at(-1), { status: "error", message: reason }, "the gate quotes the same reason");
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
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { running: false, status: 'stopped' } }) + '\\n');
});
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
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { running: false, status: 'stopped' } }) + '\\n');
});
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
  });
  // Acquire ownership over a project environment whose pyvenv.cfg records
  // `home` (none when null) and report whether that counted as provisioning.
  const environment = path.join(root, ".venv");
  const provisions = async (home: string | null) => {
    fs.rmSync(environment, { recursive: true, force: true });
    if (home !== null) {
      fs.mkdirSync(environment);
      fs.writeFileSync(path.join(environment, "pyvenv.cfg"), `home = ${home}\nimplementation = CPython\nversion_info = 3.12.14\n`);
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

    const previous = settings.get();
    settings.save({ pythonPath: savedPython });
    await supervisor.applySettings(previous);
    assert.equal(supervisor.publicState().resolvedPythonPath, savedPython, "a saved pythonPath wins over the bundle");
    assert.equal(await provisions(path.dirname(bundledPython)), true);
    assert.deepEqual([...(launches.at(-1) ?? [])].slice(3, 5), ["--python", savedPython]);
  } finally { await supervisor.shutdown(); }
});
