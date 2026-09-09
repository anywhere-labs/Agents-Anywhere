import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { DesktopSettings } from "./connector-types";
import type { OwnershipState } from "./local-runtime";
import {
  BACKEND_API_PREFIX,
  BACKEND_READY_TIMEOUT_MS,
  BACKEND_TOKEN_HEADER,
  type BackendControlMessage,
  type BackendEvent,
  type BackendInit,
} from "./backend/protocol";

const SHUTDOWN_GRACE_MS = 5_000;
const STREAM_RETRY_MS = 1_000;

export type BackendClientOptions = {
  /** Chromium network stack, so outbound requests honour the system proxy. */
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  onEvent?: (event: BackendEvent) => void;
  onExit?: (reason: string) => void;
  entryPath?: string;
};

/**
 * Main-process supervisor for the Desktop backend.
 *
 * It forks the backend, waits for the loopback port and token, keeps a
 * reconnecting SSE subscription for the snapshots Main itself needs (ownership,
 * settings), and proxies `net.fetch` requests from the backend so outbound
 * traffic keeps using Chromium's network stack.
 */
export class DesktopBackendClient {
  private child: ChildProcess | null = null;
  private port = 0;
  private authToken = "";
  private stream: AbortController | null = null;
  private closing = false;
  private started = false;
  private exitPromise: Promise<void> | null = null;
  private ownership: OwnershipState = { status: "error", message: "正在检查本机 Connector…" };
  private settings: DesktopSettings | null = null;

  constructor(private readonly options: BackendClientOptions) {}

  get baseUrl(): string {
    if (!this.port) throw new Error("Desktop backend is not ready.");
    return `http://127.0.0.1:${this.port}`;
  }

  get origin(): string {
    return this.baseUrl;
  }

  /**
   * Exposed only so the development renderer can bootstrap: it is served from
   * an HTTP origin where the same-origin `/desktop-api` proxy does not exist.
   */
  get token(): string {
    return this.authToken;
  }

  getOwnership(): OwnershipState {
    return this.ownership;
  }

  getSettings(): DesktopSettings | null {
    return this.settings;
  }

  async start(init: BackendInit): Promise<void> {
    if (this.started) return;
    this.started = true;
    const entry = this.options.entryPath ?? path.join(__dirname, "backend", "index.js");
    const payload = Buffer.from(JSON.stringify(init), "utf8").toString("base64");
    const child = fork(entry, [payload], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    // The bridge must outlive startup: device registration and reconnect keep
    // issuing netFetch long after the backend reports ready. A listener removed
    // with the startup handshake silently drops them, and the backend only
    // fails once its own request timeout expires.
    child.on("message", (message: BackendControlMessage) => {
      if (message.type === "netFetch") void this.handleNetFetch(message);
    });
    this.exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
        this.child = null;
        this.stream?.abort();
        this.stream = null;
        if (!this.closing) this.options.onExit?.(reason);
        resolve();
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[desktop-backend] ${chunk.toString("utf8").trimEnd()}`);
    });
    await this.waitForReady(child);
    void this.consumeEvents();
  }

  /** Internal calls made by the main process itself, never by the renderer. */
  request<T>(route: string, init: RequestInit = {}): Promise<T> {
    return this.fetchJson<T>(route, init);
  }

  /**
   * Proxies a renderer request to the backend. The token stays in this process,
   * so the renderer only ever sees its own origin.
   */
  proxy(request: Request, pathname: string, search: string): Promise<Response> {
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    headers.set(BACKEND_TOKEN_HEADER, this.authToken);
    const bodyless = request.method === "GET" || request.method === "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      signal: request.signal,
    };
    if (!bodyless) {
      init.body = request.body;
      init.duplex = "half";
    }
    return this.options.fetcher(`${this.baseUrl}${pathname}${search}`, init);
  }

  static proxyPath(pathname: string): string | null {
    if (!pathname.startsWith(`${BACKEND_API_PREFIX}/`)) return null;
    return pathname.slice(BACKEND_API_PREFIX.length);
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.closing = true;
    this.stream?.abort();
    this.stream = null;
    const child = this.child;
    if (!child) return;
    try {
      child.send({ type: "shutdown" } satisfies BackendControlMessage);
    } catch {
      // The channel is already gone; the exit race below handles it.
    }
    const exited = await Promise.race([
      this.exitPromise?.then(() => true) ?? Promise.resolve(true),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await this.exitPromise?.catch(() => undefined);
    }
  }

  private waitForReady(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        child.kill("SIGKILL");
        reject(new Error("Desktop backend did not become ready in time."));
      }, BACKEND_READY_TIMEOUT_MS);
      const onMessage = (message: BackendControlMessage) => {
        if (message.type === "ready") {
          this.port = message.port;
          this.authToken = message.token;
          cleanup();
          resolve();
          return;
        }
        if (message.type === "error") {
          cleanup();
          reject(new Error(message.message));
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Desktop backend exited before it became ready."));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
    });
  }

  private async handleNetFetch(message: Extract<BackendControlMessage, { type: "netFetch" }>): Promise<void> {
    try {
      const response = await this.options.fetcher(message.url, {
        method: message.method,
        headers: message.headers,
        body: message.body ?? undefined,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const body = await response.text();
      this.child?.send({
        type: "netFetchResult",
        id: message.id,
        ok: response.ok,
        status: response.status,
        headers,
        body,
      } satisfies BackendControlMessage);
    } catch (error) {
      this.child?.send({
        type: "netFetchError",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      } satisfies BackendControlMessage);
    }
  }

  /**
   * Keeps one SSE subscription alive for the snapshots Main needs. A dropped
   * stream reconnects without disturbing the backend.
   */
  private async consumeEvents(): Promise<void> {
    while (!this.closing && this.child) {
      const controller = new AbortController();
      this.stream = controller;
      try {
        await this.readStream(controller.signal);
      } catch {
        // Reconnect below unless the client is shutting down.
      }
      this.stream = null;
      if (this.closing || !this.child) return;
      await delay(STREAM_RETRY_MS);
    }
  }

  private async readStream(signal: AbortSignal): Promise<void> {
    const response = await this.options.fetcher(`${this.baseUrl}/events`, {
      headers: { [BACKEND_TOKEN_HEADER]: this.authToken, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Desktop backend event stream failed (HTTP ${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        this.dispatchFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private dispatchFrame(frame: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (event === "ownership") this.ownership = parsed as OwnershipState;
    else if (event === "settings") this.settings = parsed as DesktopSettings;
    else if (!["state", "logs", "logsCleared"].includes(event)) return;
    this.options.onEvent?.({ event: event as BackendEvent["event"], data: parsed });
  }

  private async fetchJson<T>(route: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set(BACKEND_TOKEN_HEADER, this.authToken);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await this.options.fetcher(`${this.baseUrl}${route}`, { ...init, headers });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) {
      const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Desktop backend request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return payload as T;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
