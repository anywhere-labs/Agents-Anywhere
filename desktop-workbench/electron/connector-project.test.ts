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

test("mirrors the bundled Connector source on a non-ASCII data path that already exists", (t) => {
  // Regression: `cpSync`'s native fast path cannot handle a destination path that
  // contains a non-ASCII character, which a Windows profile such as
  // `C:\Users\苏元洛\...` always does. The copy produced nothing, `complete()` failed
  // and the app never acquired the Connector.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-项目-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(/[^\x00-\x7F]/.test(root), `the fixture path must contain a non-ASCII character: ${root}`);
  const source = path.join(root, "bundle");
  const data = path.join(root, "数据");
  fs.mkdirSync(path.join(source, "connector"), { recursive: true });
  fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname = \"x\"\n");
  fs.writeFileSync(path.join(source, "connector", "cli.py"), "print('v1')\n");
  // `connector-source` is already there on a second launch.
  fs.mkdirSync(path.join(data, "connector-source"), { recursive: true });

  const project = materializeConnectorProject(source, data);
  assert.equal(path.dirname(project), path.join(data, "connector-source"));
  assert.equal(fs.readFileSync(path.join(project, "pyproject.toml"), "utf8"), "[project]\nname = \"x\"\n");
  assert.equal(fs.readFileSync(path.join(project, "connector", "cli.py"), "utf8"), "print('v1')\n");
  assert.equal(fs.existsSync(path.join(source, "uv.lock")), false);
});

test("mirrors the bundled Connector source on a non-ASCII data path that does not exist yet", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-项目-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(/[^\x00-\x7F]/.test(root), `the fixture path must contain a non-ASCII character: ${root}`);
  const source = path.join(root, "bundle");
  const data = path.join(root, "数据");
  fs.mkdirSync(path.join(source, "connector"), { recursive: true });
  fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname = \"x\"\n");
  fs.writeFileSync(path.join(source, "connector", "cli.py"), "print('v1')\n");
  assert.equal(fs.existsSync(data), false);

  const project = materializeConnectorProject(source, data);
  assert.equal(fs.readFileSync(path.join(project, "pyproject.toml"), "utf8"), "[project]\nname = \"x\"\n");
  assert.equal(fs.readFileSync(path.join(project, "connector", "cli.py"), "utf8"), "print('v1')\n");
  assert.deepEqual(fs.readdirSync(path.join(data, "connector-source")).filter(name => name.includes(".partial-")), []);
});

test("the bundled Connector source is not mirrored through fs.cpSync", (t) => {
  // The tests above run on plain Node, where `cpSync` handles a non-ASCII path fine and
  // would therefore pass even with the broken primitive. Pin the root cause instead: the
  // copy must not go through `cpSync` at all.
  const original = fs.cpSync;
  let calls = 0;
  fs.cpSync = (...args: Parameters<typeof original>) => {
    calls += 1;
    return original(...args);
  };
  t.after(() => { fs.cpSync = original; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-cpsync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "bundle");
  fs.mkdirSync(path.join(source, "connector"), { recursive: true });
  fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname = \"x\"\n");
  fs.writeFileSync(path.join(source, "connector", "cli.py"), "print('v1')\n");

  materializeConnectorProject(source, path.join(root, "data"));
  assert.equal(calls, 0, "cpSync's native fast path silently copies nothing, or aborts the process, for a non-ASCII destination");
});
