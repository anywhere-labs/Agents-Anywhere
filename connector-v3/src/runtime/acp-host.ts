/**
 * Generic ACP runtime host: runs any agent that speaks the Agent Client Protocol (JSON-RPC 2.0, one JSON object
 * per line over stdio) and projects its output into the `SessionStore`.
 *
 * One agent process per aa.v3 session: the agent gets the session's `cwd`, a crash takes down only that
 * conversation, and closing a session kills its whole process group. The process is started lazily (on create or
 * on the first prompt after a Connector restart).
 *
 * Agent → client requests handled here:
 *   - `session/request_permission` → a `PendingRequest` in the store; the first answer any client gives
 *     (`SessionStore.answerPendingRequest`) is written back as `{ outcome: { outcome: "selected", optionId } }`,
 *     a cancel as `{ outcome: { outcome: "cancelled" } }`.
 *   - `fs/read_text_file`, `fs/write_text_file` → `device-ops.ts`, relative paths against the session `cwd`,
 *     bounded by the RPC file cap.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile as readFileBytes, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { InvalidArgumentError, MeshCallError, UnavailableError } from "meshcall";

import {
  ACP_PROTOCOL_VERSION,
  AcpTimelineProjector,
  configFromSessionResult,
  configOptionsFromAcp,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcErrorCode,
  MODE_CONFIG_ID,
  type AcpAgentMethod,
  type AcpAgentMethods,
  type AcpAvailableCommand,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpReadTextFileParams,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotificationParams,
  type AcpStopReason,
  type AcpWriteTextFileParams,
  type JsonRpcId,
} from "../core/acp-protocol.js";
import type { AcpRuntimePreset } from "../core/config.js";
import type { AnswerInput, AnswerResult, SessionStore } from "../core/session-store.js";
import type { ConfigOption } from "../core/timeline.js";
import { DeviceOpsError, readFile, resolveUserPath, writeFile } from "./device-ops.js";
import { DEFAULT_MAX_RPC_FILE_BYTES } from "./state-store.js";

export type { AcpRuntimePreset } from "../core/config.js";

const IS_WINDOWS = process.platform === "win32";
const STDERR_TAIL_BYTES = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** `initialize` / `session/new`: the first start of an `npx` agent downloads it, which can take minutes. */
const STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

// ── Public types ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PushEvent {
  event_type: "approval" | "activity" | "error";
  session_id: string;
  title: string;
  body?: string;
}

export type TurnResult = AcpStopReason | "error";

export interface StartSessionInput {
  /** The aa.v3 session id (already created in the store). */
  sessionId: string;
  cwd: string;
}

export interface StartedSession {
  acpSessionId: string;
  config: ConfigOption[];
}

/** A runtime that can drive aa.v3 sessions. `AcpRuntime` is the ACP implementation; tests may add others. */
export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  startSession(input: StartSessionInput): Promise<StartedSession>;
  /** Run one turn; resolves when the turn ends (never rejects for agent failures: those end as `"error"`). */
  sendPrompt(sessionId: string, input: { turnId: string; prompt: AcpContentBlock[] }): Promise<TurnResult>;
  cancel(sessionId: string): Promise<void>;
  setConfig(sessionId: string, configId: string, value: string): Promise<ConfigOption[]>;
  answerPermission(sessionId: string, input: AnswerInput): AnswerResult;
  hasSession(sessionId: string): boolean;
  isTurnRunning(sessionId: string): boolean;
  availableCommands(sessionId: string): AcpAvailableCommand[];
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Built-in ACP agents. Each is offered only when the program it needs is installed on this machine
 * (`requires`), so a device never advertises an agent that cannot start.
 */
const BUILTIN_PRESETS: (AcpRuntimePreset & { requires: string })[] = [
  { id: "claude", name: "Claude Code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], requires: "claude" },
  { id: "codex", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], requires: "codex" },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], requires: "gemini" },
  { id: "antigravity", name: "Antigravity", command: "agy", args: ["acp"], requires: "agy" },
  // Pi prints a banner (version, skills, model) as plain agent text right after session/new; it has no marker, so it
  // would land in the conversation as a reply. The model is already in the session's config options.
  { id: "pi", name: "Pi", command: "npx", args: ["-y", "@openma/pi-acp", "--quiet-startup"], requires: "pi" },
];

