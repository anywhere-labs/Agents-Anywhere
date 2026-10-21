import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledPythonExecutable, environmentHome, environmentUsesPython } from "./connector-python";

test("packaging ships the bundled CPython for every target it builds", () => {
  const root = path.resolve(__dirname, "../..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const resource = manifest.build.extraResources.find((item: { to: string }) => item.to === "python");
  assert.equal(resource?.from, "build/python", "the interpreter must live outside app.asar");
  assert.match(manifest.scripts.pack, /bundle:python/);
  // Both darwin interpreters are identical in the x64 and arm64 builds merged into the universal app.
  assert.ok(manifest.build.mac.x64ArchFiles.includes("Contents/Resources/python/darwin-*/**"));
  assert.equal(bundledPythonExecutable("bundle", "win32", "x64"), path.join("bundle", "win32-x64", "python.exe"));
  assert.equal(bundledPythonExecutable("bundle", "darwin", "arm64"), path.join("bundle", "darwin-arm64", "bin", "python3"));
});

test("an environment matches the interpreter directory its pyvenv.cfg records", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-python-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(environmentHome(path.join(root, "missing")), null);
  const environment = path.join(root, ".venv");
  fs.mkdirSync(environment);
  fs.writeFileSync(path.join(environment, "pyvenv.cfg"), "home = /opt/python/bin \nversion_info = 3.12.14\n");
  assert.equal(environmentHome(environment), "/opt/python/bin");

  const bin = path.join(root, "python", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = path.join(bin, "python3.12");
  fs.writeFileSync(real, "");
  assert.equal(environmentUsesPython(bin, real), true);
  assert.equal(environmentUsesPython(path.join(root, "other"), real), false);
});

test("an environment built through a symlinked interpreter still matches it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-python-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "python", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const real = path.join(bin, "python3.12");
  fs.writeFileSync(real, "");
  // uv records the real executable's directory; `bin/python3` is a link to it.
  const elsewhere = path.join(root, "links");
  fs.mkdirSync(elsewhere);
  try {
    fs.symlinkSync(real, path.join(elsewhere, "python3"));
  } catch {
    t.skip("creating symlinks needs extra privileges on this system");
    return;
  }
  assert.equal(environmentUsesPython(bin, path.join(elsewhere, "python3")), true);
});
