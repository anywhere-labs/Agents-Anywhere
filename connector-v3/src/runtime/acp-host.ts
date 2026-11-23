/**
 * Generic ACP runtime host: runs any agent that speaks the Agent Client Protocol (JSON-RPC 2.0, one JSON object
 * per line over stdio) and projects its output into the `SessionStore`.
 *
 * One agent process per aa.v3 session: the agent gets the session's `cwd`, a crash takes down only that
 * conversation, and closing a session kills its whole process group. The process is started lazily (on create or
 * on the first prompt after a Connector restart).
 *
 * Prepared agents (`AcpRuntimeHost.prepare`, `aa.v3.Sessions/prepare`): a new-conversation page starts the agent
 * as soon as the user picks it, so its settings (model, mode, …) are known before the first message and an `npx`
 * download happens while the user types. The process waits after `session/new`; `create({ prepared_id })` takes it
 * over (no second `session/new`) and replays the `session/update`s it sent meanwhile. Unused ones are closed after
 * a TTL, beyond a per-device limit (least recently used first), and when the Connector stops.
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
  configWithMode,
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
  type AcpNewSessionResult,
  type AcpReadTextFileParams,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotificationParams,
  type AcpStopReason,
  type AcpWriteTextFileParams,
  type JsonRpcId,
} from "../core/acp-protocol.js";
import {
  AgentOverrideSchema,
  AgentOverridesSchema,
  AgentUpdateSchema,
  type AcpRuntimePreset,
  type AgentOverride,
  type AgentOverrides,
  type AgentUpdate,
} from "../core/config.js";
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
/** A prepared agent nobody took over is closed after this long without another `prepare` for it. */
const DEFAULT_PREPARED_TTL_MS = 10 * 60_000;
/** Prepared agents kept per device. */
const DEFAULT_MAX_PREPARED = 4;

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
  /**
   * A prepared agent of this runtime, handed over: the session takes it over when it still runs and was started for
   * this `cwd`; otherwise it is closed and the session starts its own agent.
   */
  prepared?: PreparedAgent;
}

export interface StartedSession {
  acpSessionId: string;
  config: ConfigOption[];
  /** The session took over a prepared agent instead of starting one. */
  prepared?: boolean;
}

/**
 * An agent started ahead of its conversation: `initialize` and `session/new` are done, so its settings are known
 * before the first message. `startSession({ prepared })` takes it over.
 */
export interface PreparedAgent {
  readonly cwd: string;
  readonly acpSessionId: string;
  /** Its settings now: the `session/new` answer plus the changes the agent reported since (same shape as `Session.config`). */
  readonly config: ConfigOption[];
  /** Still running and not taken over. */
  readonly usable: boolean;
  /** Told once when the process exits before a session took it over. */
  onExit: (() => void) | undefined;
  /** Stop the process (nothing once a session took it over). */
  close(): Promise<void>;
}

/** A runtime that can drive aa.v3 sessions. `AcpRuntime` is the ACP implementation; tests may add others. */
export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  startSession(input: StartSessionInput): Promise<StartedSession>;
  /** Start the agent ahead of a session in `cwd` (for `startSession({ prepared })`). Optional. */
  prepare?(input: { cwd: string }): Promise<PreparedAgent>;
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
  /** The preset it runs (ACP runtimes): what `update_agent` changes. Without it only `enabled` can be changed. */
  readonly preset?: AcpRuntimePreset;
  /** Run agent processes started from now on with `preset` (same id); running ones keep theirs. Optional. */
  configure?(preset: AcpRuntimePreset): void;
  /** Agent processes running now: the sessions' agents, prepared ones and ones still starting. Optional. */
  processCount?(): number;
  /**
   * Stop every agent process of this runtime (`stop_agent`): its sessions start the agent again on their next
   * message, and a turn still running ends `cancelled`. Resolves with how many processes there were. Optional:
   * `dispose` is used without it.
   */
  stop?(): Promise<number>;
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
  { id: "pi", name: "Pi", command: "npx", args: ["-y", "@openma/pi-acp"], requires: "pi" },
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

/** Kills of the agent processes still running, for when the Connector's own process exits. */
const RUNNING_AGENTS = new Set<() => void>();
let exitHookInstalled = false;

/** Kill `kill`'s agent if the Connector exits first: one `exit` listener for every agent, however many run. */
function killOnProcessExit(kill: () => void): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const killAgent of RUNNING_AGENTS) killAgent();
    });
  }
  RUNNING_AGENTS.add(kill);
  return () => RUNNING_AGENTS.delete(kill);
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
    const untrack = killOnProcessExit(() => this.#killSync());
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
  /** Stopped on purpose (`stop`): a turn the exit interrupts ended `cancelled`, not failed. */
  stopped: boolean;
}

/** An agent process after `initialize` + `session/new`, not yet projected into a session. */
interface Launched {
  conn: AcpConnection;
  init: AcpInitializeResult;
  result: AcpNewSessionResult & { sessionId: string };
  /** `session/update`s sent before a session listened, oldest first (see `bufferUpdate`). */
  updates: AcpSessionNotificationParams[];
}

