import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalRuntimeLease, localRuntimePath, readLocalState, updateLocalState } from "./local-runtime";

function fixture(t: test.TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-ownership-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = localRuntimePath(home);
  return { home, file, read: () => readLocalState(file), lease: (kind: string) => new LocalRuntimeLease(kind, file) };
}

test("only one instance claims a machine, and a stale disposer cannot release its successor", async t => {
  const h = fixture(t), first = h.lease("desktop-workbench"), other = h.lease("dsh-plugin");
  const states = await Promise.all([first.claim(), other.claim()]);
  assert.deepEqual(states.map(s => s.status).sort(), ["conflict", "owned"]);
  const winner = states[0]!.status === "owned" ? first : other;
  const loser = winner === first ? other : first;
  await updateLocalState(h.file, s => { s.connectorIds.push("known"); s.desktop = { appPath: "/app" }; });
  await loser.release();
  assert.equal(h.read().runtime?.instanceId, winner.instanceId);
  await winner.release();
  assert.equal((await loser.claim()).status, "owned");
  await winner.release();
  assert.equal(h.read().runtime?.instanceId, loser.instanceId);
  await loser.release();
  assert.equal(h.read().runtime, undefined);
  assert.deepEqual(h.read().connectorIds, ["known"]);
  assert.deepEqual(h.read().desktop, { appPath: "/app" });
});

test("live child prevents takeover after its host dies; reused host PID does not block forever", async t => {
  const h = fixture(t), first = h.lease("desktop-workbench");
  await first.claim();
  await updateLocalState(h.file, s => { s.runtime!.pid = 99999999; s.runtime!.childPid = process.pid; });
  assert.equal((await h.lease("cli").claim()).status, "conflict");
  await updateLocalState(h.file, s => { delete s.runtime!.childPid; s.runtime!.pid = process.pid; s.runtime!.processStartedAt = "old-process"; });
  assert.equal((await h.lease("cli").claim()).status, "owned");
});

test("migration folds old machine and installation into the runtime file without losing IDs", async t => {
  const h = fixture(t), legacy = path.join(h.home, ".agentsanywhere", "machine.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ version: 1, connectorIds: ["old", "old"], desktop: { appPath: "/Desktop" }, future: true }));
  const lease = h.lease("desktop-workbench");
  assert.equal((await lease.claim()).status, "owned");
  assert.equal(fs.existsSync(legacy), false);
  await lease.release();
  assert.deepEqual(h.read().connectorIds, ["old"]);
  assert.deepEqual(h.read().desktop, { appPath: "/Desktop" });
  assert.equal(h.read().future, true);
});

test("legacy CLI owner still blocks startup and corrupt records cannot be overwritten", async t => {
  const h = fixture(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify({ pid: process.pid, kind: "cli", connectorId: "cli-id", serverUrl: "https://example.test" }));
  assert.equal((await h.lease("desktop-workbench").claim()).status, "conflict");
  assert.deepEqual(h.read().connectorIds, ["cli-id"]);
  for (const invalid of ["{broken", '{"version":3}', '{"version":2,"runtime":{}}']) {
    fs.writeFileSync(h.file, invalid);
    assert.equal((await h.lease("dsh-plugin").claim()).status, "error");
    assert.equal(fs.readFileSync(h.file, "utf8"), invalid);
  }
});
