import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopInstallation, MachineStateStore, machineStatePath } from "./machine-state";

test("Desktop reads history and updates only its installation metadata", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-history-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new MachineStateStore(machineStatePath(home));
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
  const runtime = { instanceId: "python-owner", pid: process.pid, kind: "cli", startedAt: "2026-09-08" };
  const contents = JSON.stringify({ version: 2, connectorIds: [" first ", "second", "first"], runtime, future: true });
  fs.writeFileSync(store.filePath, contents);
  assert.deepEqual(store.readConnectorIds(), ["first", "second"]);
  assert.equal(fs.readFileSync(store.filePath, "utf8"), contents);
  assert.equal("recordConnectorId" in store, false);
  const installation = desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform });
  await store.recordInstallation(installation);
  const saved = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.deepEqual(saved.connectorIds, [" first ", "second", "first"]);
  assert.deepEqual(saved.runtime, runtime);
  assert.equal(saved.future, true);
  const before = fs.statSync(store.filePath).mtimeMs;
  await store.recordInstallation(installation);
  assert.equal(fs.statSync(store.filePath).mtimeMs, before);
});

test("Desktop supplies installation metadata to Connector", () => {
  assert.deepEqual(desktopInstallation({ executablePath: "/Applications/Agents Anywhere.app/Contents/MacOS/Agents Anywhere", appPath: "/ignored", packaged: true, platform: "darwin" }), {
    executablePath: "/Applications/Agents Anywhere.app/Contents/MacOS/Agents Anywhere", appPath: "/Applications/Agents Anywhere.app", packaged: true, platform: "darwin", launchArgs: [],
  });
  assert.deepEqual(desktopInstallation({ executablePath: "/bin/electron", appPath: "/repo/desktop", packaged: false, platform: "linux" }).launchArgs, ["/repo/desktop"]);
  assert.throws(() => desktopInstallation({ executablePath: "/bin/electron", appPath: "/repo", packaged: true, platform: "darwin" }), /bundle/);
});
