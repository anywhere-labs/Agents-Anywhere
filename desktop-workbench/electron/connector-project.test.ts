import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeConnectorProject } from "./connector-project";

test("bundled Connector source is mirrored into a writable, content-addressed copy", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "bundle");
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(source, "connector"), { recursive: true });
  fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname = \"x\"\n");
  fs.writeFileSync(path.join(source, "connector", "cli.py"), "print('v1')\n");

  const first = materializeConnectorProject(source, data);
  assert.equal(path.dirname(first), path.join(data, "connector-source"));
  assert.equal(fs.readFileSync(path.join(first, "connector", "cli.py"), "utf8"), "print('v1')\n");
  // uv writes its lock into the copy, which later launches reuse.
  fs.writeFileSync(path.join(first, "uv.lock"), "lock");
  assert.equal(materializeConnectorProject(source, data), first);
  assert.equal(fs.readFileSync(path.join(first, "uv.lock"), "utf8"), "lock");
  assert.equal(fs.existsSync(path.join(source, "uv.lock")), false);

  fs.writeFileSync(path.join(source, "connector", "cli.py"), "print('v2')\n");
  const second = materializeConnectorProject(source, data);
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(path.join(second, "connector", "cli.py"), "utf8"), "print('v2')\n");
  assert.deepEqual(fs.readdirSync(path.join(data, "connector-source")).filter(name => name.includes(".partial-")), []);
});

test("an incomplete bundle is rejected before anything is copied", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "");
  assert.throws(() => materializeConnectorProject(root, path.join(root, "data")), /incomplete/);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});
