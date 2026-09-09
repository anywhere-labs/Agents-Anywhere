import type { BackendControlMessage, BackendInit } from "./protocol";
import { BackendServer } from "./server";
import { BackendState, type BackendFetcher } from "./state";

/**
 * Entry point of the Desktop backend process.
 *
 * Main forks this file with `ELECTRON_RUN_AS_NODE=1`, passing the resolved paths
 * as base64 JSON in argv. The process reports `ready` as soon as the loopback
 * server is listening, then finishes the slow startup work in the background.
 */

const FETCH_TIMEOUT_MS = 30_000;

const init = parseInit();
// The Connector child inherits `process.env`; it must never look like Electron.
delete process.env.ELECTRON_RUN_AS_NODE;

const pendingFetches = new Map<number, {
  resolve: (value: Response) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();
let nextFetchId = 1;

function send(message: BackendControlMessage): void {
  process.send?.(message);
}

/** Device registration runs in this process but uses Main's Chromium network stack. */
const fetcher: BackendFetcher = (input, requestInit) => new Promise<Response>((resolve, reject) => {
  const id = nextFetchId++;
  const headers: Record<string, string> = {};
  new Headers(requestInit?.headers).forEach((value, key) => { headers[key] = value; });
  const body = typeof requestInit?.body === "string" ? requestInit.body : null;
  const timer = setTimeout(() => {
    pendingFetches.delete(id);
    reject(new Error("Desktop network request timed out."));
  }, FETCH_TIMEOUT_MS);
  timer.unref?.();
  pendingFetches.set(id, { resolve, reject, timer });
  send({ type: "netFetch", id, url: String(input), method: requestInit?.method ?? "GET", headers, body });
});

const state = new BackendState(init, fetcher);
const server = new BackendServer(state);

process.on("message", (message: BackendControlMessage) => {
  if (message.type === "netFetchResult") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(new Response(message.body, { status: message.status, headers: message.headers }));
    return;
  }
  if (message.type === "netFetchError") {
    const pending = pendingFetches.get(message.id);
    if (!pending) return;
    pendingFetches.delete(message.id);
    clearTimeout(pending.timer);
    pending.reject(new Error(message.message));
    return;
  }
  if (message.type === "shutdown") void shutdown("shutdown");
});

process.on("disconnect", () => void shutdown("disconnect"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  send({ type: "error", message: `Desktop backend crashed: ${error.message}` });
  process.exit(1);
});

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await state.shutdown();
    await server.close();
  } catch (error) {
    console.error(`Desktop backend shutdown failed after ${reason}`, error);
  }
  send({ type: "shutdownComplete" });
  process.exit(0);
}

server.start().then(({ port, token }) => {
  send({ type: "ready", port, token });
  // Slow startup work runs after `ready`; the window must not wait for it.
  void state.initialize().catch((error) => {
    send({ type: "error", message: `Desktop backend initialization failed: ${errorMessage(error)}` });
  });
}).catch((error) => {
  send({ type: "error", message: `Desktop backend failed to start: ${errorMessage(error)}` });
  process.exit(1);
});

function parseInit(): BackendInit {
  const encoded = process.argv[2] ?? "";
  if (!encoded) throw new Error("Desktop backend was started without an initialization payload.");
  const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Desktop backend initialization payload is invalid.");
  return parsed as BackendInit;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