export function defaultAcpPresets(isInstalled: (program: string) => boolean = commandOnPath): AcpRuntimePreset[] {
  return BUILTIN_PRESETS.filter((p) => isInstalled(p.requires) && isInstalled(p.command)).map(
    ({ requires: _requires, ...preset }) => preset,
  );
}

/** Whether `program` resolves on PATH (or is an existing absolute path). */
export function commandOnPath(program: string): boolean {
  if (path.isAbsolute(program)) return existsSync(program);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(path.join(dir, program + ext))) return true;
  }
  return false;
}

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
  readonly #onProcessExit = () => this.#killSync();

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
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.#closed = true;
        process.off("exit", this.#onProcessExit);
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
    process.once("exit", this.#onProcessExit);
  }

  static async spawn(options: AcpConnectionOptions): Promise<AcpConnection> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, options.env ?? {});
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true,
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
    const pid = this.child.pid;
    if (pid === undefined || this.#closed) return;
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  #killSync(): void {
    this.#signal("SIGKILL");
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

// ── AcpRuntime: one preset, many sessions ───────────────────────────────────────────────────────────────────────

interface LiveSession {
  sessionId: string;
  acpSessionId: string;
  cwd: string;
  conn: AcpConnection;
  projector: AcpTimelineProjector;
  turn: Promise<TurnResult> | undefined;
  /** Waiting `session/request_permission` calls, answered `cancelled` on cancel. */
  permissions: Map<string, (result: AcpRequestPermissionResult) => void>;
  supportsConfigOptions: boolean;
  /** The agent accepts image content blocks (`promptCapabilities.image`). */
  promptImages: boolean;
}

/** Images up to this size are sent to agents that take images inline; bigger ones stay file links. */
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Replace `file://` links to images with inline image blocks the agent can see directly. */
async function inlineImages(prompt: AcpContentBlock[]): Promise<AcpContentBlock[]> {
  return Promise.all(
    prompt.map(async (block) => {
      if (block.type !== "resource_link" || !block.mimeType?.startsWith("image/") || !block.uri.startsWith("file:")) return block;
      if (typeof block.size === "number" && block.size > INLINE_IMAGE_MAX_BYTES) return block;
      try {
        const file = fileURLToPath(block.uri);
        const info = await stat(file);
        if (!info.isFile() || info.size > INLINE_IMAGE_MAX_BYTES) return block;
        const data = (await readFileBytes(file)).toString("base64");
        return { type: "image", data, mimeType: block.mimeType, uri: block.uri } as AcpContentBlock;
      } catch {
        return block;
      }
    }),
  );
}

export interface AcpRuntimeOptions {
  store: SessionStore;
  newId?: () => string;
  onPushEvent?: (event: PushEvent) => void;
  /** Current RPC file cap (settings may change at runtime). */
  maxFileBytes?: () => number;
  requestTimeoutMs?: number;
  /** Timeout for `initialize` and `session/new` (default 5 min: the first `npx` start downloads the agent). */
  startupTimeoutMs?: number;
  killGraceMs?: number;
  clientInfo?: { name: string; version: string };
}

export class AcpRuntime implements AgentRuntime {
  readonly id: string;
  readonly name: string;
  readonly preset: AcpRuntimePreset;
  readonly #options: AcpRuntimeOptions;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #starting = new Map<string, Promise<StartedSession>>();

  constructor(preset: AcpRuntimePreset, options: AcpRuntimeOptions) {
    this.preset = { ...preset, args: [...(preset.args ?? [])] };
    this.id = preset.id;
    this.name = preset.name;
    this.#options = options;
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  isTurnRunning(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.turn !== undefined;
  }

  availableCommands(sessionId: string): AcpAvailableCommand[] {
    return [...(this.#sessions.get(sessionId)?.projector.availableCommands ?? [])];
  }

  startSession(input: StartSessionInput): Promise<StartedSession> {
    const live = this.#sessions.get(input.sessionId);
    if (live !== undefined) return Promise.resolve({ acpSessionId: live.acpSessionId, config: this.#options.store.get(input.sessionId)?.config ?? [] });
    const pending = this.#starting.get(input.sessionId);
    if (pending !== undefined) return pending;
    const started = this.#start(input).finally(() => this.#starting.delete(input.sessionId));
    this.#starting.set(input.sessionId, started);
    return started;
  }

  async #start(input: StartSessionInput): Promise<StartedSession> {
    const store = this.#options.store;
    const conn = await AcpConnection.spawn({
      command: this.preset.command,
      args: this.preset.args,
      cwd: input.cwd,
      ...(this.preset.env ? { env: this.preset.env } : {}),
      ...(this.#options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.#options.requestTimeoutMs } : {}),
      ...(this.#options.killGraceMs !== undefined ? { killGraceMs: this.#options.killGraceMs } : {}),
    });
    try {
      const init = (await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: this.#options.clientInfo ?? { name: "agents-anywhere-connector", version: "3" },
      }, this.#options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)) as AcpInitializeResult;
      if (typeof init?.protocolVersion !== "number") throw new UnavailableError("the agent answered initialize without a protocolVersion");
      const result = await conn.request("session/new", { cwd: input.cwd, mcpServers: [] }, this.#options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
      if (typeof result?.sessionId !== "string" || result.sessionId.length === 0) {
        throw new UnavailableError("the agent answered session/new without a sessionId");
      }
      const projector = new AcpTimelineProjector({
        store,
        sessionId: input.sessionId,
        ...(this.#options.newId ? { newId: this.#options.newId } : {}),
      });
      const live: LiveSession = {
        sessionId: input.sessionId,
        acpSessionId: result.sessionId,
        cwd: input.cwd,
        conn,
        projector,
        turn: undefined,
        permissions: new Map(),
        supportsConfigOptions: Array.isArray(result.configOptions),
        promptImages: init.agentCapabilities?.promptCapabilities?.image === true,
      };
      conn.onNotification = (method, params) => {
        if (method !== "session/update") return;
        const p = params as AcpSessionNotificationParams;
        if (!store.has(input.sessionId)) return;
        projector.handleNotification(p, live.acpSessionId);
      };
      conn.onRequest = (method, params) => this.#handleAgentRequest(live, method, params);
      conn.onExit = () => this.#onExit(live);
      this.#sessions.set(input.sessionId, live);
      const config = configFromSessionResult(result);
      if (store.has(input.sessionId)) {
        store.updateSession(input.sessionId, { config });
        store.updateControl(input.sessionId, { state: "idle", error: undefined });
      }
      return { acpSessionId: result.sessionId, config };
    } catch (error) {
      await conn.close();
      throw error instanceof MeshCallError ? error : new UnavailableError(`could not start ${this.name}: ${errorMessage(error)}`);
    }
  }

  sendPrompt(sessionId: string, input: { turnId: string; prompt: AcpContentBlock[] }): Promise<TurnResult> {
    const live = this.#require(sessionId);
    if (live.turn !== undefined) return Promise.reject(new MeshCallError("failed_precondition", "a turn is already running", { details: { reason: "turn_running" } }));
    live.projector.beginTurn(input.turnId, input.prompt);
    const turn = (async (): Promise<TurnResult> => {
      let outcome: TurnResult;
      let failure: string | undefined;
      try {
        const prompt = live.promptImages ? await inlineImages(input.prompt) : input.prompt;
        const result = await live.conn.request("session/prompt", { sessionId: live.acpSessionId, prompt }, null);
        outcome = result?.stopReason ?? "end_turn";
      } catch (error) {
        outcome = "error";
        failure = errorMessage(error);
      }
      this.#cancelPermissions(live);
      live.turn = undefined;
      if (this.#options.store.has(sessionId)) {
        try {
          if (outcome === "error") live.projector.endTurn("error", failure);
          else live.projector.endTurn(outcome);
        } catch {
          // The session was deleted while the turn ran.
        }
      }
      this.#pushTurnEnd(sessionId, input.turnId, outcome, failure);
      return outcome;
    })();
    live.turn = turn;
    return turn;
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) return;
    live.conn.notify("session/cancel", { sessionId: live.acpSessionId });
    // ACP: the client answers every waiting permission request `cancelled`, or the prompt never returns.
    this.#cancelPermissions(live);
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const live = this.#require(sessionId);
    const store = this.#options.store;
    let config: ConfigOption[];
    if (!live.supportsConfigOptions && configId === MODE_CONFIG_ID) {
      await live.conn.request("session/set_mode", { sessionId: live.acpSessionId, modeId: value });
      config = (store.get(sessionId)?.config ?? []).map((o) => (o.id === MODE_CONFIG_ID ? { ...o, current: value } : o));
    } else {
      try {
        const result = await live.conn.request("session/set_config_option", { sessionId: live.acpSessionId, configId, value });
        config = configOptionsFromAcp(result?.configOptions ?? []);
      } catch (error) {
        if (error instanceof AcpRequestError && error.code === JsonRpcErrorCode.INVALID_PARAMS) throw new InvalidArgumentError(error.message);
        throw error;
      }
    }
    if (store.has(sessionId)) store.updateSession(sessionId, { config });
    return config;
  }

  answerPermission(sessionId: string, input: AnswerInput): AnswerResult {
    // The projector listens to the store: the accepted answer resolves the agent's request.
    return this.#options.store.answerPendingRequest(sessionId, input);
  }

  async closeSession(sessionId: string): Promise<void> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) return;
    this.#sessions.delete(sessionId);
    this.#cancelPermissions(live);
    live.projector.dispose();
    await live.conn.close();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.closeSession(id)));
  }

  // ── Internals ──

  #require(sessionId: string): LiveSession {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) throw new UnavailableError(`the agent for session ${sessionId} is not running`);
    return live;
  }

  #onExit(live: LiveSession): void {
    if (this.#sessions.get(live.sessionId) !== live) return;
    this.#sessions.delete(live.sessionId);
    this.#cancelPermissions(live);
    live.projector.dispose();
    const store = this.#options.store;
    if (live.turn === undefined && store.has(live.sessionId)) {
      // Idle agent gone: the next prompt starts a fresh one. A running turn reports its own failure.
      store.updateControl(live.sessionId, { state: "idle" });
    }
  }

  #cancelPermissions(live: LiveSession): void {
    const store = this.#options.store;
    for (const [requestId, resolve] of live.permissions) {
      if (store.has(live.sessionId)) store.removePendingRequest(live.sessionId, requestId);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    live.permissions.clear();
  }

  async #handleAgentRequest(live: LiveSession, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.#requestPermission(live, params as AcpRequestPermissionParams);
      case "fs/read_text_file":
        return this.#readTextFile(live, params as AcpReadTextFileParams);
      case "fs/write_text_file":
        return this.#writeTextFile(live, params as AcpWriteTextFileParams);
      default:
        throw new AcpRequestError(JsonRpcErrorCode.METHOD_NOT_FOUND, `unsupported: ${method}`);
    }
  }

  async #requestPermission(live: LiveSession, params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    if (!params || !Array.isArray(params.options) || params.toolCall === undefined) {
      throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, "session/request_permission needs toolCall and options");
    }
    if (!this.#options.store.has(live.sessionId)) return { outcome: { outcome: "cancelled" } };
    const { request, outcome } = live.projector.requestPermission(params);
    const cancelled = new Promise<AcpRequestPermissionResult>((resolve) => live.permissions.set(request.request_id, resolve));
    this.#push({ event_type: "approval", session_id: live.sessionId, title: this.#title(live.sessionId), body: request.title.slice(0, 512) });
    try {
      return await Promise.race([outcome, cancelled]);
    } finally {
      live.permissions.delete(request.request_id);
    }
  }

  async #readTextFile(live: LiveSession, params: AcpReadTextFileParams): Promise<{ content: string }> {
    if (!params || typeof params.path !== "string") throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, "path is required");
    const target = resolveUserPath(params.path, live.cwd);
    const file = await readFile(target, { maxRpcFileBytes: this.#maxFileBytes() });
    if (file.encoding !== "utf8") throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, `${target} is not a text file`);
    let content = file.content;
    const line = typeof params.line === "number" && params.line > 0 ? Math.floor(params.line) : undefined;
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined;
    if (line !== undefined || limit !== undefined) {
      const lines = content.split("\n");
      const start = (line ?? 1) - 1;
      content = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
    }
    return { content };
  }

  async #writeTextFile(live: LiveSession, params: AcpWriteTextFileParams): Promise<null> {
    if (!params || typeof params.path !== "string" || typeof params.content !== "string") {
      throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, "path and content are required");
    }
    await writeFile(resolveUserPath(params.path, live.cwd), params.content, "utf8", this.#maxFileBytes());
    return null;
  }

  #maxFileBytes(): number {
    return this.#options.maxFileBytes?.() ?? DEFAULT_MAX_RPC_FILE_BYTES;
  }

  #title(sessionId: string): string {
    const title = this.#options.store.get(sessionId)?.title;
    return (title && title.length > 0 ? title : this.name).slice(0, 160);
  }

  #pushTurnEnd(sessionId: string, turnId: string, outcome: TurnResult, failure: string | undefined): void {
    const store = this.#options.store;
    if (!store.has(sessionId)) return;
    if (outcome === "error") {
      this.#push({ event_type: "error", session_id: sessionId, title: this.#title(sessionId), body: (failure ?? "the agent failed").slice(0, 512) });
      return;
    }
    if (outcome === "cancelled") return;
    const reply = turnReplyText(store, sessionId, turnId);
    const event: PushEvent = { event_type: "activity", session_id: sessionId, title: this.#title(sessionId) };
    if (reply) event.body = reply.slice(0, 512);
    this.#push(event);
  }

  #push(event: PushEvent): void {
    try {
      this.#options.onPushEvent?.(event);
    } catch {
      // Notifications are best effort.
    }
  }
}

