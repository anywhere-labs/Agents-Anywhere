import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopInstallation, MachineStateStore, machineStatePath } from "./machine-state";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-machine-中文 "));
  const store = new MachineStateStore(machineStatePath(home));
  const installation = desktopInstallation({ executablePath: process.execPath, appPath: home, packaged: false, platform: process.platform });
  return { home, store, installation, read: () => JSON.parse(fs.readFileSync(store.filePath, "utf8")), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("every startup validates the executable but identical records keep their timestamp", () => {
  const h = fixture();
  try {
    h.store.recordInstallation(h.installation);
    h.store.recordConnectorId("conn-first");
    const before = fs.statSync(h.store.filePath);
    h.store.recordInstallation(h.installation);
    assert.equal(fs.statSync(h.store.filePath).mtimeMs, before.mtimeMs);
    assert.throws(() => h.store.recordInstallation({ ...h.installation, executablePath: path.join(h.home, "missing") }), /ENOENT/);
    assert.deepEqual(h.read().connectorIds, ["conn-first"]);
    assert.equal(h.read().desktop.executablePath, fs.realpathSync(process.execPath));
    assert.equal(h.read().desktop.appPath, fs.realpathSync(h.home));
  } finally { h.cleanup(); }
});

test("an install move repairs paths while preserving ID order and future shared fields", () => {
  const h = fixture();
  try {
    h.store.recordInstallation(h.installation);
    h.store.recordConnectorId("conn-first");
    h.store.recordConnectorId("conn-second");
    h.store.recordConnectorId("conn-first");
    const existing = h.read();
    fs.writeFileSync(h.store.filePath, JSON.stringify({ ...existing, desktop: { ...existing.desktop, executablePath: "/gone", futureDesktopField: true }, future: { value: 1 } }));
    h.store.recordInstallation(h.installation);
    assert.deepEqual(h.read().connectorIds, ["conn-first", "conn-second"]);
    assert.deepEqual(h.read().future, { value: 1 });
    assert.equal(h.read().desktop.futureDesktopField, true);
    const before = fs.statSync(h.store.filePath);
    h.store.recordConnectorId("conn-second");
    assert.equal(fs.statSync(h.store.filePath).mtimeMs, before.mtimeMs);
    assert.equal(fs.readdirSync(path.dirname(h.store.filePath)).some(name => name.endsWith(".tmp")), false);
  } finally { h.cleanup(); }
});

test("startup backs up and repairs corrupt JSON, while future schema versions are not overwritten", () => {
  const h = fixture();
  try {
    fs.mkdirSync(path.dirname(h.store.filePath), { recursive: true });
    fs.writeFileSync(h.store.filePath, "{broken");
    h.store.recordInstallation(h.installation);
    const backup = fs.readdirSync(path.dirname(h.store.filePath)).find(name => name.includes(".corrupt-"))!;
    assert.equal(fs.readFileSync(path.join(path.dirname(h.store.filePath), backup), "utf8"), "{broken");
    fs.writeFileSync(h.store.filePath, '{"version":2,"connectorIds":["future"]}');
    assert.throws(() => h.store.recordInstallation(h.installation), /version/);
    assert.equal(h.read().version, 2);
  } finally { h.cleanup(); }
});

test("packaged macOS and Windows records identify the app and dev records retain launch arguments", () => {
  assert.equal(desktopInstallation({ platform: "darwin", executablePath: "/Applications/Agents Anywhere.app/Contents/MacOS/Agents Anywhere", appPath: "/app.asar", packaged: true }).appPath, "/Applications/Agents Anywhere.app");
  const windows = desktopInstallation({ platform: "win32", executablePath: "D:\\Apps\\Agents Anywhere.exe", appPath: "D:\\Apps\\resources\\app.asar", packaged: true });
  assert.equal(windows.appPath, "D:\\Apps");
  assert.deepEqual(windows.launchArgs, []);
  const dev = desktopInstallation({ platform: "darwin", executablePath: "/Electron", appPath: "/source path", packaged: false });
  assert.deepEqual(dev.launchArgs, ["/source path"]);
});
