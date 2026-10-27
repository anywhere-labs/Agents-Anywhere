import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { ConnectorEnvironment, classifyEnvironmentError, parseEnvironmentOutput, type EnvironmentContext } from "./connector-environment";
import type { ConnectorEnvironmentState } from "../shared/connector-environment";

// A small real executable emulates uv's version probe and sync command. No network.
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-environment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "connector"), { recursive: true });
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\nname='fixture'\n");
  fs.writeFileSync(path.join(project, "connector", "cli.py"), "# source\n");
  const executable = path.join(root, "uv");
  const environment = path.join(root, "environment");
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('uv fixture 1'); process.exit(0); }
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
const finish = () => {
  if (process.env.FAIL) { console.error(process.env.FAIL); process.exit(2); }
  const env = process.env.UV_PROJECT_ENVIRONMENT;
  const bin = path.join(env, process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(bin, {recursive:true});
  fs.writeFileSync(path.join(env,'pyvenv.cfg'), 'home = '+path.dirname(process.execPath)+'\\n');
  const python = path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
  if (!fs.existsSync(python)) fs.symlinkSync(process.execPath,python);
  fs.writeFileSync(path.join(bin,process.platform === 'win32' ? 'anywhere-cli.exe':'anywhere-cli'),'installed');
  fs.writeFileSync(path.join(process.env.PROJECT,'uv.lock'),'resolved');
  console.error('Installed 2 packages in 1s');
};
console.error('Resolved 2 packages in 1s');
console.error('Downloading openai-codex-cli-bin (119 MiB)');
if (process.env.CHILD) {
 const child = require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('child-ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
 child.stdout.once('data',()=>fs.writeFileSync(process.env.CHILD,String(child.pid)));
}
if (process.env.WAIT) { const timer=setInterval(()=>{ if(fs.existsSync(process.env.WAIT)) {clearInterval(timer);finish();} },20); }
else finish();
`;
  fs.writeFileSync(executable, script, { mode: 0o700 });
  const context: EnvironmentContext = { project, environment, uv: executable, python: process.execPath,
    env: { ...process.env, CALLS: path.join(root, "calls"), PROJECT: project, UV_PROJECT_ENVIRONMENT: environment, UV_CACHE_DIR: path.join(root, "cache") } };
  const states: ConnectorEnvironmentState[] = [];
  let clock = Date.now();
  const make = (dataPath = root) => new ConnectorEnvironment({ dataPath, resolve: () => context, onState: s => states.push(s), log: () => {}, now: () => clock, watchdogMs: 120_000 });
  const manager = make();
  t.after(() => manager.shutdown());
  return { root, context, manager, make, states, advance: (ms: number) => { clock += ms; }, calls: () => fs.existsSync(context.env.CALLS!) ? fs.readFileSync(context.env.CALLS!, "utf8").trim().split('\n').map(l => JSON.parse(l) as string[]) : [] };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise(r => setTimeout(r, 20)); }
}

test("cold environment uses one sync, stays preparing past 15 minutes, warns only on inactivity and resumes", { timeout: 15_000 }, async t => {
  if (process.platform === "win32") { t.skip("POSIX fixture executable"); return; }
  const f = fixture(t);
  f.context.env.WAIT = path.join(f.root, "finish");
  const first = f.manager.prepare();
  assert.equal(first, f.manager.prepare(), "single-flight shares the promise");
  await until(() => f.manager.getState().phase === "downloading");
  f.advance(16 * 60_000);
  await until(() => f.manager.getState().stalled);
  assert.equal(f.manager.getState().status, "preparing");
  assert.equal(f.calls().length, 1);
  fs.writeFileSync(f.context.env.WAIT!, "");
  await first;
  assert.equal(f.manager.getState().status, "ready");
  assert.equal(f.manager.getState().stalled, false);
  assert.ok(f.states.some(s => s.progress?.package === "openai-codex-cli-bin" && s.progress.totalBytes === 119 * 1024 ** 2));
  assert.deepEqual(f.calls()[0]?.slice(0, 3), ["sync", "--project", f.context.project]);
});

test("receipt survives restart, rejects legacy and partial environments, and fingerprints source, lock, interpreter, uv and mirror changes", async t => {
  if (process.platform === "win32") { t.skip("POSIX fixture executable"); return; }
  const f = fixture(t);
  // A pre-existing entry point is insufficient without a success receipt.
  const bin = path.join(f.context.environment, "bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "anywhere-cli"), "old");
  await f.manager.prepare(); assert.equal(f.calls().length, 1);
  await f.manager.shutdown();
  const restarted = f.make(); t.after(() => restarted.shutdown());
  assert.equal(restarted.getState().status, "stale");
  await restarted.prepare(); assert.equal(f.calls().length, 1, "matching receipt reuses environment");
  fs.appendFileSync(path.join(f.context.project, "connector", "cli.py"), "# changed\n");
  await restarted.prepare(); assert.equal(f.calls().length, 2);
  fs.appendFileSync(path.join(f.context.project, "uv.lock"), "changed");
  await restarted.prepare(); assert.equal(f.calls().length, 3);
  fs.appendFileSync(path.join(f.context.project, "pyproject.toml"), "# changed");
  await restarted.prepare(); assert.equal(f.calls().length, 4);
  f.context.env.UV_INDEX = "https://mirror.example/simple";
  await restarted.prepare(); assert.equal(f.calls().length, 5);
  fs.appendFileSync(f.context.uv, "\n// uv changed\n");
  // uv version, rather than executable source bytes, is part of the fingerprint.
  fs.writeFileSync(f.context.uv, fs.readFileSync(f.context.uv, "utf8").replace('uv fixture 1', 'uv fixture 2'), { mode: 0o700 });
  await restarted.prepare(); assert.equal(f.calls().length, 6);
  const python = path.join(f.root, "python"); fs.symlinkSync(process.execPath, python); f.context.python = python;
  await restarted.prepare(); // Alias to same interpreter deliberately reuses the real path.
  assert.equal(f.calls().length, 6);
  fs.rmSync(path.join(bin, "anywhere-cli"));
  await restarted.prepare(); assert.equal(f.calls().length, 7, "partial environment cannot reuse receipt");
  assert.ok(!fs.readFileSync(path.join(f.root, ".connector-environment.json"), "utf8").includes("mirror.example"));
});

test("failed sync has a classified persistent error, no receipt, and is safely retryable", async t => {
  if (process.platform === "win32") { t.skip("POSIX fixture executable"); return; }
  const f = fixture(t);
  f.context.env.FAIL = "error: Failed to fetch package: dns error";
  await assert.rejects(f.manager.prepare(), /code 2/);
  assert.equal(f.manager.getState().error?.kind, "network");
  assert.equal(f.manager.getState().exitCode, 2);
  assert.equal(fs.existsSync(path.join(f.root, ".connector-environment.json")), false);
  const restarted = f.make(); t.after(() => restarted.shutdown());
  assert.equal(restarted.getState().status, "failed");
  delete f.context.env.FAIL;
  await restarted.prepare(); assert.equal(restarted.getState().status, "ready");
});

test("cancel kills the installer group including a SIGTERM-resistant descendant; immediate retry succeeds", { timeout: 15_000 }, async t => {
  if (process.platform === "win32") { t.skip("POSIX process group fixture"); return; }
  const f = fixture(t);
  f.context.env.WAIT = path.join(f.root, "finish"); f.context.env.CHILD = path.join(f.root, "child");
  const preparation = f.manager.prepare(); const rejected = assert.rejects(preparation);
  await until(() => fs.existsSync(f.context.env.CHILD!));
  const pid = Number(fs.readFileSync(f.context.env.CHILD!, "utf8"));
  await f.manager.cancel(); await rejected;
  assert.equal(f.manager.getState().status, "cancelled");
  // Linux can retain an orphan zombie briefly; it cannot execute or hold files.
  try { process.kill(pid, 0); assert.match(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }), /Z/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  assert.equal(fs.existsSync(path.join(f.root, ".connector-environment.json")), false);
  delete f.context.env.WAIT; delete f.context.env.CHILD;
  await f.manager.prepare(); assert.equal(f.manager.getState().status, "ready");
});

test("another Desktop cannot prepare or reset an active environment; abandoned lease is recovered", async t => {
  if (process.platform === "win32") { t.skip("POSIX fixture executable"); return; }
  const f = fixture(t); await f.manager.prepare();
  const other = f.make(path.join(f.root, "other")); t.after(() => other.shutdown());
  await assert.rejects(other.prepare(), /busy/);
  await assert.rejects(other.reset(() => assert.fail("must not delete an active environment")), /busy/);
  await f.manager.shutdown();
  const directory = `${f.context.environment}.desktop-lock`;
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ pid: 2147483647 }));
  await other.prepare(); assert.equal(other.getState().status, "ready");
});

test("structured uv output and recovery classification preserve useful facts", () => {
  assert.equal(classifyEnvironmentError("Permission denied: /data/.venv"), "permission");
  assert.equal(classifyEnvironmentError("No solution found when resolving dependencies"), "resolution");
  assert.equal(classifyEnvironmentError("No space left on device (ENOSPC)"), "disk");
  assert.equal(classifyEnvironmentError("process exited with code 3"), "process");
  const resolved = parseEnvironmentOutput("Resolved 12 packages in 1s");
  const installed = parseEnvironmentOutput("Installed 8 packages in 2s", resolved.progress);
  assert.deepEqual(installed.progress, { totalPackages: 12, completedPackages: 8 });
});
