/**
 * One ACP agent process: spawned with pipes, JSON-RPC 2.0 both ways, one JSON object per line. Nothing here knows about
 * sessions (`agent-process.ts` does).
 */

import { spawn, type ChildProcess } from "node:child_process";

import { UnavailableError } from "meshcall";

import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcErrorCode,
  type AcpAgentMethod,
  type AcpAgentMethods,
  type JsonRpcId,
} from "../core/acp-protocol.js";
import { DeviceOpsError } from "./device-ops.js";
import { IS_WINDOWS, killOnProcessExit, signalTree, spawnCommand } from "./process-tree.js";

const STDERR_TAIL_BYTES = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

/** A JSON-RPC error answered by the agent. */
export class AcpRequestError extends Error {
  override readonly name = "AcpRequestError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────────────────────────────────────────

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface AcpConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  killGraceMs?: number;
}

/** One agent process: line-delimited JSON-RPC 2.0 both ways. */
export class AcpConnection {
  readonly child: ChildProcess;
  /** Resolves when the process has exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  onRequest: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  onNotification: ((method: string, params: unknown) => void) | undefined;
  onExit: ((info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void) | undefined;

  #buffer = "";
  #nextId = 1;
  #pending = new Map<JsonRpcId, PendingCall>();
  #stderr = "";
  #closed = false;
  readonly #requestTimeoutMs: number;
  readonly #killGraceMs: number;

  private constructor(child: ChildProcess, options: AcpConnectionOptions) {
    this.child = child;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // A closed stdin (the agent died) must not crash the Connector with EPIPE.
    child.stdin?.on("error", () => undefined);
    const untrack = killOnProcessExit(() => this.#signal("SIGKILL"));
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.#closed = true;
        untrack();
        const error = new UnavailableError(`the agent exited (${signal ?? code ?? "unknown"})${this.#stderr ? `: ${this.#stderr.trim().slice(-500)}` : ""}`);
        for (const call of this.#pending.values()) {
          if (call.timer) clearTimeout(call.timer);
          call.reject(error);
        }
        this.#pending.clear();
        try {
          this.onExit?.({ code, signal, stderr: this.#stderr });
        } catch {
          // Exit listeners never throw into the event loop.
        }
        resolve({ code, signal });
      });
    });
  }

  static async spawn(options: AcpConnectionOptions): Promise<AcpConnection> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, options.env ?? {});
    const { command, args, verbatim } = spawnCommand(options.command, options.args);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(new UnavailableError(`could not start ${options.command}: ${error.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    child.on("error", () => undefined);
    return new AcpConnection(child, options);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  request<M extends AcpAgentMethod>(method: M, params: AcpAgentMethods[M]["params"], timeoutMs?: number | null): Promise<AcpAgentMethods[M]["result"]>;
  request(method: string, params: unknown, timeoutMs?: number | null): Promise<unknown>;
  request(method: string, params: unknown, timeoutMs: number | null = this.#requestTimeoutMs): Promise<unknown> {
    if (this.#closed) return Promise.reject(new UnavailableError("the agent is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const call: PendingCall = { method, resolve, reject, timer: undefined };
      if (timeoutMs !== null && timeoutMs > 0) {
        call.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new UnavailableError(`the agent did not answer ${method} within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, call);
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        this.#pending.delete(id);
        if (call.timer) clearTimeout(call.timer);
        reject(new UnavailableError("the agent's stdin is closed"));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** SIGTERM the process group, SIGKILL after the grace period. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.child.stdin?.end();
    this.#signal("SIGTERM");
    const timer = setTimeout(() => this.#signal("SIGKILL"), this.#killGraceMs);
    timer.unref();
    await this.exited;
    clearTimeout(timer);
  }

  #write(message: unknown): boolean {
    const stdin = this.child.stdin;
    if (this.#closed || !stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // agents sometimes log to stdout; not protocol
    }
    if (isJsonRpcResponse(message)) {
      if (message.id === null) return;
      const call = this.#pending.get(message.id);
      if (call === undefined) return;
      this.#pending.delete(message.id);
      if (call.timer) clearTimeout(call.timer);
      if ("error" in message) call.reject(new AcpRequestError(message.error.code, message.error.message, message.error.data));
      else call.resolve(message.result);
      return;
    }
    if (isJsonRpcRequest(message)) {
      const { id, method, params } = message;
      const handler = this.onRequest;
      if (handler === undefined) {
        this.#write({ jsonrpc: "2.0", id, error: { code: JsonRpcErrorCode.METHOD_NOT_FOUND, message: `unsupported: ${method}` } });
        return;
      }
      handler(method, params).then(
        (result) => this.#write({ jsonrpc: "2.0", id, result: result ?? null }),
        (error: unknown) => this.#write({ jsonrpc: "2.0", id, error: toJsonRpcError(error) }),
      );
      return;
    }
    if (isJsonRpcNotification(message)) {
      try {
        this.onNotification?.(message.method, message.params);
      } catch {
        // A projection failure must not stop reading the agent.
      }
    }
  }

  #signal(signal: NodeJS.Signals): void {
    if (!this.#closed) signalTree(this.child, signal);
  }
}

function toJsonRpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof AcpRequestError) return { code: error.code, message: error.message, data: error.data };
  if (error instanceof DeviceOpsError) {
    const code = error.code === "not_found" ? JsonRpcErrorCode.RESOURCE_NOT_FOUND : JsonRpcErrorCode.INVALID_PARAMS;
    return { code, message: error.message, data: { reason: error.code } };
  }
  return { code: JsonRpcErrorCode.INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) };
}
