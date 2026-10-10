import assert from "node:assert/strict";
import fs from "node:fs";
import net, { Server } from "node:net";
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

/** Holds the candidate a writer would take, like another writer mid-transaction. */
async function holdLease(ports: number[]): Promise<net.Server> {
  for (const port of ports) {
    const holder = net.createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.listen({ host: "127.0.0.1", port }, () => resolve());
      });
      return holder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    }
  }
  throw new Error("This machine refuses every candidate");
}

test("Machine-state lock ports follow the shared contract", () => {
  // connector/tests/test_runtime_owner.py pins the same ports.
  assert.deepEqual(machineStateLockPorts("/home/me/.agents-anywhere/connector-runtime.json"), [
    21260, 22284, 23308, 24332, 25356, 26380, 27404, 28428,
    29452, 30476, 31500, 32524, 17164, 18188, 19212, 20236,
  ]);
});

test("a lease another writer holds is waited for, then reported as busy", async t => {
  const { filePath, ports } = await temporaryRecord(t);
  const holder = await holdLease(ports);
  try {
    await assert.rejects(() => withMachineStateLock(filePath, () => assert.fail("Wrote while another writer holds the lease"), { timeoutMs: 200 }), /busy/);
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
  assert.equal(await withMachineStateLock(filePath, () => "written"), "written");
});

test("Machine-state lock moves past ports the OS reserves but waits on a held one", async t => {
  const { filePath, ports } = await temporaryRecord(t);
  const bound = reservePorts(t, new Set(ports.slice(0, 2)));
  const warnings: string[] = [];
  await withMachineStateLock(filePath, async () => {
    // Usually ports[2]; later when this machine really reserves that one as well.
    assert.equal(bound.length, 1);
    assert.ok(ports.indexOf(bound[0]) >= 2);
    await assert.rejects(withMachineStateLock(filePath, () => assert.fail("Claimed a later port while the lock is held"), { timeoutMs: 100 }), /busy/);
  }, { warn: message => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`${ports[0]}, ${ports[1]}.*locked port ${bound[0]}`));
  await withMachineStateLock(filePath, () => undefined);
  assert.deepEqual(bound, [bound[0], bound[0]]);
});

test("a throwing warn neither fails the write nor keeps the lease", async t => {
  const { filePath, ports } = await temporaryRecord(t);
  reservePorts(t, new Set([ports[0]]));
  const failingWarn = () => { throw new Error("log write failed"); };
  assert.equal(await withMachineStateLock(filePath, () => "written", { warn: failingWarn }), "written");
  assert.equal(await withMachineStateLock(filePath, () => "again", { timeoutMs: 200 }), "again");
});

test("Machine-state lock fails, without writing unlocked, when the OS refuses every port", async t => {
  const { filePath, ports } = await temporaryRecord(t);
  reservePorts(t, new Set(ports));
  const started = Date.now();
  await assert.rejects(withMachineStateLock(filePath, () => assert.fail("Wrote without the lock")), /refused binding \(EACCES\)/);
  assert.ok(Date.now() - started < 1_000, "Waiting cannot free a reserved port");
});
