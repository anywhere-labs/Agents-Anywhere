import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Candidate lease ports in trial order, shared with Python: contracts/local-machine/2.0.
 * 16384-32767 lies below every default dynamic port range, so ephemeral sockets and
 * listen(0) servers never land on a lock port.
 */
export function machineStateLockPorts(identity: string): number[] {
  const base = createHash("sha256").update(`aa-machine-state-v1\n${identity}`).digest().readUInt16BE(0) % 16384;
  return Array.from({ length: 16 }, (_, k) => 16384 + (base + 1024 * k) % 16384);
}

/** Short file transaction shared with Python: contracts/local-machine/2.0. */
export async function withMachineStateLock<T>(
  filePath: string,
  update: () => T | Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const directory = await realpath(path.dirname(filePath));
  const canonical = path.join(directory, path.basename(filePath));
  const ports = machineStateLockPorts(process.platform === "win32" ? canonical.toLowerCase() : canonical);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // A short OS lease serializes the complete read/merge/publish operation.
    // The OS releases it on crashes; there is no stale file lock to steal.
    const lease = await claimLease(ports);
    if (!lease) {
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

/**
 * Binds the first candidate the OS allows, or returns undefined while another writer holds it.
 * EACCES means no writer can bind the port (a Windows excluded port range, or another program's
 * exclusive bind on 0.0.0.0), so every writer moves on to the same next candidate; a held
 * candidate is never skipped.
 */
async function claimLease(ports: number[]): Promise<Server | undefined> {
  for (const port of ports) {
    const lease = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        lease.once("error", reject);
        lease.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          lease.off("error", reject);
          resolve();
        });
      });
      return lease;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES") continue;
      if (code === "EADDRINUSE") return undefined;
      throw error;
    }
  }
  throw new Error("The operating system reserves every lock port of the local machine record. "
    + "On Windows, check `netsh int ipv4 show excludedportrange protocol=tcp`.");
}
