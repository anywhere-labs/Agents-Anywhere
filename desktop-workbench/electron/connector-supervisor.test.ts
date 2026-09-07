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
