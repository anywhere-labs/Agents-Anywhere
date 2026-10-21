import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { machineStateLockRecordPath, withMachineStateLock } from "./machine-state-lock";

function listenSilently(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    // Accepts connections but never answers with a token.
    const holder = net.createServer(() => {});
    holder.once("error", reject);
    holder.listen({ host: "127.0.0.1", port: 0 }, () => resolve(holder));
  });
}

test("a transaction another writer holds is waited for, then reported as busy", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-lock-busy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "connector-runtime.json");
  const record = machineStateLockRecordPath(file);
  const result = await withMachineStateLock(file, async () => {
    const published = JSON.parse(fs.readFileSync(record, "utf8")) as { pid: number; port: number; token: string };
    assert.equal(published.pid, process.pid);
    assert.ok(published.port > 0 && published.token.length > 0);
    await assert.rejects(() => withMachineStateLock(file, () => "raced", { timeoutMs: 200 }), /busy/);
    return "held";
  });
  assert.equal(result, "held");
  assert.equal(fs.existsSync(record), false, "release removes the record it owns");
  assert.equal(await withMachineStateLock(file, () => "written"), "written");
});

test("a dead writer's record is taken over even when its port is now held by something else", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-lock-stale-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "connector-runtime.json");
  const record = machineStateLockRecordPath(file);
  const stranger = await listenSilently();
  t.after(() => new Promise(resolve => stranger.close(resolve)));
  const port = (stranger.address() as net.AddressInfo).port;
  fs.writeFileSync(record, JSON.stringify({ version: 1, port, pid: 999_999, token: "stale", startedAt: "2026-01-01T00:00:00.000Z" }));
  const warnings: string[] = [];
  assert.equal(await withMachineStateLock(file, () => "written", { timeoutMs: 2_000, warn: m => warnings.push(m) }), "written");
  assert.deepEqual(warnings, ["Stale local machine record lock taken over (pid 999999)."]);
  assert.equal(fs.existsSync(record), false);
  fs.writeFileSync(record, "{not a record");
  assert.equal(await withMachineStateLock(file, () => "again", { timeoutMs: 2_000 }), "again");
});

test("release never removes a record that is no longer ours", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-lock-foreign-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "connector-runtime.json");
  const record = machineStateLockRecordPath(file);
  await withMachineStateLock(file, () => {
    fs.writeFileSync(record, JSON.stringify({ version: 1, port: 1, pid: 1, token: "intruder", startedAt: "2026-01-01T00:00:00.000Z" }));
  });
  assert.equal((JSON.parse(fs.readFileSync(record, "utf8")) as { token: string }).token, "intruder");
});