/** The assistant text of one turn (its `TextPart` items, in order). */
export function turnReplyText(store: SessionStore, sessionId: string, turnId: string): string {
  if (!store.has(sessionId)) return "";
  const texts: string[] = [];
  let before: number | undefined;
  // Walk back page by page until the turn's user message.
  for (;;) {
    const page = store.listMessages(sessionId, before === undefined ? { limit: 500 } : { before_seq: before, limit: 500 });
    let reachedStart = false;
    for (let i = page.messages.length - 1; i >= 0; i--) {
      const message = page.messages[i];
      if (message === undefined) continue;
      if (message.id === turnId) {
        reachedStart = true;
        break;
      }
      if (message.role === "assistant" && message.turn_id === turnId && message.parts[0].type === "text") texts.unshift(message.parts[0].text);
    }
    if (reachedStart || !page.has_more || page.messages.length === 0) break;
    before = page.messages[0]?.seq;
  }
  return texts.join("\n\n");
}

// ── AcpRuntimeHost: the runtimes of this device ─────────────────────────────────────────────────────────────────

export interface AcpRuntimeHostOptions extends AcpRuntimeOptions {
  presets?: AcpRuntimePreset[];
  /** Add `defaultAcpPresets()` for ids not given in `presets`. Default true. */
  includeDefaultPresets?: boolean;
}

