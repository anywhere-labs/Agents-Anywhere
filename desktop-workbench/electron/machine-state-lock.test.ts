import assert from "node:assert/strict";
import fs from "node:fs";
import { Server } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { machineStateLockPorts, withMachineStateLock } from "./machine-state-lock";

/** Fails listen() on `reserved` the way Windows excluded port ranges do; returns the ports bound. */
function reservePorts(t: TestContext, reserved: Set<number>): number[] {
  const bound: number[] = [];
  const listen = Server.prototype.listen as (this: Server, ...args: unknown[]) => Server;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
    const port = (args[0] as { port?: number } | undefined)?.port;
    if (port !== undefined && reserved.has(port)) {
      const error = Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), { code: "EACCES" });
      process.nextTick(() => this.emit("error", error));
      return this;
    }
    if (port !== undefined) this.once("listening", () => bound.push(port));
    return listen.apply(this, args);
  });
  return bound;
}

async function temporaryRecord(t: TestContext): Promise<{ filePath: string; ports: number[] }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-lock-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const canonical = path.join(await fs.promises.realpath(home), "connector-runtime.json");
  const ports = machineStateLockPorts(process.platform === "win32" ? canonical.toLowerCase() : canonical);
  return { filePath: path.join(home, "connector-runtime.json"), ports };
}

test("Machine-state lock ports follow the shared contract", () => {
  // connector/tests/test_runtime_owner.py pins the same ports.
  assert.deepEqual(machineStateLockPorts("/home/me/.agents-anywhere/connector-runtime.json"), [
    54028, 55052, 56076, 57100, 58124, 59148, 60172, 61196,
    62220, 63244, 64268, 65292, 49932, 50956, 51980, 53004,
  ]);
});

test("Machine-state lock moves past ports the OS reserves but waits on a held one", async t => {
  const { filePath, ports } = await temporaryRecord(t);
  const bound = reservePorts(t, new Set(ports.slice(0, 2)));
  await withMachineStateLock(filePath, async () => {
    // Usually ports[2]; later when this machine really reserves that one as well.
    assert.equal(bound.length, 1);
    assert.ok(ports.indexOf(bound[0]) >= 2);
    await assert.rejects(withMachineStateLock(filePath, () => assert.fail("Claimed a later port while the lock is held"), 100), /busy/);
  });
  await withMachineStateLock(filePath, () => undefined);
  assert.deepEqual(bound, [bound[0], bound[0]]);
});

test("Machine-state lock reports when the OS reserves every port", async t => {
  const { filePath, ports } = await temporaryRecord(t);
  reservePorts(t, new Set(ports));
  const started = Date.now();
  await assert.rejects(withMachineStateLock(filePath, () => assert.fail("Claimed a reserved port")), /reserves every lock port/);
  assert.ok(Date.now() - started < 1_000, "Waiting cannot free a reserved port");
});
