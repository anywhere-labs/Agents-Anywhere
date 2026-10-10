import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { connect, createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PROBE_TIMEOUT_MS = 200;

export type MachineStateLockOptions = {
  timeoutMs?: number;
  /** Receives one line when a write proceeds without the lease. */
  warn?: (message: string) => void;
};

/** The per-user loopback port that represents this record's cross-process mutex. */
export async function machineStateLockPort(filePath: string): Promise<number> {
  const directory = await realpath(path.dirname(filePath));
  const canonical = path.join(directory, path.basename(filePath));
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return 49152 + createHash("sha256").update(`aa-machine-state-v1\n${identity}`).digest().readUInt16BE(0) % 16384;
}

/** Short file transaction shared with Python: contracts/local-machine/2.0. */
export async function withMachineStateLock<T>(
  filePath: string,
  update: () => T | Promise<T>,
  { timeoutMs = 5_000, warn }: MachineStateLockOptions = {},
): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const port = await machineStateLockPort(filePath);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // A short OS lease serializes the complete read/merge/publish operation.
    // The OS releases it on crashes; there is no stale file lock to steal.
    const lease = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        lease.once("error", reject);
        lease.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          lease.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      // EADDRINUSE is another writer holding the lease. Any other refusal with
      // nobody listening comes from the OS itself, e.g. a Windows excluded port
      // range (EACCES): no writer can hold that lease, so the record is written
      // without it instead of failing every launch.
      if (code !== "EADDRINUSE" && !(await portListening(port))) {
        warn?.(`Local Connector record lock port ${port} is unavailable (${code}); writing without the lock.`);
        return update();
      }
      if (Date.now() >= deadline) throw new Error("The local machine record is busy. Please retry.");
      await delay(20);
      continue;
    }
    try {
      return await update();
    } finally {
      await new Promise<void>((resolve, reject) => lease.close(error => error ? reject(error) : resolve()));
    }
  }
}

function portListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port });
    const done = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}