/** Runtimes by id, and session-level operations routed to the runtime the session was created with. */
export class AcpRuntimeHost {
  readonly store: SessionStore;
  readonly #options: AcpRuntimeHostOptions;
  readonly #runtimes = new Map<string, AgentRuntime>();
  /** Config chosen while the agent was not running, applied when it starts. */
  readonly #pendingConfig = new Map<string, Map<string, string>>();
  onPushEvent: ((event: PushEvent) => void) | undefined;

  constructor(options: AcpRuntimeHostOptions) {
    this.store = options.store;
    this.onPushEvent = options.onPushEvent;
    this.#options = { ...options, onPushEvent: (event) => this.onPushEvent?.(event) };
    for (const preset of options.presets ?? []) this.registerPreset(preset);
    if (options.includeDefaultPresets ?? true) {
      for (const preset of defaultAcpPresets()) if (!this.#runtimes.has(preset.id)) this.registerPreset(preset);
    }
  }

  registerPreset(preset: AcpRuntimePreset): AcpRuntime {
    const runtime = new AcpRuntime(preset, this.#options);
    this.registerRuntime(runtime);
    return runtime;
  }

  registerRuntime(runtime: AgentRuntime): void {
    if (!runtime.id) throw new TypeError("a runtime needs an id");
    this.#runtimes.set(runtime.id, runtime);
  }

  list(): { id: string; name: string }[] {
    return [...this.#runtimes.values()].map((r) => ({ id: r.id, name: r.name }));
  }

  has(runtimeId: string): boolean {
    return this.#runtimes.has(runtimeId);
  }

  runtime(runtimeId: string): AgentRuntime {
    const runtime = this.#runtimes.get(runtimeId);
    if (runtime === undefined) throw new InvalidArgumentError(`no agent runtime "${runtimeId}" on this device`, { details: { reason: "unknown_agent" } });
    return runtime;
  }

  /** The runtime of an existing session. */
  runtimeFor(sessionId: string): AgentRuntime {
    const session = this.store.get(sessionId);
    if (session === undefined) throw new MeshCallError("not_found", `no session ${sessionId}`, { details: { reason: "session_not_found", session_id: sessionId } });
    return this.runtime(session.agent);
  }

  isLive(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    return session !== undefined && (this.#runtimes.get(session.agent)?.hasSession(sessionId) ?? false);
  }

  isTurnRunning(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    return session !== undefined && (this.#runtimes.get(session.agent)?.isTurnRunning(sessionId) ?? false);
  }

  /** Start the session's agent if it is not running (create, or the first prompt after a restart). */
  async ensureSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (session === undefined) throw new MeshCallError("not_found", `no session ${sessionId}`, { details: { reason: "session_not_found" } });
    const runtime = this.runtime(session.agent);
    if (runtime.hasSession(sessionId)) return;
    await runtime.startSession({ sessionId, cwd: session.cwd });
    const pending = this.#pendingConfig.get(sessionId);
    if (pending !== undefined) {
      this.#pendingConfig.delete(sessionId);
      for (const [configId, value] of pending) {
        try {
          await runtime.setConfig(sessionId, configId, value);
        } catch {
          // A stale choice the agent no longer offers is dropped.
        }
      }
    }
  }

  async prompt(sessionId: string, turnId: string, prompt: AcpContentBlock[]): Promise<TurnResult> {
    await this.ensureSession(sessionId);
    return this.runtimeFor(sessionId).sendPrompt(sessionId, { turnId, prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.store.has(sessionId)) return;
    await this.runtimeFor(sessionId).cancel(sessionId);
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const runtime = this.runtimeFor(sessionId);
    if (runtime.hasSession(sessionId)) return runtime.setConfig(sessionId, configId, value);
    const session = this.store.get(sessionId);
    const config = (session?.config ?? []).map((o) => (o.id === configId ? { ...o, current: value } : o));
    let pending = this.#pendingConfig.get(sessionId);
    if (pending === undefined) this.#pendingConfig.set(sessionId, (pending = new Map()));
    pending.set(configId, value);
    this.store.updateSession(sessionId, { config });
    return config;
  }

  availableCommands(sessionId: string): AcpAvailableCommand[] {
    if (!this.store.has(sessionId)) return [];
    return this.runtimeFor(sessionId).availableCommands(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.#pendingConfig.delete(sessionId);
    const session = this.store.get(sessionId);
    if (session === undefined) {
      await Promise.all([...this.#runtimes.values()].map((r) => r.closeSession(sessionId)));
      return;
    }
    await this.#runtimes.get(session.agent)?.closeSession(sessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#runtimes.values()].map((r) => r.dispose()));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
