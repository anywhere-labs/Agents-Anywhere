import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function bundle(root: string): string {
  const source = path.join(root, "bundle");
  fs.mkdirSync(path.join(source, "connector", "子包"), { recursive: true });
  fs.writeFileSync(path.join(source, "pyproject.toml"), "[project]\nname = \"x\"\n");
  fs.writeFileSync(path.join(source, "connector", "cli.py"), "print('v1')\n");
  fs.writeFileSync(path.join(source, "connector", "子包", "模块.py"), "# 中文\n");
  return source;
}

function patch<K extends "cpSync" | "copyFileSync">(t: test.TestContext, name: K, replacement: (typeof fs)[K]): void {
  const original = fs[name];
  fs[name] = replacement;
  t.after(() => { fs[name] = original; });
}

test("the bundle is mirrored under a non-ASCII data path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-汐穹-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = materializeConnectorProject(bundle(root), path.join(root, "数据"));
  assert.equal(fs.readFileSync(path.join(project, "connector", "子包", "模块.py"), "utf8"), "# 中文\n");
  assert.deepEqual(fs.readdirSync(path.dirname(project)), [path.basename(project)]);
});

test("the bundle is not copied with fs.cpSync", (t) => {
  // Plain Node copies non-ASCII paths fine, so pin the cause as well: Electron's
  // cpSync fast path is what broke Windows profiles with non-ASCII names.
  let calls = 0;
  const original = fs.cpSync;
  patch(t, "cpSync", (...args) => { calls += 1; original(...args); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  materializeConnectorProject(bundle(root), path.join(root, "data"));
  assert.equal(calls, 0);
});

test("a failed copy names the staging path and its cause, and leaves no staging behind", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bundle(root);
  patch(t, "copyFileSync", () => {
    throw Object.assign(new Error("EIO: i/o error, copyfile"), { code: "EIO" });
  });
  assert.throws(
    () => materializeConnectorProject(source, path.join(root, "data")),
    (error: Error) => /Could not copy the bundled Connector source to .*\.partial-.*: EIO/.test(error.message)
      && (error.cause as NodeJS.ErrnoException).code === "EIO",
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "connector-source")), []);
});

test("a copy that silently skips or corrupts files is rejected instead of published", (t) => {
  // The pre-fix failure: the copy returned normally, but files were missing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bundle(root);
  const data = path.join(root, "data");
  const original = fs.copyFileSync;
  let corrupt = false;
  patch(t, "copyFileSync", (from, to, mode) => {
    if (!String(from).endsWith("模块.py")) return original(from, to, mode);
    if (corrupt) fs.writeFileSync(to, "# 改坏了\n");
  });
  assert.throws(() => materializeConnectorProject(source, data), /Could not copy the bundled Connector source to .*\.partial-.*: ENOENT/);
  corrupt = true;
  assert.throws(() => materializeConnectorProject(source, data), /Could not copy the bundled Connector source to .*: the copy does not match the bundle/);
  assert.deepEqual(fs.readdirSync(path.join(data, "connector-source")), []);
});

test("linked directories in the bundle are copied as their contents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bundle(root);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "linked.py"), "# linked\n");
  try {
    // A junction needs no extra privileges on Windows; elsewhere the type is ignored.
    fs.symlinkSync(outside, path.join(source, "connector", "linked"), "junction");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${(error as Error).message}`);
    return;
  }
  const project = materializeConnectorProject(source, path.join(root, "data"));
  const copied = path.join(project, "connector", "linked");
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(copied, "linked.py"), "utf8"), "# linked\n");
});

test("read-only bundle directories are copied into writable ones", { skip: process.platform === "win32" && "Windows has no POSIX directory modes" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  const source = bundle(root);
  const readOnly = [path.join(source, "connector", "子包"), path.join(source, "connector")];
  t.after(() => {
    for (const directory of readOnly) fs.chmodSync(directory, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const directory of readOnly) fs.chmodSync(directory, 0o555);
  const project = materializeConnectorProject(source, path.join(root, "data"));
  assert.equal(fs.readFileSync(path.join(project, "connector", "子包", "模块.py"), "utf8"), "# 中文\n");
  fs.writeFileSync(path.join(project, "connector", "uv-probe"), "");
});

test("the content digest names the copy exactly as before", (t) => {
  // Renaming the digest would orphan every published copy and its resolved uv.lock.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bundle(root);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  walk(source);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(source, file).split(path.sep).join("/")).update("\0").update(fs.readFileSync(file)).update("\0");
  }
  assert.equal(path.basename(materializeConnectorProject(source, path.join(root, "data"))), hash.digest("hex").slice(0, 16));
});

test("the bundle is mirrored under a non-ASCII data path in the Electron runtime", { timeout: 60_000 }, (t) => {
  // The defect lives in the Node that Electron ships; plain `node --test` cannot see it.
  let electron: string;
  try {
    electron = require("electron") as string;
  } catch {
    t.skip("the Electron binary is not installed");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-connector-汐穹-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bundle(root);
  const script = [
    `const { materializeConnectorProject } = require(${JSON.stringify(path.join(__dirname, "connector-project.js"))});`,
    `process.stdout.write(materializeConnectorProject(${JSON.stringify(source)}, ${JSON.stringify(path.join(root, "数据"))}));`,
  ].join("\n");
  const result = spawnSync(electron, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `exit ${result.status ?? result.signal}: ${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(result.stdout, "connector", "子包", "模块.py"), "utf8"), "# 中文\n");
});

test("a previously published but corrupted payload is repaired before reuse", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-project-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bundle(root);
  const data = path.join(root, "data");
  const project = materializeConnectorProject(source, data);
  fs.writeFileSync(path.join(project, "connector", "cli.py"), "corrupted");
  assert.equal(materializeConnectorProject(source, data), project);
  assert.equal(fs.readFileSync(path.join(project, "connector", "cli.py"), "utf8"), "print('v1')\n");
});
