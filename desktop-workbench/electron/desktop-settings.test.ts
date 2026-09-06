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
