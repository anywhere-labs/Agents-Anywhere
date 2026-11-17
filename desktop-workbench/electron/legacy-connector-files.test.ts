import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeLegacyPythonFiles } from "./legacy-connector-files";

test("removes the Python Connector leftovers and keeps the device credential", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-legacy-connector-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  fs.mkdirSync(path.join(root, "uv-cache"));
  fs.writeFileSync(path.join(root, ".connector-environment.json"), "{}");
  fs.writeFileSync(path.join(root, "connector.json"), "{\"connectorToken\":\"secret\"}");
  fs.writeFileSync(path.join(root, "desktop-binding.json"), "{}");

  assert.deepEqual(await removeLegacyPythonFiles(root), [".venv", "uv-cache", ".connector-environment.json"]);
  assert.deepEqual(fs.readdirSync(root).sort(), ["connector.json", "desktop-binding.json"]);
  assert.deepEqual(await removeLegacyPythonFiles(root), []);
});
