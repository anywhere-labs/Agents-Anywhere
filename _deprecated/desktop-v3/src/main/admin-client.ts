// Talks to a running connector-v3 over its local admin socket (`aa-connector start` listens on it).
// Same wire format as `connector-v3/src/cli.ts`: one JSON request line, one JSON response line.

import { createHash } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export type AdminRequest =
  | { cmd: "status" }
  | { cmd: "pair"; ttl_ms?: number; label?: string; platform?: string }
  | { cmd: "local_token"; principal?: string; ttl_seconds?: number }
  | { cmd: "mode"; mode: "normal" | "encrypted" }
  | { cmd: "mcp"; allow: boolean }
  | { cmd: "clients" }
  | { cmd: "revoke"; client_pub: string };

export interface AdminStatus {
  device_id: string | null;
  mode: "normal" | "encrypted";
  serving: boolean;
  local_router: { url: string; http_url: string; device_id?: string; started_at: string } | null;
  settings: { device_name?: string; mode?: string } & Record<string, unknown>;
  runtimes: { id: string; name: string }[];
  paired_clients: number;
  sessions: number;
}

export class AdminError extends Error {
  override readonly name = "AdminError";
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Must match `adminSocketPath` in `connector-v3/src/cli.ts`. */
export function adminSocketPath(dataDir: string): string {
  const hash = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\aa-connector-${hash}`;
  const inside = path.join(dataDir, "admin.sock");
  return Buffer.byteLength(inside) < 100 ? inside : path.join(os.tmpdir(), `aa-connector-${hash}.sock`);
}

export function adminCall<T = unknown>(dataDir: string, request: AdminRequest, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(adminSocketPath(dataDir));
    let buffer = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      socket.destroy();
      done(() => reject(new AdminError("the connector did not answer", "ETIMEDOUT")));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => (buffer += chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => done(() => reject(new AdminError(error.message, error.code))));
    socket.on("end", () =>
      done(() => {
        try {
          const response = JSON.parse(buffer) as { ok: true; result: T } | { ok: false; error: string };
          if (response.ok) resolve(response.result);
          else reject(new AdminError(response.error));
        } catch {
          reject(new AdminError("the connector sent an unreadable answer"));
        }
      }),
    );
  });
}
