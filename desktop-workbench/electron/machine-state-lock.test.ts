import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { machineStateLockPort, withMachineStateLock } from "./machine-state-lock";

const realCreateServer = net.createServer;

/** Makes every lease fail to listen the way an OS-refused port does. */
function refuseLeases(code: string): () => void {
  net.createServer = ((...args: Parameters<typeof net.createServer>) => {
    const server = realCreateServer(...args);
    server.listen = (() => {
      process.nextTick(() => server.emit("error", Object.assign(new Error(code), { code })));
      return server;
    }) as typeof server.listen;
    return server;
  }) as typeof net.createServer;
  return () => { net.createServer = realCreateServer; };
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const holder = realCreateServer(socket => socket.destroy());
    holder.once("error", reject);
    holder.listen({ host: "127.0.0.1", port }, () => resolve(holder));
  });
}

test("a lock port the OS refuses is skipped, unless another writer is listening on it", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-lock-refused-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "connector-runtime.json");
  const port = await machineStateLockPort(file);
  const warnings: string[] = [];
  t.after(refuseLeases("EACCES"));
  assert.equal(await withMachineStateLock(file, () => "written", { timeoutMs: 200, warn: m => warnings.push(m) }), "written");
  assert.deepEqual(warnings, [`Local Connector record lock port ${port} is unavailable (EACCES); writing without the lock.`]);
  const holder = await listenOn(port);
  try {
    await assert.rejects(() => withMachineStateLock(file, () => "raced", { timeoutMs: 200 }), /busy/);
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
  assert.equal(warnings.length, 1);
});

test("a lease another writer holds is waited for, then reported as busy", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-lock-busy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "connector-runtime.json");
  const holder = await listenOn(await machineStateLockPort(file));
  try {
    await assert.rejects(() => withMachineStateLock(file, () => "raced", { timeoutMs: 200 }), /busy/);
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
  assert.equal(await withMachineStateLock(file, () => "written"), "written");
});
