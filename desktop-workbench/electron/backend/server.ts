import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { BACKEND_TOKEN_HEADER, type BackendEventName } from "./protocol";
import type { BackendState } from "./state";

const MAX_BODY_BYTES = 1_024 * 1_024;
const SSE_PING_MS = 15_000;
const SSE_RETRY_MS = 1_000;

const EVENTS: readonly BackendEventName[] = ["ownership", "state", "logs", "logsCleared", "settings"];

/**
 * Loopback HTTP API for the Desktop backend.
 *
 * It binds an ephemeral port on 127.0.0.1 and requires a per-launch token on
 * every request. The main process is the only client: it proxies the same API
 * to the renderer under the app origin, so the port and token never leave the
 * app shell.
 */
export class BackendServer {
  private server: Server | null = null;
  private readonly clients = new Set<ServerResponse>();
  private readonly token = randomBytes(32).toString("base64url");
  private readonly listeners = new Map<BackendEventName, (data: unknown) => void>();

  constructor(private readonly state: BackendState) {}

  async start(): Promise<{ port: number; token: string }> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    server.on("clientError", (_error, socket: Socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Desktop backend did not bind a loopback port.");
    for (const event of EVENTS) {
      const listener = (data: unknown) => this.broadcast(event, data);
      this.listeners.set(event, listener);
      this.state.on(event, listener);
    }
    return { port: address.port, token: this.token };
  }

  async close(): Promise<void> {
    for (const [event, listener] of this.listeners) this.state.off(event, listener);
    this.listeners.clear();
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const origin = request.headers.origin;
    if (origin) {
      // Development only: the renderer is served over HTTP there, so its
      // preflighted requests need CORS. The token below stays the boundary.
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": `${BACKEND_TOKEN_HEADER}, content-type`,
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    if (request.headers[BACKEND_TOKEN_HEADER] !== this.token) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    if (url.pathname === "/events") {
      this.streamEvents(request, response);
      return;
    }
    try {
      const body = await readJsonBody(request);
      const result = await this.route(request.method ?? "GET", url, body);
      sendJson(response, 200, result ?? null);
    } catch (error) {
      sendJson(response, 400, { error: errorMessage(error) });
    }
  }

  private route(method: string, url: URL, body: Record<string, unknown>): unknown {
    const path = url.pathname;
    if (method === "GET") {
      if (path === "/state") return this.state.getConnectorState();
      if (path === "/config") return this.state.getPublicConfig();
      if (path === "/settings") return this.state.getSettings();
      if (path === "/onboarding") return this.state.getOnboarding();
      if (path === "/ownership") return this.state.ownershipState();
      if (path === "/logs") return this.state.readLogs({
        pageSize: numberOrUndefined(url.searchParams.get("pageSize")),
        beforeSeq: numberOrUndefined(url.searchParams.get("beforeSeq")),
        afterSeq: numberOrUndefined(url.searchParams.get("afterSeq")),
      });
      if (path === "/device/binding") return this.state.getLocalBinding();
    }
    if (method === "POST") {
      if (path === "/config") return this.state.saveConfig(body as never);
      if (path === "/settings") return this.state.saveSettings(body as never);
      if (path === "/onboarding/complete") return this.state.completeOnboarding(body);
      if (path === "/start") return this.state.startConnector();
      if (path === "/stop") return this.state.stopConnector();
      if (path === "/restart") return this.state.restartConnector();
      if (path === "/ownership/recheck") return this.state.recheckOwnership();
      if (path === "/ownership/acquire") return this.state.acquireOwnershipOrThrow();
      if (path === "/server") return this.state.setServerConnection(body);
      if (path === "/logs/clear") return this.state.clearLogs();
      if (path === "/logs/append") {
        this.state.appendLog({
          level: typeof body.level === "string" ? body.level : "INFO",
          message: String(body.message ?? ""),
        });
        return { appended: true };
      }
      if (path === "/logs/export") return { count: this.state.exportLogs(String(body.filePath ?? "")) };
      if (path === "/device/create") return this.state.createAndConnect(body as never);
      if (path === "/device/reconnect") return this.state.reconnectAndConnect(body as never);
      if (path === "/device/disconnect") return this.state.disconnectLocal(body as never);
      if (path === "/device/rename") return this.state.updateLocalBindingName(String(body.name ?? ""));
    }
    throw new Error(`Unknown Desktop backend route: ${method} ${path}`);
  }

  /**
   * One SSE stream per subscriber. The initial frames carry the current
   * ownership and settings so a late subscriber is never blind, and log entries
   * arrive pre-batched from `BackendState`.
   */
  private streamEvents(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`retry: ${SSE_RETRY_MS}\n\n`);
    // Ownership is deliberately not sent here: until the first real probe
    // finishes the value is a placeholder, and the renderer must show its
    // loading state rather than an error dialog.
    this.send(response, "settings", this.state.getSettings());
    this.clients.add(response);
    const ping = setInterval(() => {
      if (!response.writableEnded) response.write(": ping\n\n");
    }, SSE_PING_MS);
    ping.unref?.();
    const cleanup = () => {
      clearInterval(ping);
      this.clients.delete(response);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", cleanup);
  }

  private broadcast(event: BackendEventName, data: unknown): void {
    for (const client of this.clients) this.send(client, event, data);
  }

  private send(response: ServerResponse, event: BackendEventName, data: unknown): void {
    if (response.writableEnded) {
      this.clients.delete(response);
      return;
    }
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
    } catch {
      this.clients.delete(response);
    }
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload ?? null);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Body must be a JSON object.");
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