/** Updates that carry only the latest state: a newer one replaces the older one while they wait in a buffer. */
const STATE_UPDATES: ReadonlySet<string> = new Set(["available_commands_update", "config_option_update", "current_mode_update"]);
/** Other updates kept while no session listens; an idle agent sends few (a banner, say), this only bounds a chatty one. */
const MAX_BUFFERED_UPDATES = 200;

function bufferUpdate(buffer: AcpSessionNotificationParams[], params: AcpSessionNotificationParams): void {
  const kind = params?.update?.sessionUpdate;
  if (typeof kind !== "string") return;
  if (STATE_UPDATES.has(kind)) {
    const older = buffer.findIndex((p) => p.sessionId === params.sessionId && p.update.sessionUpdate === kind);
    if (older >= 0) buffer.splice(older, 1);
  } else if (buffer.length >= MAX_BUFFERED_UPDATES) {
    return;
  }
  buffer.push(params);
}

/** The settings of a launched agent: its `session/new` answer with the buffered setting changes applied. */
function configOfLaunched(launched: Launched): ConfigOption[] {
  let config = configFromSessionResult(launched.result);
  for (const { sessionId, update } of launched.updates) {
    if (sessionId !== launched.result.sessionId) continue;
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) config = configOptionsFromAcp(update.configOptions);
    else if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") config = configWithMode(config, update.currentModeId);
  }
  return config;
}

/** `PreparedAgent` of an `AcpRuntime`: keeps buffering the agent's updates until a session takes it over. */
class WarmAgent implements PreparedAgent {
  readonly cwd: string;
  readonly acpSessionId: string;
  onExit: (() => void) | undefined;
  readonly #owner: AcpRuntime;
  readonly #launched: Launched;
  readonly #onDone: () => void;
  #state: "waiting" | "taken" | "closed" = "waiting";

