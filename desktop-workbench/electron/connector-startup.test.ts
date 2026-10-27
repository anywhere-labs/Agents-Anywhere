import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ConnectorSupervisor, type ConnectorChannel } from "./connector-supervisor";
import { DesktopSettingsStore } from "./desktop-settings";
import { DesktopBindingStore } from "./desktop-binding";
import { ConnectorLogStore } from "./log-store";
import type { OwnershipState } from "./local-runtime";

function startup(t: TestContext, environment: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uv = path.join(root, "uv");
  const calls = path.join(root, "calls");
  fs.writeFileSync(path.join(root, "pyproject.toml"), "# fixture");
  fs.mkdirSync(path.join(root, "connector")); fs.writeFileSync(path.join(root, "connector", "cli.py"), "# fixture");
  fs.writeFileSync(uv, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('uv fixture');process.exit(0)}
const args=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify({args,pid:process.pid})+'\\n');
if(args[0]==='sync') {
 console.error('Downloading fixture (1 MiB)');
 const finish=()=>{const v=process.env.UV_PROJECT_ENVIRONMENT,b=path.join(v,'bin');fs.mkdirSync(b,{recursive:true});fs.writeFileSync(path.join(v,'pyvenv.cfg'),'home = '+path.dirname(process.execPath)+'\\n');if(!fs.existsSync(path.join(b,'python')))fs.symlinkSync(process.execPath,path.join(b,'python'));fs.writeFileSync(path.join(b,'anywhere-cli'),'');process.exit(0)};
 if(process.env.WAIT){const tick=setInterval(()=>{if(fs.existsSync(process.env.WAIT)){clearInterval(tick);finish()}},20)}else finish();
} else {
 if(!args.includes('--no-sync'))throw Error('RPC must not sync');
 if(!process.env.SILENT) console.log(JSON.stringify({kind:'connector.ready',version:1,instanceId:'fixture',pid:process.pid,endpoint:{unixPath:'/fixture.sock'},key:'mk_host_fixture'}));
 process.stdin.resume();
}
`, { mode: 0o700 });
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"), ["en-US"]);
  settings.save({ uvPath: uv, pythonPath: process.execPath });
  const ownership: OwnershipState[] = [];
  let conflict = false;
  const stream = async function* (_since: unknown, options?: { signal?: AbortSignal }) {
    await new Promise<void>(resolve => options?.signal?.aborted ? resolve() : options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  };
  const channel: ConnectorChannel = { control: {
    acquireOwnership: async options => {
      assert.equal(options?.timeoutMs, 10_000);
      if (conflict) throw { code: "connector_already_running", details: { owner: { kind: "fixture", pid: 1234 } } };
      return { running: false, authFailed: false };
    },
    getState: async () => ({ running: false, authFailed: false }), saveConfig: async () => ({}),
    start: async () => ({ running: true, authFailed: false }), restart: async () => ({ running: true, authFailed: false }),
    stop: async () => ({ running: false, authFailed: false }), events: stream,
  }, logs: { tail: (_since, _source, options) => stream(null, options),
    read: async () => ({ items: [], firstSeq: null, lastSeq: null, hasMoreBefore: false, hasMoreAfter: false, total: 0 }),
    clear: async () => ({ items: [], firstSeq: null, lastSeq: null, hasMoreBefore: false, hasMoreAfter: false, total: 0 }) } };
  const supervisor = new ConnectorSupervisor({
    dataPath: path.join(root, "data"), configPath: path.join(root, "config.json"), connectorDir: root, resourcesPath: root,
    uvBundleDir: path.join(root, "uv-bundle"), pythonBundleDir: path.join(root, "python-bundle"), packaged: false, homePath: root,
    settings, binding: new DesktopBindingStore(path.join(root, "binding.json")),
    shellEnvironment: { CALLS: calls, UV_PROJECT_ENVIRONMENT: path.join(root, ".venv"), ...environment },
    logs: new ConnectorLogStore(path.join(root, "logs"), () => settings.get()),
    onOwnership: s => ownership.push(s), onState: () => {}, onLog: () => {}, connectControl: async () => channel,
  });
  t.after(() => supervisor.shutdown());
  return { supervisor, root, ownership, conflict: (value: boolean) => { conflict = value; },
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split('\n').map(l => JSON.parse(l) as { args: string[]; pid: number }) : [] };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("condition timed out"); await new Promise(r => setTimeout(r, 20)); }
}
test("RPC starts only after preparation commits its receipt, repeated acquisitions share both stages and conflicts remain independent", async t => {
  if (process.platform === "win32") { t.skip("POSIX executable fixture"); return; }
  const wait = path.join(os.tmpdir(), `aa-finish-${process.pid}-${Date.now()}`); t.after(() => fs.rmSync(wait, { force: true }));
  const f = startup(t, { WAIT: wait });
  const first = f.supervisor.acquireOwnership(); assert.equal(first, f.supervisor.acquireOwnership());
  await until(() => f.supervisor.environmentState().phase === "downloading");
  assert.equal(f.calls().length, 1); assert.equal(f.calls()[0]?.args[0], "sync");
  assert.equal(fs.existsSync(path.join(f.root, "data", ".connector-environment.json")), false);
  fs.writeFileSync(wait, ""); await first;
  assert.equal(f.calls().length, 2); assert.deepEqual(f.calls()[1]?.args.slice(0, 2), ["run", "--no-sync"]);
  assert.equal(f.supervisor.environmentState().status, "ready"); assert.equal(f.ownership.at(-1)?.status, "owned");
  assert.equal(fs.existsSync(path.join(f.root, "data", ".connector-environment.json")), true);
  f.conflict(true); await assert.rejects(f.supervisor.acquireOwnership());
  assert.equal(f.supervisor.environmentState().status, "ready"); assert.equal(f.ownership.at(-1)?.status, "conflict");
  f.conflict(false); await f.supervisor.acquireOwnership(); assert.equal(f.calls().length, 2);
});
test("cancel then immediate recheck starts one fresh preparation with no late RPC from the cancelled attempt", async t => {
  if (process.platform === "win32") { t.skip("POSIX executable fixture"); return; }
  const wait = path.join(os.tmpdir(), `aa-cancel-${process.pid}-${Date.now()}`); t.after(() => fs.rmSync(wait, { force: true }));
  const f = startup(t, { WAIT: wait });
  const first = f.supervisor.acquireOwnership(); const rejected = assert.rejects(first);
  await until(() => f.supervisor.environmentState().phase === "downloading");
  await f.supervisor.cancelEnvironment(); await rejected;
  assert.equal(f.supervisor.environmentState().status, "cancelled"); assert.equal(f.calls().length, 1);
  fs.writeFileSync(wait, ""); await f.supervisor.acquireOwnership();
  assert.equal(f.calls().filter(c => c.args[0] === "sync").length, 2);
  assert.equal(f.calls().filter(c => c.args[0] === "run").length, 1);
});
test("RPC startup has its own short deadline and kills its process before rejecting", { timeout: 15_000 }, async t => {
  if (process.platform === "win32") { t.skip("POSIX executable fixture"); return; }
  const f = startup(t, { SILENT: "1" });
  await assert.rejects(f.supervisor.acquireOwnership(), /RPC request timed out after 10s/);
  const pid = f.calls().at(-1)!.pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(f.supervisor.environmentState().status, "ready");
  assert.equal(f.ownership.at(-1)?.status, "error");
});
