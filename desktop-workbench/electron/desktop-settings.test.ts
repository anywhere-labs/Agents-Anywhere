import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopSettingsStore } from "./desktop-settings";

test("desktop notifications are enabled by default and can be persisted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-settings-"));
  const filePath = path.join(directory, "desktop-settings.json");

  try {
    const store = new DesktopSettingsStore(filePath);
    assert.equal(store.get().notificationsEnabled, true);

    store.save({ notificationsEnabled: false });
    assert.equal(new DesktopSettingsStore(filePath).get().notificationsEnabled, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("settings of the retired Python Connector are dropped on the next write", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-legacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  fs.writeFileSync(filePath, JSON.stringify({
    notificationsEnabled: false,
    uvPath: "/usr/local/bin/uv",
    pythonPath: "/usr/bin/python3",
    uvPypiIndexUrl: "https://mirrors.aliyun.com/pypi/simple",
    uvPythonInstallMirror: "https://registry.npmmirror.com/-/binary/python-build-standalone",
    connectorProxy: "direct",
  }));
  const store = new DesktopSettingsStore(filePath, ["zh-CN"]);
  assert.equal(store.get().notificationsEnabled, false);
  assert.equal(store.get().connectorProxy, "direct");
  assert.equal("uvPypiIndexUrl" in store.get(), false);
  store.save({ silentLaunch: false });
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const key of ["uvPath", "pythonPath", "uvPypiIndexUrl", "uvPythonInstallMirror"]) assert.equal(key in saved, false);
  assert.equal(saved.connectorProxy, "direct");
});

test("the Connector network setting keeps usable values and follows the system otherwise", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-proxy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new DesktopSettingsStore(path.join(directory, "settings.json"));
  assert.equal(store.get().connectorProxy, "");
  for (const value of ["direct", "http://127.0.0.1:7890", "socks5://user:secret@proxy:1080", "HTTPS://proxy:443"]) {
    assert.equal(store.save({ connectorProxy: ` ${value} ` }).connectorProxy, value);
  }
  for (const value of ["system", "ftp://proxy:21", "127.0.0.1:7890", "http://"]) {
    assert.equal(store.save({ connectorProxy: value }).connectorProxy, "");
  }
});

test("shutdown confirmation is off by default and only the Connector's device settings change it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-device-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "desktop-settings.json");

  const store = new DesktopSettingsStore(filePath);
  assert.equal(store.get().confirmQuitOnShutdown, false);

  // A local settings save cannot turn it on; the server owns it.
  store.save({ confirmQuitOnShutdown: true } as never);
  assert.equal(store.get().confirmQuitOnShutdown, false);

  assert.equal(store.saveDeviceSettings({ confirmQuitOnShutdown: true }), true);
  assert.equal(store.saveDeviceSettings({ confirmQuitOnShutdown: true }), false);
  // The last value survives a restart, so an offline shutdown follows it.
  assert.equal(new DesktopSettingsStore(filePath).get().confirmQuitOnShutdown, true);
});