  constructor(
    owner: AcpRuntime,
    cwd: string,
    launched: Launched,
    onRequest: (method: string, params: unknown) => Promise<unknown>,
    /** Once it stops waiting (taken over, closed or exited). */
    onDone: () => void,
  ) {
    this.#owner = owner;
    this.cwd = cwd;
    this.acpSessionId = launched.result.sessionId;
    this.#launched = launched;
    this.#onDone = onDone;
    const { conn, updates } = launched;
    conn.onNotification = (method, params) => {
      if (method === "session/update") bufferUpdate(updates, params as AcpSessionNotificationParams);
    };
    conn.onRequest = onRequest;
    conn.onExit = () => {
      if (this.#state !== "waiting") return;
      this.#state = "closed";
      this.#onDone();
      try {
        this.onExit?.();
      } catch {
        // Exit listeners never throw into the event loop.
      }
    };
  }

  get config(): ConfigOption[] {
    return configOfLaunched(this.#launched);
  }

  get usable(): boolean {
    return this.#state === "waiting" && !this.#launched.conn.closed;
  }

  /** For `owner.startSession`: the process, now the session's; undefined when it cannot be taken over there. */
  takeOver(owner: AcpRuntime, cwd: string): Launched | undefined {
    if (owner !== this.#owner || cwd !== this.cwd || !this.usable) return undefined;
    this.#state = "taken";
    this.#onDone();
    return this.#launched;
  }

  async close(): Promise<void> {
    if (this.#state === "taken") return;
    if (this.#state === "waiting") {
      this.#state = "closed";
      this.#onDone();
    }
    await this.#launched.conn.close();
  }
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
  readonly #options: AcpRuntimeOptions;
  #preset: AcpRuntimePreset;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #starting = new Map<string, Promise<StartedSession>>();
  /** Agents between spawn and the end of `session/new`: `dispose` kills them too. */
  readonly #launching = new Set<AcpConnection>();
  /** Prepared agents not taken over yet. */
  readonly #prepared = new Set<WarmAgent>();
  /** Bumped by `dispose` / `stop`: a start that began before must not leave a process behind. */
  #generation = 0;
  /** Why the last `dispose` / `stop` happened, for the starts it cut short. */
  #stoppedBecause = "the Connector stopped";

  constructor(preset: AcpRuntimePreset, options: AcpRuntimeOptions) {
    this.#preset = copyPreset(preset);
    this.id = preset.id;
    this.#options = options;
  }

  /** The preset agent processes are started with (`configure` changes it). */
  get preset(): AcpRuntimePreset {
    return copyPreset(this.#preset);
  }

  get name(): string {
    return this.#preset.name;
  }

  /** Start agent processes from now on with `preset`; running ones keep the settings they were started with. */
  configure(preset: AcpRuntimePreset): void {
    if (preset.id !== this.id) throw new TypeError(`a runtime keeps its id (${this.id}, not ${preset.id})`);
    this.#preset = copyPreset(preset);
  }

  processCount(): number {
    return this.#sessions.size + this.#prepared.size + this.#launching.size;
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
    const pending = live === undefined ? this.#starting.get(input.sessionId) : undefined;
    const prepared = input.prepared;
    const launched = live === undefined && pending === undefined && prepared instanceof WarmAgent ? prepared.takeOver(this, input.cwd) : undefined;
    // A prepared agent handed over but not taken over (gone, another folder, already started) has no other owner.
    if (prepared !== undefined && launched === undefined) void prepared.close();
    if (live !== undefined) return Promise.resolve({ acpSessionId: live.acpSessionId, config: this.#options.store.get(input.sessionId)?.config ?? [] });
    if (pending !== undefined) return pending;
    if (launched !== undefined) {
      try {
        return Promise.resolve({ ...this.#attach(input.sessionId, input.cwd, launched), prepared: true });
      } catch (error) {
        void launched.conn.close();
        return Promise.reject(error);
      }
    }
    const started = this.#start(input).finally(() => this.#starting.delete(input.sessionId));
    this.#starting.set(input.sessionId, started);
    return started;
  }

  /**
   * Start the agent ahead of a session in `cwd`: `initialize` + `session/new`, then it waits (buffering its updates)
   * until `startSession({ prepared })` takes it over or it is closed. Rejects like a session start (`#startError`).
   */
  async prepare(input: { cwd: string }): Promise<PreparedAgent> {
    const generation = this.#generation;
    const launched = await this.#launch(input.cwd);
    const agent: WarmAgent = new WarmAgent(
      this,
      input.cwd,
      launched,
      (method, params) => this.#handleAgentRequest(input.cwd, undefined, method, params),
      () => this.#prepared.delete(agent),
    );
    this.#prepared.add(agent);
    if (generation !== this.#generation) {
      await agent.close();
      throw this.#startError(new UnavailableError(`${this.#stoppedBecause} while it started`));
    }
    return agent;
  }

  async #start(input: StartSessionInput): Promise<StartedSession> {
    const generation = this.#generation;
    const launched = await this.#launch(input.cwd);
    try {
      if (generation !== this.#generation) throw this.#startError(new UnavailableError(`${this.#stoppedBecause} while it started`));
      return this.#attach(input.sessionId, input.cwd, launched);
    } catch (error) {
      await launched.conn.close();
      throw error;
    }
  }

  /** Spawn the agent, `initialize`, `session/new`. Any failure rejects with `#startError`. */
  async #launch(cwd: string): Promise<Launched> {
    // The settings at this moment: a later `configure` applies to later starts only.
    const preset = this.#preset;
    const generation = this.#generation;
    let conn: AcpConnection;
    try {
      conn = await AcpConnection.spawn({
        command: preset.command,
        args: preset.args,
        cwd,
        ...(preset.env ? { env: preset.env } : {}),
        ...(this.#options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.#options.requestTimeoutMs } : {}),
        ...(this.#options.killGraceMs !== undefined ? { killGraceMs: this.#options.killGraceMs } : {}),
      });
    } catch (error) {
      throw this.#startError(error);
    }
    this.#launching.add(conn);
    // Listen before `session/new`: agents report commands and settings right behind the answer, often in the same read.
    const updates: AcpSessionNotificationParams[] = [];
    conn.onNotification = (method, params) => {
      if (method === "session/update") bufferUpdate(updates, params as AcpSessionNotificationParams);
    };
    let init: AcpInitializeResult | undefined;
    try {
      const timeoutMs = this.#options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
      init = (await conn.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: this.#options.clientInfo ?? { name: "agents-anywhere-connector", version: "3" },
      }, timeoutMs)) as AcpInitializeResult;
      if (typeof init?.protocolVersion !== "number") throw new UnavailableError("the agent answered initialize without a protocolVersion");
      const result = await conn.request("session/new", { cwd, mcpServers: [] }, timeoutMs);
      if (typeof result?.sessionId !== "string" || result.sessionId.length === 0) {
        throw new UnavailableError("the agent answered session/new without a sessionId");
      }
      return { conn, init, result: result as Launched["result"], updates };
    } catch (error) {
      await conn.close();
      // Killed by `dispose` / `stop` (it exited, so the request failed): say so rather than "the agent exited".
      throw this.#startError(generation === this.#generation ? error : new UnavailableError(`${this.#stoppedBecause} while it started`), init);
    } finally {
      this.#launching.delete(conn);
    }
  }

  /** Make a launched agent the live agent of a session, as if the projector had listened from the start. */
  #attach(sessionId: string, cwd: string, launched: Launched): StartedSession {
    const store = this.#options.store;
    const { conn, init, result, updates } = launched;
    if (conn.closed) throw this.#startError(new UnavailableError(`the agent exited${conn.stderrTail ? `: ${conn.stderrTail.trim().slice(-500)}` : ""}`));
    const projector = new AcpTimelineProjector({
      store,
      sessionId,
      ...(this.#options.newId ? { newId: this.#options.newId } : {}),
    });
    const live: LiveSession = {
      sessionId,
      acpSessionId: result.sessionId,
      cwd,
      conn,
      projector,
      turn: undefined,
      permissions: new Map(),
      supportsConfigOptions: Array.isArray(result.configOptions),
      promptImages: init.agentCapabilities?.promptCapabilities?.image === true,
      stopped: false,
    };
    conn.onRequest = (method, params) => this.#handleAgentRequest(cwd, live, method, params);
    conn.onExit = () => this.#onExit(live);
    this.#sessions.set(sessionId, live);
    if (store.has(sessionId)) {
      store.updateSession(sessionId, { config: configFromSessionResult(result) });
      store.updateControl(sessionId, { state: "idle", error: undefined });
      // What the agent sent before anyone listened (commands, setting changes, a banner, …).
      for (const params of updates) {
        try {
          projector.handleNotification(params, live.acpSessionId);
        } catch {
          // As for live updates: a projection failure must not stop the session.
        }
      }
    }
    updates.length = 0;
    conn.onNotification = (method, params) => {
      if (method !== "session/update") return;
      const p = params as AcpSessionNotificationParams;
      if (!store.has(sessionId)) return;
      projector.handleNotification(p, live.acpSessionId);
    };
    return { acpSessionId: result.sessionId, config: store.get(sessionId)?.config ?? configFromSessionResult(result) };
  }

  /**
   * Why the agent did not start, worded for the user (one "could not start …" prefix) with a stable reason:
   * `failed_precondition` / `agent_auth_required` when the agent wants a sign-in first (ACP `-32000`; the agent's
   * `authMethods` go along as `auth_methods`), otherwise `unavailable` / `agent_start_failed` (program missing, it
   * exited, it timed out, or it answered something unusable).
   */
  #startError(error: unknown, init?: AcpInitializeResult): MeshCallError {
    const raw = errorMessage(error);
    const message = raw.startsWith("could not start ") ? raw : `could not start ${this.name}: ${raw}`;
    if (error instanceof AcpRequestError && error.code === JsonRpcErrorCode.AUTH_REQUIRED) {
      const details: Record<string, unknown> = { reason: "agent_auth_required", agent: this.id };
      const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
      if (methods.length > 0) {
        details.auth_methods = methods.map(({ id, name, description }) => (description ? { id, name, description } : { id, name }));
      }
      return new MeshCallError("failed_precondition", message, { details });
    }
    return new UnavailableError(message, { details: { reason: "agent_start_failed", agent: this.id } });
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
        if (live.stopped) {
          // `stop` ended it on purpose (an agent that did not answer `session/cancel` in time).
          outcome = "cancelled";
        } else {
          outcome = "error";
          failure = errorMessage(error);
        }
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
    await this.#closeAll("the Connector stopped");
  }

  async stop(): Promise<number> {
    const count = this.processCount();
    for (const live of this.#sessions.values()) live.stopped = true;
    await this.#closeAll("the agent was stopped");
    return count;
  }

  /** Close every session's agent, prepared agent and agent still starting; starts under way fail with `why`. */
  async #closeAll(why: string): Promise<void> {
    this.#generation++;
    this.#stoppedBecause = why;
    await Promise.all([
      ...[...this.#sessions.keys()].map((id) => this.closeSession(id)),
      ...[...this.#prepared].map((agent) => agent.close()),
      ...[...this.#launching].map((conn) => conn.close()),
    ]);
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

  /** Agent → client requests; `live` is undefined for a prepared agent no session has taken over yet. */
  async #handleAgentRequest(cwd: string, live: LiveSession | undefined, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        // Without a conversation nobody could answer: refused, as a cancelled turn would.
        if (live === undefined) return { outcome: { outcome: "cancelled" } } satisfies AcpRequestPermissionResult;
        return this.#requestPermission(live, params as AcpRequestPermissionParams);
      case "fs/read_text_file":
        return this.#readTextFile(cwd, params as AcpReadTextFileParams);
      case "fs/write_text_file":
        return this.#writeTextFile(cwd, params as AcpWriteTextFileParams);
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

  async #readTextFile(cwd: string, params: AcpReadTextFileParams): Promise<{ content: string }> {
    if (!params || typeof params.path !== "string") throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, "path is required");
    const target = resolveUserPath(params.path, cwd);
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

  async #writeTextFile(cwd: string, params: AcpWriteTextFileParams): Promise<null> {
    if (!params || typeof params.path !== "string" || typeof params.content !== "string") {
      throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, "path and content are required");
    }
    await writeFile(resolveUserPath(params.path, cwd), params.content, "utf8", this.#maxFileBytes());
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
  /** Add the default presets for ids not given in `presets`. Default true. */
  includeDefaultPresets?: boolean;
  /**
   * The Connector's own presets (`builtin` in `agents()`): default `defaultAcpPresets()`, the built-in agents installed
   * on this machine. An embedding app that ships its agents passes them here.
   */
  defaultPresets?: AcpRuntimePreset[];
  /** Each agent's switch and settings as saved on this device (`agents.json`), by agent id. */
  agentSettings?: AgentOverrides;
  /**
   * Persist every agent's settings after `updateAgent` changed them (the whole map). The change applies only once
   * this resolves; a rejection refuses it. The values of `env` are secrets: keep them on the device.
   */
  onAgentSettingsChange?: (settings: AgentOverrides) => void | Promise<void>;
  /** A prepared agent nobody took over is closed after this long without another `prepare` for it. Default 10 min. */
  preparedTtlMs?: number;
  /** Prepared agents kept on this device; beyond it the least recently used ready one is closed. Default 4. */
  maxPrepared?: number;
}

/** A prepared agent, as `aa.v3.Sessions/prepare` reports it. */
export interface PreparedInfo {
  /** `create`'s `prepared_id`. */
  id: string;
  agent: string;
  cwd: string;
  config: ConfigOption[];
  /** When it is closed unless a session takes it over or it is prepared again (ms since the epoch). */
  expiresAt: number;
}

/** An agent of this device as `aa.v3.Device/agents` reports it (`busy` comes from the sessions service). */
export interface AgentInfo {
  id: string;
  /** Its preset's name: the agent's product name. */
  name: string;
  /** One of the Connector's default presets. */
  builtin: boolean;
  enabled: boolean;
  /** What a process started now would run. */
  command: string;
  args: string[];
  /** Names of its extra environment variables; the values never leave the device. */
  envKeys: string[];
  /** The command, args or environment differ from the preset. */
  customized: boolean;
  /** Agent processes running now: the sessions' agents, prepared ones and ones still starting. */
  running: number;
}

interface PreparedEntry {
  readonly id: string;
  readonly agent: string;
  readonly cwd: string;
  /** `agent\0cwd`: one prepared agent per agent and folder. */
  readonly key: string;
  /** Until the agent is ready (every `prepare` for this key waits for the same start). */
  starting: Promise<PreparedAgent> | undefined;
  ready: PreparedAgent | undefined;
  expiresAt: number;
  timer: NodeJS.Timeout | undefined;
}

/** Runtimes by id, and session-level operations routed to the runtime the session was created with. */
export class AcpRuntimeHost {
  readonly store: SessionStore;
  readonly #options: AcpRuntimeHostOptions;
  readonly #runtimes = new Map<string, AgentRuntime>();
  /** Config chosen while the agent was not running, applied when it starts. */
  readonly #pendingConfig = new Map<string, Map<string, string>>();
  /** Prepared agents by `key`, least recently used first. */
  readonly #prepared = new Map<string, PreparedEntry>();
  readonly #preparedById = new Map<string, PreparedEntry>();
  readonly #preparedTtlMs: number;
  readonly #maxPrepared: number;
  /** The preset each configurable runtime was registered with: what `update_agent` changes and `reset` goes back to. */
  readonly #presets = new Map<string, AcpRuntimePreset>();
  /** Ids registered from the default presets. */
  readonly #builtin = new Set<string>();
  /** Every agent's saved changes, ids not registered here included (kept as they are). */
  #overrides = new Map<string, AgentOverride>();
  /** `updateAgent` calls run one at a time, so none is lost. */
  #agentUpdates: Promise<unknown> = Promise.resolve();
  onPushEvent: ((event: PushEvent) => void) | undefined;

  constructor(options: AcpRuntimeHostOptions) {
    this.store = options.store;
    this.onPushEvent = options.onPushEvent;
    this.#options = { ...options, onPushEvent: (event) => this.onPushEvent?.(event) };
    this.#preparedTtlMs = options.preparedTtlMs ?? DEFAULT_PREPARED_TTL_MS;
    this.#maxPrepared = Math.max(1, options.maxPrepared ?? DEFAULT_MAX_PREPARED);
    // An entry with nothing left once unknown keys are dropped (only a `name`, from an earlier Connector) is no change.
    const saved = Object.entries(AgentOverridesSchema.parse(options.agentSettings ?? {}));
    this.#overrides = new Map(saved.filter(([, override]) => Object.keys(override).length > 0));
    for (const preset of options.presets ?? []) this.registerPreset(preset);
    if (options.includeDefaultPresets ?? true) {
      for (const preset of options.defaultPresets ?? defaultAcpPresets()) {
        if (this.#runtimes.has(preset.id)) continue;
        this.registerPreset(preset);
        this.#builtin.add(preset.id);
      }
    }
  }

  registerPreset(preset: AcpRuntimePreset): AcpRuntime {
    const runtime = new AcpRuntime(preset, this.#options);
    this.registerRuntime(runtime);
    return runtime;
  }

  /** Add (or replace) a runtime. One with a `preset` runs with this device's saved settings for its id applied. */
  registerRuntime(runtime: AgentRuntime): void {
    if (!runtime.id) throw new TypeError("a runtime needs an id");
    this.#runtimes.set(runtime.id, runtime);
    this.#builtin.delete(runtime.id);
    const preset = runtime.configure ? runtime.preset : undefined;
    if (preset === undefined) {
      this.#presets.delete(runtime.id);
      return;
    }
    this.#presets.set(runtime.id, copyPreset(preset));
    runtime.configure?.(effectivePreset(preset, this.#overrides.get(runtime.id)));
  }

  /** The agents that can be used here (`status.runtimes`): every registered one except those turned off. */
  list(): { id: string; name: string }[] {
    return [...this.#runtimes.values()].filter((r) => !this.isDisabled(r.id)).map((r) => ({ id: r.id, name: r.name }));
  }

  /** Registered here, turned off or not. */
  has(runtimeId: string): boolean {
    return this.#runtimes.has(runtimeId);
  }

  // ── Agent settings (`aa.v3.Device/agents`, `update_agent`, `stop_agent`) ──

  /** Turned off on this device (`update_agent({ enabled: false })`). False for ids not registered here. */
  isDisabled(agentId: string): boolean {
    return this.#runtimes.has(agentId) && this.#overrides.get(agentId)?.enabled === false;
  }

  /** Throws `failed_precondition` / `agent_disabled` when the agent is turned off: it starts no process, takes no turn. */
  assertEnabled(agentId: string): void {
    if (!this.isDisabled(agentId)) return;
    const name = this.#runtimes.get(agentId)?.name ?? agentId;
    throw new MeshCallError("failed_precondition", `${name} is turned off on this device`, { details: { reason: "agent_disabled", agent: agentId } });
  }

  /** Every registered agent, turned off ones included, in the order of `list()`. */
  agents(): AgentInfo[] {
    return [...this.#runtimes.values()].map((runtime) => this.#info(runtime));
  }

  /** One agent; `invalid_argument` / `unknown_agent` when it is not registered here. */
  agent(agentId: string): AgentInfo {
    return this.#info(this.runtime(agentId));
  }

  /**
   * Turn an agent on or off, or change its command, args or extra environment variables (see `AgentUpdate`); its name
   * stays the preset's. Saved through `onAgentSettingsChange` before anything changes, then applied to agent processes
   * started from now on: running ones keep their settings until stopped, and prepared agents whose command, args or
   * environment changed (or that were turned off) are closed so the next `prepare` starts them anew.
   */
  updateAgent(agentId: string, update: AgentUpdate): Promise<AgentInfo> {
    const run = async (): Promise<AgentInfo> => {
      const runtime = this.runtime(agentId);
      const parsed = AgentUpdateSchema.safeParse(update);
      if (!parsed.success) throw invalidAgentSettings(parsed.error);
      const preset = this.#presets.get(agentId);
      const before = this.#overrides.get(agentId) ?? {};
      const after = applyAgentUpdate(preset ?? bareSettings(runtime), before, parsed.data);
      const checked = AgentOverrideSchema.safeParse(after);
      if (!checked.success) throw invalidAgentSettings(checked.error);
      if (preset === undefined && hasLaunchSettings(after)) {
        throw new MeshCallError("failed_precondition", `${runtime.name} has no settings to change, only its switch`, {
          details: { reason: "agent_not_configurable", agent: agentId },
        });
      }

      const next = new Map(this.#overrides);
      if (Object.keys(after).length > 0) next.set(agentId, after);
      else next.delete(agentId);
      await this.#options.onAgentSettingsChange?.(Object.fromEntries(next));
      this.#overrides = next;

      let relaunch = false;
      if (preset !== undefined) {
        const now = effectivePreset(preset, after);
        relaunch = !sameLaunch(effectivePreset(preset, before), now);
        runtime.configure?.(now);
      }
      // A prepared agent runs the old command, args or environment, or one that is off now: the next `prepare` starts anew.
      const turnedOff = before.enabled !== false && after.enabled === false;
      if (relaunch || turnedOff) await this.#dropPreparedOf(agentId);
      return this.#info(runtime);
    };
    const result = this.#agentUpdates.then(run, run);
    this.#agentUpdates = result.catch(() => undefined);
    return result;
  }

  /**
   * Stop every process of `agentId`: its sessions' agents, prepared ones and ones still starting. Sessions stay and
   * start the agent again on their next message, with the settings of that moment. Resolves with how many processes
   * were stopped. Turns still running are not waited for (`SessionsService.stopAgent` cancels them first).
   */
  async stopAgent(agentId: string): Promise<number> {
    const runtime = this.runtime(agentId);
    const count = this.#processCount(runtime);
    // The pool forgets its prepared agents while the runtime stops every process (those included).
    await Promise.all([this.#dropPreparedOf(agentId), runtime.stop ? runtime.stop() : runtime.dispose()]);
    return count;
  }

  #info(runtime: AgentRuntime): AgentInfo {
    const preset = this.#presets.get(runtime.id);
    const override = this.#overrides.get(runtime.id) ?? {};
    const effective = effectivePreset(preset ?? bareSettings(runtime), override);
    return {
      id: runtime.id,
      name: runtime.name,
      builtin: this.#builtin.has(runtime.id),
      enabled: override.enabled !== false,
      command: effective.command,
      args: effective.args,
      envKeys: Object.keys(effective.env ?? {}),
      customized: preset !== undefined && !sameLaunch(effective, preset),
      running: this.#processCount(runtime),
    };
  }

  #processCount(runtime: AgentRuntime): number {
    if (runtime.processCount) return runtime.processCount();
    return this.store.list().sessions.filter((s) => s.agent === runtime.id && runtime.hasSession(s.id)).length;
  }

  /** Close the prepared agents of `agentId` (one still starting is closed once it is ready). */
  async #dropPreparedOf(agentId: string): Promise<void> {
    await Promise.all([...this.#prepared.values()].filter((entry) => entry.agent === agentId).map((entry) => this.#dropPrepared(entry)));
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

  /**
   * Start the session's agent if it is not running (create, or the first prompt after a restart). `preparedId`:
   * take that prepared agent over when it was prepared for this session's agent and folder and still runs; any
   * other id is ignored and the agent starts as usual.
   */
  async ensureSession(sessionId: string, options: { preparedId?: string | undefined } = {}): Promise<void> {
    const session = this.store.get(sessionId);
    if (session === undefined) throw new MeshCallError("not_found", `no session ${sessionId}`, { details: { reason: "session_not_found" } });
    const runtime = this.runtime(session.agent);
    if (runtime.hasSession(sessionId)) return;
    this.assertEnabled(session.agent);
    const prepared = options.preparedId ? this.#takePrepared(options.preparedId, session.agent, session.cwd) : undefined;
    await runtime.startSession({ sessionId, cwd: session.cwd, ...(prepared ? { prepared } : {}) });
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

  // ── Prepared agents ──

  /**
   * Start `agent` in `cwd` ahead of a conversation (`aa.v3.Sessions/prepare`) and report its settings. One prepared
   * agent per agent and folder: asking again returns the same one and restarts its TTL, and asking while it starts
   * waits for that start. A start failure rejects like `create` would (`agent_auth_required`, `agent_start_failed`).
   */
  async prepare(input: { agent: string; cwd: string }): Promise<PreparedInfo> {
    const runtime = this.runtime(input.agent);
    this.assertEnabled(input.agent);
    const key = `${input.agent}\u0000${input.cwd}`;
    let entry = this.#prepared.get(key);
    if (entry?.ready !== undefined && !entry.ready.usable) {
      void this.#dropPrepared(entry);
      entry = undefined;
    }
    if (entry === undefined) entry = this.#startPrepared(runtime, input.agent, input.cwd, key);
    else this.#touchPrepared(entry);
    const ready = entry.ready ?? (await entry.starting);
    if (ready === undefined || !ready.usable || this.#prepared.get(key) !== entry) {
      // The Connector stopped meanwhile, or the agent exited right after it started.
      throw new UnavailableError(`could not start ${runtime.name}: it stopped before a conversation could use it`, {
        details: { reason: "agent_start_failed", agent: input.agent },
      });
    }
    this.#touchPrepared(entry);
    return { id: entry.id, agent: entry.agent, cwd: entry.cwd, config: ready.config, expiresAt: entry.expiresAt };
  }

  /** Prepared agents that are ready (diagnostics and tests). */
  listPrepared(): PreparedInfo[] {
    return [...this.#prepared.values()].flatMap((entry) =>
      entry.ready?.usable ? [{ id: entry.id, agent: entry.agent, cwd: entry.cwd, config: entry.ready.config, expiresAt: entry.expiresAt }] : [],
    );
  }

  #startPrepared(runtime: AgentRuntime, agent: string, cwd: string, key: string): PreparedEntry {
    if (runtime.prepare === undefined) {
      throw new MeshCallError("failed_precondition", `${runtime.name} cannot be started ahead of a conversation`, { details: { reason: "prepare_unsupported", agent } });
    }
    const entry: PreparedEntry = { id: globalThis.crypto.randomUUID(), agent, cwd, key, starting: undefined, ready: undefined, expiresAt: 0, timer: undefined };
    entry.starting = runtime.prepare({ cwd }).then(
      (ready) => {
        entry.starting = undefined;
        if (this.#prepared.get(key) !== entry) {
          // Dropped while it started (the Connector stopped).
          void ready.close();
          return ready;
        }
        entry.ready = ready;
        ready.onExit = () => void this.#dropPrepared(entry);
        this.#touchPrepared(entry);
        this.#trimPrepared(entry);
        return ready;
      },
      (error: unknown) => {
        entry.starting = undefined;
        if (this.#prepared.get(key) === entry) void this.#dropPrepared(entry);
        throw error;
      },
    );
    this.#prepared.set(key, entry);
    this.#preparedById.set(entry.id, entry);
    this.#trimPrepared(entry);
    return entry;
  }

  /** Most recently used now; a ready one gets a fresh TTL (the clock starts once the agent is ready). */
  #touchPrepared(entry: PreparedEntry): void {
    if (this.#prepared.get(entry.key) !== entry) return;
    this.#prepared.delete(entry.key);
    this.#prepared.set(entry.key, entry);
    if (entry.ready === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.expiresAt = Date.now() + this.#preparedTtlMs;
    entry.timer = setTimeout(() => void this.#dropPrepared(entry), this.#preparedTtlMs);
    entry.timer.unref?.();
  }

  /** Over the limit: close the least recently used ready agents (never `keep`, never one still starting). */
  #trimPrepared(keep: PreparedEntry): void {
    let excess = this.#prepared.size - this.#maxPrepared;
    for (const entry of [...this.#prepared.values()]) {
      if (excess <= 0) return;
      if (entry === keep || entry.ready === undefined) continue;
      void this.#dropPrepared(entry);
      excess--;
    }
  }

  /** Forget a prepared agent and close it (one still starting is closed once it is ready). */
  #dropPrepared(entry: PreparedEntry): Promise<void> {
    if (this.#prepared.get(entry.key) === entry) this.#prepared.delete(entry.key);
    if (this.#preparedById.get(entry.id) === entry) this.#preparedById.delete(entry.id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    const ready = entry.ready;
    entry.ready = undefined;
    if (ready === undefined) return Promise.resolve();
    ready.onExit = undefined;
    return ready.close().catch(() => undefined);
  }

  /** The prepared agent `id`, out of the pool, if it was prepared for this agent and folder, is still running and not expired. */
  #takePrepared(id: string, agent: string, cwd: string): PreparedAgent | undefined {
    const entry = this.#preparedById.get(id);
    const ready = entry?.ready;
    // Another agent or folder: not for this session, but it stays prepared for its own.
    if (entry === undefined || ready === undefined || entry.agent !== agent || entry.cwd !== cwd) return undefined;
    if (!ready.usable || entry.expiresAt <= Date.now()) {
      void this.#dropPrepared(entry);
      return undefined;
    }
    entry.ready = undefined; // handed over, not closed
    void this.#dropPrepared(entry);
    ready.onExit = undefined;
    return ready;
  }

  async prompt(sessionId: string, turnId: string, prompt: AcpContentBlock[]): Promise<TurnResult> {
    const agent = this.store.get(sessionId)?.agent;
    if (agent !== undefined) this.assertEnabled(agent); // a turned-off agent takes no new turn, running or not
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

  /** Close every session's agent and every prepared agent (the Connector stops). Later calls start them again. */
  async dispose(): Promise<void> {
    const prepared = [...this.#prepared.values()];
    await Promise.all([...prepared.map((entry) => this.#dropPrepared(entry)), ...[...this.#runtimes.values()].map((r) => r.dispose())]);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Agent settings ──────────────────────────────────────────────────────────────────────────────────────────────

function copyPreset(preset: AcpRuntimePreset): AcpRuntimePreset {
  return { id: preset.id, name: preset.name, command: preset.command, args: [...(preset.args ?? [])], ...(preset.env ? { env: { ...preset.env } } : {}) };
}

/** What a runtime without a preset is shown as: only its switch can change. */
function bareSettings(runtime: AgentRuntime): AcpRuntimePreset {
  return { id: runtime.id, name: runtime.name, command: "", args: [] };
}

/** The settings an agent runs with: its preset with this device's changes applied (never to its name). */
function effectivePreset(preset: AcpRuntimePreset, override: AgentOverride | undefined): AcpRuntimePreset {
  const env = override?.env ?? preset.env;
  return {
    id: preset.id,
    name: preset.name,
    command: override?.command ?? preset.command,
    args: [...(override?.args ?? preset.args ?? [])],
    ...(env !== undefined && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
  };
}

/**
 * `current` with `update` applied, keeping only what differs from the preset (an agent set back to its preset's
 * values is not customized, and follows the preset when a later Connector changes it). `reset` starts again from
 * the preset, except for the switch.
 */
function applyAgentUpdate(preset: AcpRuntimePreset, current: AgentOverride, update: AgentUpdate): AgentOverride {
  const next: AgentOverride = update.reset ? (current.enabled === false ? { enabled: false } : {}) : { ...current };
  if (update.enabled != null) next.enabled = update.enabled;
  if (update.command != null) next.command = update.command;
  if (update.args != null) next.args = [...update.args];
  if (update.env != null) {
    // `update` went through `AgentUpdateSchema`, whose records never carry a `__proto__` key: plain assignment is safe.
    const env: Record<string, string> = { ...(next.env ?? preset.env ?? {}) };
    for (const [key, value] of Object.entries(update.env)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    next.env = env;
  }
  const kept: AgentOverride = {};
  if (next.enabled === false) kept.enabled = false;
  if (next.command !== undefined && next.command !== preset.command) kept.command = next.command;
  if (next.args !== undefined && !sameArgs(next.args, preset.args ?? [])) kept.args = next.args;
  if (next.env !== undefined && !sameEnv(next.env, preset.env ?? {})) kept.env = next.env;
  return kept;
}

function hasLaunchSettings(override: AgentOverride): boolean {
  return override.command !== undefined || override.args !== undefined || override.env !== undefined;
}

/** Same command, args and environment: a process started with either is the same. */
function sameLaunch(a: AcpRuntimePreset, b: AcpRuntimePreset): boolean {
  return a.command === b.command && sameArgs(a.args ?? [], b.args ?? []) && sameEnv(a.env ?? {}, b.env ?? {});
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

function sameEnv(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/** A bad `update_agent` from a direct caller (MeshCall checks the request schema before a remote one gets here). */
function invalidAgentSettings(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): InvalidArgumentError {
  const issue = error.issues[0];
  const where = (issue?.path ?? []).map(String).join(".");
  return new InvalidArgumentError(`invalid agent settings${where ? ` (${where})` : ""}: ${issue?.message ?? "invalid"}`, {
    details: { reason: "invalid_agent_settings", ...(where ? { field: where } : {}) },
  });
}
