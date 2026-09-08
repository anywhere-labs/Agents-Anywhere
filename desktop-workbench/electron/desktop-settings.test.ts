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

test("first initialization persists Aliyun for Chinese systems and keeps later mirror choices", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-mirror-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const aliyun = "https://mirrors.aliyun.com/pypi/simple";
  for (const [languages, expected] of [
    [["zh-CN"], aliyun], [["en-US", "zh-Hans-CN"], aliyun], [["zh_TW"], aliyun], [["en-US"], ""],
  ] as const) {
    const filePath = path.join(directory, `${languages.join("-")}.json`);
    const store = new DesktopSettingsStore(filePath, languages);
    assert.equal(store.get().uvPypiIndexUrl, expected);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).uvPypiIndexUrl, expected);
    assert.equal(new DesktopSettingsStore(filePath, ["zh-CN"]).get().uvPypiIndexUrl, expected);
    for (const choice of ["", "https://pypi.tuna.tsinghua.edu.cn/simple"]) {
      store.save({ uvPypiIndexUrl: choice });
      assert.equal(new DesktopSettingsStore(filePath, ["zh-CN"]).get().uvPypiIndexUrl, choice);
    }
  }
});

test("mirror initialization fills missing legacy preferences without changing explicit saved defaults", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-mirror-legacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "settings.json");
  fs.writeFileSync(filePath, JSON.stringify({ notificationsEnabled: false }));
  const migrated = new DesktopSettingsStore(filePath, ["zh-CN"]);
  assert.equal(migrated.get().uvPypiIndexUrl, "https://mirrors.aliyun.com/pypi/simple");
  assert.equal(migrated.get().notificationsEnabled, false);
  fs.writeFileSync(filePath, JSON.stringify({ uvPypiIndexUrl: "" }));
  assert.equal(new DesktopSettingsStore(filePath, ["zh-CN"]).get().uvPypiIndexUrl, "");
});
