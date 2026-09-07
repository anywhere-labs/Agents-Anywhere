import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Shared protocol: contracts/local-machine/1.0. Keep both writers compatible. */
export async function withMachineStateLock<T>(
  filePath: string,
  update: () => T | Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const directory = await realpath(path.dirname(filePath));
  const canonical = path.join(directory, path.basename(filePath));
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const port = 49152 + createHash("sha256").update(`aa-machine-state-v1\n${identity}`).digest().readUInt16BE(0) % 16384;
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
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
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
