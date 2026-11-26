/**
 * One agent process, shared by all conversations of the agent on this device: `initialize` once, then one ACP session
 * per conversation. Every ACP message names its session, so what the agent sends is handed to that session's owner: a
 * conversation, or a prepared session waiting for one.
 *
 * A process is started with the agent's settings of that moment. When they change it is retired: no session is opened
 * in it any more, the ones it has move to the next process as they become idle, and it exits with the last one
 * (`AcpRuntime`).
 */

import { UnavailableError } from "meshcall";

import {
  ACP_PROTOCOL_VERSION,
  JsonRpcErrorCode,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpSessionNotificationParams,
} from "../core/acp-protocol.js";
import { AcpConnection, AcpRequestError, type AcpConnectionOptions } from "./acp-connection.js";
import type { PiApprovalsFile } from "./pi-approvals.js";

/** How long `session/close` may take: the session is forgotten here either way. */
const CLOSE_SESSION_TIMEOUT_MS = 10_000;

/** How an agent reopens an earlier ACP session: `session/resume`, or `session/load` (which replays it). */
export type RestoreMethod = "resume" | "load";

/** Whose session it is. */
export interface SessionOwner {
  onUpdate(params: AcpSessionNotificationParams): void;
  /** Agent → client requests about the session. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** The process is gone. */
  onExit(): void;
}

/** A session just opened; its updates are kept until `claim` gives it an owner. */
export interface OpenedSession {
  readonly process: AgentProcess;
  readonly result: AcpNewSessionResult & { sessionId: string };
  /** `session/update`s sent before the session had an owner, oldest first (see `bufferUpdate`). */
  readonly updates: AcpSessionNotificationParams[];
  /** `result` is the earlier ACP session, reopened this way. */
  readonly restored?: RestoreMethod;
  /** An earlier ACP session was to be reopened and could not be: why. `result` is a new session. */
  readonly restoreError?: string;
}

export interface AgentProcessOptions extends AcpConnectionOptions {
  /** The agent's name, for error texts. */
  name: string;
  /** For one session only. */
  dedicated?: boolean;
  clientInfo: { name: string; version: string };
  /** Timeout for `initialize`, `session/new`, `session/resume` and `session/load`. */
  startupTimeoutMs: number;
  /** AA's approvals for this process (Pi): its mode file. */
  approvals?: PiApprovalsFile | undefined;
  /** Agent → client requests about a session that is still being opened in `cwd`. */
  onUnownedRequest: (cwd: string, method: string, params: unknown) => Promise<unknown>;
  /** Told with the connection before `initialize`, so that it can be closed meanwhile. */
  onSpawn?: (conn: AcpConnection) => void;
  /** After `initialize`, before the first session (the model gateway). A rejection refuses the start. */
  onReady?: (conn: AcpConnection, init: AcpInitializeResult) => Promise<void>;
  /** `_meta` of the sessions opened in it (the model gateway). */
  sessionMeta?: Record<string, unknown> | undefined;
}

/**
 * How this agent can reopen an earlier session, in order: `session/resume` when it offers it (no replay), then
 * `session/load`.
 */
export function restoreMethodsOf(init: AcpInitializeResult): RestoreMethod[] {
  const caps = init.agentCapabilities;
  const resume = caps?.sessionCapabilities?.resume;
  const methods: RestoreMethod[] = [];
  if (typeof resume === "object" && resume !== null) methods.push("resume");
  if (caps?.loadSession === true) methods.push("load");
  return methods;
}

/** Updates that carry only the latest state: a newer one replaces the older one while they wait in a buffer. */
const STATE_UPDATES: ReadonlySet<string> = new Set(["available_commands_update", "config_option_update", "current_mode_update"]);
/** Other updates kept while no one owns the session; an idle agent sends few (a banner, say), this only bounds a chatty one. */
const MAX_BUFFERED_UPDATES = 200;
/** Sessions without an owner whose updates are kept while a session is being opened; this only bounds a misbehaving agent. */
const MAX_UNOWNED_SESSIONS = 32;

/** Commands, settings or mode: state, not part of the conversation. */
function isStateUpdate(params: AcpSessionNotificationParams): boolean {
  const kind = params?.update?.sessionUpdate;
  return typeof kind === "string" && STATE_UPDATES.has(kind);
}

