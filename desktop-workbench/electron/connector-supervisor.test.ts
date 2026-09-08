import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopBindingStore } from "./desktop-binding";
import { DesktopSettingsStore } from "./desktop-settings";
import { ConnectorSupervisor } from "./connector-supervisor";
import { ConnectorLogStore } from "./log-store";
import { ConnectorRpcError } from "./connector-rpc-error";
import type { OwnershipState } from "./local-runtime";

// Exercise real stdio provisioning without downloading Python or running an AA server.
const runtime = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.argv[2], JSON.stringify({
  defaultIndex: process.env.UV_DEFAULT_INDEX,
  indexUrl: process.env.UV_INDEX_URL,
  pipIndex: process.env.PIP_INDEX_URL,
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
      packaged: false, homePath: root, settings,
      shellEnvironment: { UV_DEFAULT_INDEX: "https://inherited.example/simple", UV_INDEX_URL: "https://inherited.example/simple" },
      binding: new DesktopBindingStore(path.join(root, "binding.json")),
      logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
      onState: () => {}, onLog: () => {},
    });
    try {
      await supervisor.preflightProvisioning();
      assert.deepEqual(JSON.parse(fs.readFileSync(captured, "utf8")), {
        defaultIndex: expected, indexUrl: expected, pipIndex: expected,
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
  t.mock.method(childProcess, "spawn", (_command: string, _args: readonly string[], options: childProcess.SpawnOptions) => {
    launches += 1;
    assert.equal(options.env?.AA_CONNECTOR_OWNER_KIND, "desktop-workbench");
    return spawn(process.execPath, [script, ready], options);
  });
  const ownership: OwnershipState[] = [];
  const logs: string[] = [];
  const supervisor = new ConnectorSupervisor({
    configPath, dataPath: root, connectorDir: root, resourcesPath: root,
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