export function bufferUpdate(buffer: AcpSessionNotificationParams[], params: AcpSessionNotificationParams): void {
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

export class AgentProcess {
  readonly conn: AcpConnection;
  readonly init: AcpInitializeResult;
  readonly approvals: PiApprovalsFile | undefined;
  /** How it reopens earlier sessions; none: a session closed here has lost its context. */
  readonly restoreMethods: readonly RestoreMethod[];
  /** It closes single sessions (`session/close`). */
  readonly closesSessions: boolean;
  /** It accepts image content blocks. */
  readonly promptImages: boolean;
  /** One session's own (`own_process`): it exits with that session. */
  readonly dedicated: boolean;
  /** No session is opened in it any more; it exits with its last one. */
  retired = false;
  readonly #options: AgentProcessOptions;
  readonly #owners = new Map<string, SessionOwner>();
  /** Updates of sessions nobody owns yet, kept while a session is being opened. */
  readonly #unowned = new Map<string, AcpSessionNotificationParams[]>();
  /** Sessions being reopened: what they replay is history AA has already. */
  readonly #replaying = new Set<string>();
  /** The folders of the sessions being opened. */
  readonly #opening = new Set<{ cwd: string }>();
  /** Sign-ins running in it. */
  #signIns = 0;
  #stopped: Promise<void> | undefined;

  private constructor(conn: AcpConnection, init: AcpInitializeResult, options: AgentProcessOptions) {
    this.conn = conn;
    this.init = init;
    this.approvals = options.approvals;
    this.dedicated = options.dedicated === true;
    this.#options = options;
    const caps = init.agentCapabilities;
    const close = caps?.sessionCapabilities?.close;
    this.restoreMethods = restoreMethodsOf(init);
    this.closesSessions = typeof close === "object" && close !== null;
    this.promptImages = caps?.promptCapabilities?.image === true;
  }

  /** Spawn the agent and `initialize` it. Any failure leaves no process behind. */
  static async start(options: AgentProcessOptions): Promise<AgentProcess> {
    const conn = await AcpConnection.spawn(options);
    // Wired before `initialize`: the process below takes over in the same tick that answers it.
    let self: AgentProcess | undefined;
    conn.onNotification = (method, params) => {
      if (method === "session/update" && self !== undefined) self.#onUpdate(params as AcpSessionNotificationParams);
    };
    conn.onRequest = async (method, params) => {
      if (self === undefined) throw new AcpRequestError(JsonRpcErrorCode.METHOD_NOT_FOUND, `unsupported: ${method}`);
      return self.#onRequest(method, params);
    };
    conn.onExit = () => {
      if (self !== undefined) self.#onExit();
    };
    options.onSpawn?.(conn);
    try {
      const init = (await conn.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, auth: { terminal: true } },
          clientInfo: options.clientInfo,
        },
        options.startupTimeoutMs,
      )) as AcpInitializeResult;
      if (typeof init?.protocolVersion !== "number") throw new UnavailableError("the agent answered initialize without a protocolVersion");
      self = new AgentProcess(conn, init, options);
      await options.onReady?.(conn, init);
      return self;
    } catch (error) {
      await conn.close();
      throw error;
    }
  }

  /** It has exited. */
  get closed(): boolean {
    return this.conn.closed;
  }

  /** `close` was called: it exits, or has. */
  get stopping(): boolean {
    return this.#stopped !== undefined;
  }

  /** Sessions with an owner, and ones being opened; or it is being signed in to. */
  get inUse(): boolean {
    return this.#owners.size > 0 || this.opening;
  }

  /** A session is being opened in it, or it is being signed in to. */
  get opening(): boolean {
    return this.#opening.size > 0 || this.#signIns > 0;
  }

  /**
   * Sign in (ACP `authenticate`): the agent may open a browser on this device and wait for it. There is no way to call
   * it off in ACP: when `signal` aborts, only the wait ends.
   */
  async authenticate(methodId: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<void> {
    const { signal, timeoutMs } = options;
    signal.throwIfAborted();
    this.#signIns++;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason as Error);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      await Promise.race([this.conn.request("authenticate", { methodId }, timeoutMs), aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      this.#signIns--;
    }
  }

  /**
   * Reopen the ACP session `earlier` with its context (`session/resume`, then `session/load` if the agent refused the
   * resume) or, without one or when that fails, `session/new`. Rejects with the agent's error when there is no session.
   */
  async open(cwd: string, earlier?: string): Promise<OpenedSession> {
    const opening = { cwd };
    this.#opening.add(opening);
    const timeoutMs = this.#options.startupTimeoutMs;
    const meta = this.#options.sessionMeta !== undefined ? { _meta: this.#options.sessionMeta } : {};
    try {
      let restoreError: string | undefined;
      if (earlier !== undefined) {
        if (this.restoreMethods.length === 0) {
          restoreError = `${this.#options.name} cannot reopen an earlier session (it offers neither session/resume nor session/load)`;
        }
        const failures: string[] = [];
        for (const how of this.restoreMethods) {
          // `session/load` replays the conversation before it answers (some agents do so on a resume, too). AA has that
          // history: only the latest commands, settings and mode are kept.
          this.#replaying.add(earlier);
          try {
            const params = { sessionId: earlier, cwd, mcpServers: [], ...meta };
            const answer = how === "resume" ? await this.conn.request("session/resume", params, timeoutMs) : await this.conn.request("session/load", params, timeoutMs);
            return { ...this.#opened({ ...(answer ?? {}), sessionId: earlier }, cwd), restored: how };
          } catch (error) {
            // The process is gone (or was stopped): no new session either.
            if (this.conn.closed) throw error;
            failures.push(`session/${how} failed: ${agentErrorText(error)}`);
            // Only the agent's own refusal leaves room for the other method (Antigravity suggests session/load when
            // session/resume cannot read a session); after a timeout it would only be waited for again.
            if (!(error instanceof AcpRequestError)) break;
          } finally {
            this.#replaying.delete(earlier);
          }
        }
        if (failures.length > 0) restoreError = failures.join("; ");
      }
      const result = await this.conn.request("session/new", { cwd, mcpServers: [], ...meta }, timeoutMs);
      if (typeof result?.sessionId !== "string" || result.sessionId.length === 0) {
        throw new UnavailableError("the agent answered session/new without a sessionId");
      }
      return { ...this.#opened(result as OpenedSession["result"], cwd), ...(restoreError !== undefined ? { restoreError } : {}) };
    } finally {
      this.#opening.delete(opening);
      if (this.#opening.size === 0) this.#unowned.clear();
    }
  }

  /** Give an opened session its owner: from now on its updates and requests go there. */
  claim(sessionId: string, owner: SessionOwner): void {
    this.#owners.set(sessionId, owner);
  }

  /**
   * Forget a session: its updates go nowhere any more. The agent is told to close it (`session/close`), or, when it
   * cannot close single sessions and `working`, to cancel what it does. Resolves once the agent answered.
   */
  async closeSession(sessionId: string, options: { working?: boolean } = {}): Promise<void> {
    this.#owners.delete(sessionId);
    if (this.conn.closed) return;
    void this.approvals?.forget(sessionId).catch(() => undefined);
    if (this.closesSessions) await this.conn.request("session/close", { sessionId }, CLOSE_SESSION_TIMEOUT_MS).catch(() => undefined);
    else if (options.working) this.conn.notify("session/cancel", { sessionId });
  }

  /** Stop the process; resolves once it has exited. Its sessions' owners are not told: whoever stops it has taken them off first. */
  close(): Promise<void> {
    this.retired = true;
    this.#owners.clear();
    this.#stopped ??= this.conn.close();
    return this.#stopped;
  }

  /** The session answered: keep its updates until it is claimed, in the same buffer as those sent before the answer. */
  #opened(result: OpenedSession["result"], cwd: string): OpenedSession {
    const updates = this.#unowned.get(result.sessionId) ?? [];
    this.#unowned.delete(result.sessionId);
    this.claim(result.sessionId, {
      onUpdate: (params) => bufferUpdate(updates, params),
      onRequest: (method, params) => this.#options.onUnownedRequest(cwd, method, params),
      onExit: () => undefined,
    });
    return { process: this, result, updates };
  }

  #onUpdate(params: AcpSessionNotificationParams): void {
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string") return;
    if (this.#replaying.has(sessionId) && !isStateUpdate(params)) return;
    const owner = this.#owners.get(sessionId);
    if (owner !== undefined) return owner.onUpdate(params);
    // A new session's commands and settings often come right behind (or before) the answer that names it.
    if (this.#opening.size === 0) return;
    let buffer = this.#unowned.get(sessionId);
    if (buffer === undefined) {
      if (this.#unowned.size >= MAX_UNOWNED_SESSIONS) return;
      this.#unowned.set(sessionId, (buffer = []));
    }
    bufferUpdate(buffer, params);
  }

  async #onRequest(method: string, params: unknown): Promise<unknown> {
    const sessionId = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
    const owner = typeof sessionId === "string" ? this.#owners.get(sessionId) : undefined;
    if (owner !== undefined) return owner.onRequest(method, params);
    // A session that is being opened has no owner yet; anything else is about a session AA does not know.
    const [opening] = this.#opening;
    if (opening !== undefined) return this.#options.onUnownedRequest(opening.cwd, method, params);
    throw new AcpRequestError(JsonRpcErrorCode.INVALID_PARAMS, `no session ${String(sessionId)}`);
  }

  #onExit(): void {
    this.retired = true;
    const owners = [...this.#owners.values()];
    this.#owners.clear();
    this.#unowned.clear();
    for (const owner of owners) {
      try {
        owner.onExit();
      } catch {
        // One session's trouble must not keep the others from being told.
      }
    }
  }
}

/**
 * An agent's error with the reason it gives beside the message (Codex: "Internal error", `data.details` says why;
 * Cursor: "Authentication required", `data.message` says what to run; goose: `data` is the reason).
 */
export function agentErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof AcpRequestError ? error.data : undefined;
  const reasons = typeof data === "object" && data !== null ? [(data as { details?: unknown }).details, (data as { message?: unknown }).message] : [data];
  const details = reasons.find((text): text is string => typeof text === "string" && text.trim() !== "");
  const text = details === undefined || message.includes(details) ? message : details.includes(message) ? details : `${message} (${details})`;
  return text.slice(0, 500);
}
