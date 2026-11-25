/**
 * Generic ACP runtime host: runs any agent that speaks the Agent Client Protocol (JSON-RPC 2.0, one JSON object
 * per line over stdio) and projects its output into the `SessionStore`.
 *
 * One process per agent, shared by all of its conversations, each an ACP session of its own with its own `cwd`
 * (`agent-process.ts`). It is started lazily: by the first conversation, or a prepared one. A crash ends the turns that
 * run in it; every conversation's next message starts the agent again. Only an agent that cannot run several sessions
 * (`own_process`) gets a process per conversation.
 *
 * Settings that take another process (command, args, environment, …): the running process is retired. No session is
 * opened in it any more, idle ones move to the next process right away, busy ones when what they do has ended, and it
 * exits with the last one. An agent that cannot restore a session keeps it there until it is closed or stopped.
 *
 * Restoring the agent's context: the agent's own session id (ACP `sessionId`) is saved with the conversation. When
 * the conversation's agent starts again (a Connector restart, `stop_agent`, a crash, an idle close, a new process), it
 * reopens that session instead of starting a new one: `session/resume` when the agent offers it (no replay), else,
 * or when the agent refuses the resume, `session/load` (the agent replays the conversation as `session/update`s; AA
 * has it already, so the replay is dropped). Either way the conversation's settings (model, mode, …) are set again
 * where the agent reports others (`AcpRuntimeHost.ensureSession`). An agent that can do neither, or fails to, starts
 * a new ACP session as before: it has lost the earlier context, which is logged (the timeline has no item for such a
 * notice).
 *
 * Idle agents: a session the agent can restore is closed (`session/close`) once nothing has been in flight in it for
 * the agent's `idle_close_minutes` (its settings; `idleTtlMs` for agents without one; never by default): no turn, no
 * permission request, no setting change, no output of its own between turns. When that holds for all of them, the
 * process is closed. The conversation stays; its next message restores it. Sessions that cannot be restored stay.
 *
 * Prepared agents (`AcpRuntimeHost.prepare`, `aa.v3.Sessions/prepare`): a new-conversation page opens a session as soon
 * as the user picks the agent, so its settings (model, mode, …) are known before the first message and an `npx` download
 * happens while the user types. `create({ prepared_id })` takes the session over (no second `session/new`) and replays
 * the `session/update`s it got meanwhile. Unused ones are closed after a TTL, beyond a per-device limit (least recently
 * used first), and when the Connector stops.
 *
 * Agent → client requests handled here:
 *   - `session/request_permission` → a `PendingRequest` in the store; the first answer any client gives
 *     (`SessionStore.answerPendingRequest`) is written back as `{ outcome: { outcome: "selected", optionId } }`,
 *     a cancel as `{ outcome: { outcome: "cancelled" } }`.
 *   - `fs/read_text_file`, `fs/write_text_file` → `device-ops.ts`, relative paths against the session `cwd`,
 *     bounded by the RPC file cap.
 */

import { mkdir, readFile as readFileBytes, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";

import { InvalidArgumentError, MeshCallError, UnavailableError } from "meshcall";

import { AGENT_CATALOG, agentFolders, installMethods, launcherOf, presetOf, programEnv, type CatalogAgent } from "../core/agent-catalog.js";
import {
  AcpTimelineProjector,
  configFromSessionResult,
  configOptionsFromAcp,
  configWithMode,
  JsonRpcErrorCode,
  MODE_CONFIG_ID,
  type AcpAuthMethod,
  type AcpAvailableCommand,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpReadTextFileParams,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSetProviderParams,
  type AcpStopReason,
  type AcpWriteTextFileParams,
} from "../core/acp-protocol.js";
import type { GatewayApi, GatewayLaunch } from "../core/agent-gateway.js";
import {
  AgentOverrideSchema,
  AgentOverridesSchema,
  AgentUpdateSchema,
  CUSTOM_AGENT_ID_PREFIX,
  CustomAgentsSchema,
  LastSessionConfigSchema,
  MAX_CUSTOM_AGENTS,
  NewAgentSchema,
  type AcpRuntimePreset,
  type AgentOverride,
  type AgentOverrides,
  type AgentUpdate,
  type CustomAgent,
  type LastSessionConfig,
  type ModelGateway,
  type NewAgent,
} from "../core/config.js";
import {
  DEFAULT_PI_APPROVAL_MODE,
  isPiApprovalMode,
  PI_APPROVALS_CONFIG_ID,
  PI_APPROVALS_ENV,
  piApprovalRequest,
  piApprovalsOption,
  type PiApprovalMode,
} from "../core/pi-approvals.js";
import type { AnswerInput, AnswerResult, SessionStore } from "../core/session-store.js";
import type { ConfigOption } from "../core/timeline.js";
import { AcpRequestError, type AcpConnection } from "./acp-connection.js";
import { AgentFinder } from "./agent-finder.js";
import { AgentInstaller, type InstallJob } from "./agent-installer.js";
import { isTerminalMethod, offeredMethods, PROGRAM_SIGN_IN, signInMethods, terminalCommand, type SignInCommand, type SignInMethod } from "./sign-in.js";
import { agentErrorText, AgentProcess, bufferUpdate, type OpenedSession, type RestoreMethod } from "./agent-process.js";
import { devicePlatform, readFile, resolveUserPath, writeFile } from "./device-ops.js";
import { installPiApprovals, PiApprovalsFile, uninstallPiApprovals } from "./pi-approvals.js";
import { DEFAULT_MAX_RPC_FILE_BYTES } from "./state-store.js";

/** What a process is started with: a preset with this device's changes, and the model gateway it uses. */
export interface AgentLaunch extends AcpRuntimePreset {
  gateway?: GatewayLaunch;
}

export type { AcpRuntimePreset } from "../core/config.js";
export { AcpConnection, AcpRequestError, type AcpConnectionOptions } from "./acp-connection.js";
export type { RestoreMethod } from "./agent-process.js";

/** `initialize` / `session/new`: the first start of an `npx` agent downloads it, which can take minutes. */
const STARTUP_TIMEOUT_MS = 300_000;
const SIGN_IN_TIMEOUT_MS = 600_000;
/** For a sign-in nobody asked for now. */
const SIGN_IN_AGAIN_TIMEOUT_MS = 20_000;
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
  /** Keep the session from being closed as idle until `StartedSession.release` is called. */
  hold?: boolean;
}

export interface StartedSession {
  acpSessionId: string;
  config: ConfigOption[];
  /** The session took over a prepared agent instead of starting one. */
  prepared?: boolean;
  /** The agent reopened the conversation's earlier ACP session (with its context) this way. */
  restored?: RestoreMethod;
  /** Why the earlier ACP session could not be reopened: the agent started a new one, without the earlier context. */
  restoreError?: string;
  /** Ends `hold`. */
  release?: () => void;
}

/** Where a runtime reports what nothing else shows: a lost agent context, an idle agent or session closed. */
export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * A session opened ahead of its conversation: its settings are known before the first message. `startSession({ prepared })`
 * takes it over.
 */
export interface PreparedAgent {
  readonly cwd: string;
  readonly acpSessionId: string;
  /** Its settings now: the `session/new` answer plus the changes the agent reported since (same shape as `Session.config`). */
  readonly config: ConfigOption[];
  /** Still running and not taken over. */
  readonly usable: boolean;
  /** Change a setting before the conversation exists (the host applies the agent's newest settings this way). */
  setConfig?(configId: string, value: string): Promise<ConfigOption[]>;
  /** Told once when the agent is gone before a conversation took it over. */
  onExit: (() => void) | undefined;
  /** Close it (nothing once a conversation took it over). */
  close(): Promise<void>;
}

/** A runtime that can drive aa.v3 sessions. `AcpRuntime` is the ACP implementation; tests may add others. */
export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  startSession(input: StartSessionInput): Promise<StartedSession>;
  /** Open a session in `cwd` ahead of a conversation (for `startSession({ prepared })`). Optional. */
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
  /** Run the agent with `preset` (same id) from now on: idle sessions at once, others when what they do has ended. Optional. */
  configure?(launch: AgentLaunch): void;
  /** Agent processes running now, ones still starting included. Optional. */
  processCount?(): number;
  /** Sessions open now, prepared ones included. Optional. */
  sessionCount?(): number;
  /**
   * Stop every agent process of this runtime (`stop_agent`): its sessions start the agent again on their next
   * message (restoring its context where the agent can), and a turn still running ends `cancelled`. Resolves with
   * how many processes there were. Optional: `dispose` is used without it.
   */
  stop?(): Promise<number>;
  /**
   * Turn AA's approvals on or off (runtimes whose preset has `approvals`). On: sessions get them as they do settings
   * (`configure`), and conversations that are not open have the setting at once. Off: running ones stop asking at once,
   * and no conversation has the setting any more.
   */
  configureApprovals?(on: boolean): void;
  /** Sign in with one of the agent's ways; asking again joins. Optional. */
  readonly signInMethods?: SignInMethod[];
  /** Sign in this way when a process asks for it. Optional. */
  configureSignIn?(methodId: string | undefined): void;
  signIn?(methodId: string): Promise<void>;
  cancelSignIn?(): void;
  /** What to run in a terminal to sign in this way. Optional. */
  signInCommand?(methodId: string): SignInCommand;
  /**
   * How long a session may sit idle before it is closed (ms; 0: never), or `undefined` for the host's `idleTtlMs`.
   * Applies to idle sessions at once.
   */
  configureIdle?(ms: number | undefined): void;
}

// ── AcpRuntime: one preset, many sessions ───────────────────────────────────────────────────────────────────────

/** A conversation's ACP session in an agent process. */
interface LiveSession {
  sessionId: string;
  acpSessionId: string;
  cwd: string;
  process: AgentProcess;
  projector: AcpTimelineProjector;
  turn: Promise<TurnResult> | undefined;
  /** Waiting `session/request_permission` calls, answered `cancelled` on cancel. */
  permissions: Map<string, (result: AcpRequestPermissionResult) => void>;
  supportsConfigOptions: boolean;
  /** Taken off on purpose (`stop`, a close): a turn that ends with it ended `cancelled`, not failed. */
  stopped: boolean;
  /** Rejects once the session is taken off its process: the agent may never answer what it was asked. */
  gone: Promise<never>;
  leave: (reason: Error) => void;
  /** Runs while nothing is in flight; see `#settle`. */
  idleTimer: NodeJS.Timeout | undefined;
  /** Idle for the whole idle close, in an agent that cannot close single sessions: it goes with the process. */
  expired: boolean;
  /** Requests of ours the agent is answering, and holds: the session is not idle meanwhile. */
  requests: number;
}

/** Output of an agent at work: outside a turn it restarts the idle clock (metadata such as usage reports does not). */
const ACTIVITY_UPDATES: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** The settings of an opened session: its `session/new` answer with the buffered setting changes applied. */
function configOfOpened(opened: OpenedSession): ConfigOption[] {
  let config = configFromSessionResult(opened.result);
  for (const { sessionId, update } of opened.updates) {
    if (sessionId !== opened.result.sessionId) continue;
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) config = configOptionsFromAcp(update.configOptions);
    else if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") config = configWithMode(config, update.currentModeId);
  }
  return withApprovals(config, opened.process, opened.result.sessionId);
}

/** `config` with AA's approvals setting at its end when the process has approvals, and without it when not. */
function withApprovals(config: readonly ConfigOption[], process: AgentProcess, acpSessionId: string): ConfigOption[] {
  const others = config.filter((option) => option.id !== PI_APPROVALS_CONFIG_ID);
  const approvals = process.approvals;
  return approvals === undefined || approvals.off ? others : [...others, piApprovalsOption(approvals.mode(acpSessionId))];
}

/** The approvals mode a conversation's settings hold, if any. */
function approvalModeOf(config: readonly ConfigOption[] | undefined): PiApprovalMode | undefined {
  const current = config?.find((option) => option.id === PI_APPROVALS_CONFIG_ID)?.current;
  return isPiApprovalMode(current) ? current : undefined;
}

/** Change AA's approvals setting of a session: kept here, since the agent never sees it. */
async function setApprovalMode(process: AgentProcess, acpSessionId: string, value: string): Promise<void> {
  const approvals = process.approvals;
  if (approvals === undefined || approvals.off) {
    throw new InvalidArgumentError("approvals are off for this agent", { details: { reason: "unknown_config" } });
  }
  if (!isPiApprovalMode(value)) throw new InvalidArgumentError(`no approvals mode "${value}"`);
  await approvals.set(acpSessionId, value);
}

/** `PreparedAgent` of an `AcpRuntime`: a session that waits, keeping the agent's updates until a conversation takes it over. */
class WarmAgent implements PreparedAgent {
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly process: AgentProcess;
  onExit: (() => void) | undefined;
  readonly #owner: AcpRuntime;
  readonly #opened: OpenedSession;
  readonly #onDone: () => void;
  #state: "waiting" | "taken" | "closed" = "waiting";

  constructor(
    owner: AcpRuntime,
    cwd: string,
    opened: OpenedSession,
    onRequest: (method: string, params: unknown) => Promise<unknown>,
    /** Once it stops waiting (taken over, closed, or the process is gone). */
    onDone: () => void,
  ) {
    this.#owner = owner;
    this.cwd = cwd;
    this.acpSessionId = opened.result.sessionId;
    this.process = opened.process;
    this.#opened = opened;
    this.#onDone = onDone;
    opened.process.claim(this.acpSessionId, {
      onUpdate: (params) => bufferUpdate(opened.updates, params),
      onRequest,
      onExit: () => this.gone(),
    });
  }

  get config(): ConfigOption[] {
    return configOfOpened(this.#opened);
  }

  get usable(): boolean {
    return this.#state === "waiting" && !this.process.retired && !this.process.closed;
  }

  /**
   * Change a setting while it waits. The answer is buffered like the agent's own setting changes, so `config` shows
   * it and the session that takes it over starts with it.
   */
  async setConfig(configId: string, value: string): Promise<ConfigOption[]> {
    if (!this.usable) throw new UnavailableError("the prepared agent is no longer running");
    const sessionId = this.acpSessionId;
    if (configId === PI_APPROVALS_CONFIG_ID) {
      await setApprovalMode(this.process, sessionId, value);
      return this.config;
    }
    const { result, updates } = this.#opened;
    const conn = this.process.conn;
    if (!Array.isArray(result.configOptions) && configId === MODE_CONFIG_ID) {
      await conn.request("session/set_mode", { sessionId, modeId: value });
      bufferUpdate(updates, { sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: value } });
    } else {
      const answer = await conn.request("session/set_config_option", { sessionId, configId, value });
      bufferUpdate(updates, { sessionId, update: { sessionUpdate: "config_option_update", configOptions: answer?.configOptions ?? [] } });
    }
    return this.config;
  }

  /** For `owner.startSession`: the session, now the conversation's; undefined when it cannot be taken over there. */
  takeOver(owner: AcpRuntime, cwd: string): OpenedSession | undefined {
    if (owner !== this.#owner || cwd !== this.cwd || !this.usable) return undefined;
    this.#state = "taken";
    this.#onDone();
    return this.#opened;
  }

  /** The process is gone (or being stopped): nothing waits any more. */
  gone(): void {
    if (this.#state !== "waiting") return;
    this.#state = "closed";
    this.#onDone();
    try {
      this.onExit?.();
    } catch {
      // Exit listeners never throw into the event loop.
    }
  }

  async close(): Promise<void> {
    if (this.#state !== "waiting") return;
    this.#state = "closed";
    await this.process.closeSession(this.acpSessionId);
    this.#onDone();
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
  /**
   * Close a session's agent after this long with nothing in flight (no turn, no permission request, no setting
   * change), when the agent can restore its context: the session's next message starts it again and restores it.
   * For agents without an `idle_close_minutes` setting of their own. Default (and 0 or null): never.
   */
  idleTtlMs?: number | null;
  /** Restores that failed (the agent lost its earlier context), restores and idle closes. */
  logger?: RuntimeLogger;
  /** Where Pi processes' approvals mode files go (default: a folder in the system's temporary folder). */
  approvalsDir?: string;
  /** Pi's global extensions folder (default: `piExtensionsDir()`, as Pi resolves it). */
  piExtensionsDir?: string;
  /**
   * The folder agent processes start in (created if needed; default: the system's temporary folder). Every session
   * names its own folder; this one belongs to none of them.
   */
  processCwd?: string;
  /** The PATH agent processes get (default: the Connector's). */
  agentPath?: () => string | undefined;
  /** Where a command by its name is, when it can be found (default: the system looks for it). */
  resolveCommand?: (command: string) => string | undefined;
  /** Its own program with the arguments that make it sign in, when that is known and the program is there. */
  programSignIn?: () => { command: string; args: string[] } | undefined;
  /** The way that was signed in with is remembered (`undefined`: it no longer works). */
  onSignInChange?: (methodId: string | undefined) => void;
  /** How long a sign-in may take (default 10 min: someone does it in a browser). */
  signInTimeoutMs?: number;
}

export class AcpRuntime implements AgentRuntime {
  readonly id: string;
  readonly #options: AcpRuntimeOptions;
  #preset: AgentLaunch;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #starting = new Map<string, Promise<StartedSession>>();
  /** Prepared sessions not taken over yet. */
  readonly #prepared = new Set<WarmAgent>();
  /** The process sessions are opened in, once one was started. */
  #process: AgentProcess | undefined;
  #processStarting: Promise<AgentProcess> | undefined;
  /** Every process that runs: the current one, retired ones, and sessions' own. */
  readonly #processes = new Set<AgentProcess>();
  /** Agents between spawn and the end of `initialize`: `dispose` kills them too. */
  readonly #launching = new Set<AcpConnection>();
  /** Run while a process has no session: it is closed after the idle close. */
  readonly #processTimers = new Map<AgentProcess, NodeJS.Timeout>();
  /** Sessions being closed: a new start of the same conversation waits until the agent has let go of it. */
  readonly #closing = new Map<string, Promise<void>>();
  /** Bumped by `dispose` / `stop`: a start that began before must not leave a process behind. */
  #generation = 0;
  /** Bumped when processes must be started anew: one that started with the settings before is retired at once. */
  #launch = 0;
  /** Why the last `dispose` / `stop` happened, for the starts it cut short. */
  #stoppedBecause = "the Connector stopped";
  /** AA's approvals are on: its preset has `approvals` and the user turned them on. */
  #approvalsOn = false;
  /** Approvals files of processes that run, or are just gone: each settles once its file is removed. */
  readonly #approvalsFiles = new Set<Promise<void>>();
  /** The agent's own idle close (ms; 0: never); `undefined`: the host's `idleTtlMs`. */
  #idleCloseMs: number | undefined;
  /** The ways to sign in its newest process named. */
  #offered: AcpAuthMethod[] = [];
  /** The way that was signed in with last, for processes that ask again. */
  #signedInWith: string | undefined;
  #signIn: { readonly methodId: string; readonly done: Promise<void>; readonly abort: AbortController } | undefined;

  constructor(preset: AgentLaunch, options: AcpRuntimeOptions) {
    this.#preset = copyPreset(preset);
    this.id = preset.id;
    this.#options = options;
  }

  /** The preset agent processes are started with (`configure` changes it). */
  get preset(): AgentLaunch {
    return copyPreset(this.#preset);
  }

  get name(): string {
    return this.#preset.name;
  }

  /**
   * Run the agent with `preset` from now on. When that takes another process, the running one is retired: idle
   * sessions move to the next one right away, the others once what they do has ended.
   */
  configure(preset: AgentLaunch): void {
    if (preset.id !== this.id) throw new TypeError(`a runtime keeps its id (${this.id}, not ${preset.id})`);
    const before = this.#preset;
    this.#preset = copyPreset(preset);
    if (!sameLaunch(before, this.#preset)) this.#relaunch();
  }

  processCount(): number {
    return [...this.#processes].filter((process) => !process.stopping).length + this.#launching.size;
  }

  sessionCount(): number {
    return this.#sessions.size + this.#prepared.size;
  }

  configureIdle(ms: number | undefined): void {
    this.#idleCloseMs = ms;
    // Sessions and processes idle now count from now with the new time (or stop counting).
    for (const live of [...this.#sessions.values()]) this.#settle(live);
    for (const process of [...this.#processes]) this.#settleProcess(process);
  }

  configureApprovals(on: boolean): void {
    const was = this.#approvalsOn;
    this.#approvalsOn = on && this.#preset.approvals === "pi";
    if (was !== this.#approvalsOn) this.#switchApprovals();
    for (const { id, agent } of this.#options.store.list().sessions) if (agent === this.id) this.#showApprovals(id);
  }

  #switchApprovals(): void {
    // Turned on: only a process started with them has approvals.
    if (this.#approvalsOn) return this.#relaunch();
    // Turned off: the running processes keep the extension until they stop, so it reads "never ask" from now on,
    // and their conversations no longer show the setting.
    for (const process of this.#processes) void process.approvals?.turnOff().catch(() => undefined);
    const store = this.#options.store;
    for (const live of this.#sessions.values()) {
      const config = live.process.approvals === undefined ? undefined : store.get(live.sessionId)?.config;
      if (config !== undefined) store.updateSession(live.sessionId, { config: withApprovals(config, live.process, live.acpSessionId) });
    }
  }

  /**
   * A conversation that is not open has the approvals setting while approvals are on (an open one gets it from its
   * process): what is chosen there is used once it is opened.
   */
  #showApprovals(sessionId: string): void {
    const store = this.#options.store;
    const config = this.#sessions.has(sessionId) ? undefined : store.get(sessionId)?.config;
    if (config === undefined) return;
    const others = config.filter((option) => option.id !== PI_APPROVALS_CONFIG_ID);
    if (this.#approvalsOn === others.length < config.length) return;
    store.updateSession(sessionId, { config: this.#approvalsOn ? [...config, piApprovalsOption(DEFAULT_PI_APPROVAL_MODE)] : others }, { touch: false });
  }

  // ── Signing in ──

  /**
   * Sign in with one of the agent's ways (ACP `authenticate`; asking again joins the one that runs, another way ends
   * it). Sessions can be opened in that process then, so it stays.
   */
  signIn(methodId: string): Promise<void> {
    if (this.#signIn?.methodId === methodId) return this.#signIn.done;
    this.cancelSignIn();
    const abort = new AbortController();
    const done = this.#authenticate(methodId, abort.signal).finally(() => {
      if (this.#signIn === running) this.#signIn = undefined;
    });
    // Whoever asked may be gone by the time it ends.
    done.catch(() => undefined);
    const running = { methodId, done, abort };
    this.#signIn = running;
    return done;
  }

  /** Sign in this way when a process asks for it (the way that was signed in with before). */
  configureSignIn(methodId: string | undefined): void {
    this.#signedInWith = methodId;
  }

  #rememberSignIn(methodId: string | undefined): void {
    if (this.#signedInWith === methodId) return;
    this.#signedInWith = methodId;
    this.#options.onSignInChange?.(methodId);
  }

  /**
   * A process asks for a sign-in: try the way that worked before (some agents want `authenticate` from every process,
   * signed in or not). Tried for a short time and, when it does not work, not again: it may have opened a browser.
   */
  async #signInAgain(process: AgentProcess): Promise<boolean> {
    const methodId = this.#signedInWith;
    if (methodId === undefined || this.#signIn !== undefined) return false;
    const method = this.#offered.find(({ id }) => id === methodId);
    try {
      if (method === undefined || isTerminalMethod(method)) throw new UnavailableError(`it no longer offers ${methodId}`);
      await process.authenticate(methodId, { timeoutMs: SIGN_IN_AGAIN_TIMEOUT_MS, signal: new AbortController().signal });
      return true;
    } catch (error) {
      // Stopped or gone meanwhile: that says nothing about the sign-in.
      if (!process.closed) {
        this.#log("warn", `${this.name}: signing in again (${methodId}) failed: ${agentErrorText(error)}`);
        this.#rememberSignIn(undefined);
      }
      return false;
    }
  }

  cancelSignIn(): void {
    this.#signIn?.abort.abort(new MeshCallError("failed_precondition", `signing in to ${this.name} was cancelled`, { details: { reason: "sign_in_cancelled", agent: this.id } }));
  }

  /** The ways to sign in that are known: the agent names its own once it was started. */
  get signInMethods(): SignInMethod[] {
    return signInMethods(this.#offered, this.#options.programSignIn?.());
  }

  /** What to run in a terminal to sign in this way. */
  signInCommand(methodId: string): SignInCommand {
    const searchPath = this.#options.agentPath?.();
    const env = { ...(searchPath !== undefined ? { PATH: searchPath } : {}), ...(this.#preset.env ?? {}) };
    if (methodId === PROGRAM_SIGN_IN) {
      const program = this.#options.programSignIn?.();
      if (program !== undefined) return { ...program, env };
    }
    const method = this.#offered.find(({ id }) => id === methodId);
    if (method === undefined || !isTerminalMethod(method)) throw this.#unknownSignIn(methodId);
    const named = method.type === "terminal" ? undefined : terminalCommand(method);
    if (named !== undefined) return { ...named, env: { ...env, ...named.env } };
    return {
      command: this.#options.resolveCommand?.(this.#preset.command) ?? this.#preset.command,
      args: [...(this.#preset.args ?? []), ...(method.args ?? [])],
      env: { ...env, ...(method.env ?? {}) },
    };
  }

  async #authenticate(methodId: string, signal: AbortSignal): Promise<void> {
    const process = await this.#acquire();
    this.#holdProcess(process);
    try {
      const method = this.#offered.find(({ id }) => id === methodId);
      if (method === undefined || isTerminalMethod(method)) throw this.#unknownSignIn(methodId);
      await process.authenticate(methodId, { timeoutMs: this.#options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS, signal });
      this.#rememberSignIn(methodId);
    } catch (error) {
      // As after a failed start: the next try starts anew.
      if (!this.#isUsed(process)) await process.close();
      if (error instanceof MeshCallError && !(error instanceof UnavailableError)) throw error;
      throw new MeshCallError("failed_precondition", agentErrorText(error), { details: { reason: "sign_in_failed", agent: this.id } });
    }
    this.#settleProcess(process);
  }

  #unknownSignIn(methodId: string): InvalidArgumentError {
    return new InvalidArgumentError(`${this.name} cannot be signed in to with ${methodId}`, { details: { reason: "unknown_sign_in_method", agent: this.id } });
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
    const opened = live === undefined && pending === undefined && prepared instanceof WarmAgent ? prepared.takeOver(this, input.cwd) : undefined;
    // A prepared session handed over but not taken over (gone, another folder, already started) has no other owner.
    if (prepared !== undefined && opened === undefined) void prepared.close();
    if (live !== undefined) {
      return Promise.resolve({
        acpSessionId: live.acpSessionId,
        config: this.#options.store.get(input.sessionId)?.config ?? [],
        ...(input.hold ? { release: this.#hold(live) } : {}),
      });
    }
    if (pending !== undefined) {
      return pending.then((started) => {
        const now = this.#sessions.get(input.sessionId);
        return input.hold && now !== undefined ? { ...started, release: this.#hold(now) } : started;
      });
    }
    if (opened !== undefined) {
      try {
        return Promise.resolve({ ...this.#attach(input, opened), prepared: true });
      } catch (error) {
        void opened.process.closeSession(opened.result.sessionId);
        return Promise.reject(error);
      }
    }
    const started = this.#start(input).finally(() => this.#starting.delete(input.sessionId));
    this.#starting.set(input.sessionId, started);
    return started;
  }

  /**
   * Open a session in `cwd` ahead of a conversation: it waits (keeping its updates) until `startSession({ prepared })`
   * takes it over or it is closed. Rejects like a session start (`#startError`).
   */
  async prepare(input: { cwd: string }): Promise<PreparedAgent> {
    const opened = await this.#open(input.cwd);
    const process = opened.process;
    const agent: WarmAgent = new WarmAgent(
      this,
      input.cwd,
      opened,
      (method, params) => this.#handleAgentRequest(input.cwd, undefined, method, params),
      () => {
        this.#prepared.delete(agent);
        this.#settleProcess(process);
      },
    );
    this.#prepared.add(agent);
    return agent;
  }

  async #start(input: StartSessionInput): Promise<StartedSession> {
    const generation = this.#generation;
    const stopped = () => this.#startError(new UnavailableError(`${this.#stoppedBecause} while it started`));
    // The conversation's earlier session is closed first (idle, say): it may be the one reopened here.
    await this.#closing.get(input.sessionId);
    if (generation !== this.#generation) throw stopped();
    const store = this.#options.store;
    const earlier = store.has(input.sessionId) ? store.acpSessionId(input.sessionId) : undefined;
    const mode = approvalModeOf(store.get(input.sessionId)?.config);
    const opened = await this.#open(input.cwd, earlier);
    const { process, result } = opened;
    if (process.approvals !== undefined && mode !== undefined) await process.approvals.set(result.sessionId, mode).catch(() => undefined);
    try {
      if (generation !== this.#generation) throw stopped();
      return this.#attach(input, opened);
    } catch (error) {
      await process.closeSession(result.sessionId);
      this.#settleProcess(process);
      throw error;
    }
  }

  // ── Processes ──

  /** The process to open a session in, started if there is none. */
  async #acquire(): Promise<AgentProcess> {
    for (;;) {
      let process: AgentProcess;
      if (this.#preset.own_process === true) {
        process = await this.#startProcess(true);
      } else {
        const current = this.#process;
        if (current !== undefined && !current.retired) return current;
        this.#processStarting ??= this.#startProcess(false).finally(() => (this.#processStarting = undefined));
        process = await this.#processStarting;
      }
      if (process.closed) throw this.#startError(exitedError(process.conn));
      if (!process.retired) return process;
      // The settings changed while it started: the next one has them.
      this.#settleProcess(process);
    }
  }

  async #startProcess(dedicated: boolean): Promise<AgentProcess> {
    // The settings at this moment: a later change retires the process.
    const preset = this.#preset;
    const launch = this.#launch;
    const generation = this.#generation;
    const cwd = this.#options.processCwd ?? os.tmpdir();
    await mkdir(cwd, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const approvals = this.#approvalsOn ? await this.#approvalsFile() : undefined;
    const searchPath = this.#options.agentPath?.();
    const gateway = preset.gateway;
    const env = {
      ...(searchPath !== undefined ? { PATH: searchPath } : {}),
      ...(preset.env ?? {}),
      ...(gateway?.env ?? {}),
      ...(approvals ? { [PI_APPROVALS_ENV]: approvals.path } : {}),
    };
    let conn: AcpConnection | undefined;
    try {
      const process = await AgentProcess.start({
        name: this.name,
        dedicated,
        command: this.#options.resolveCommand?.(preset.command) ?? preset.command,
        args: preset.args,
        cwd,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(this.#options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.#options.requestTimeoutMs } : {}),
        ...(this.#options.killGraceMs !== undefined ? { killGraceMs: this.#options.killGraceMs } : {}),
        startupTimeoutMs: this.#options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
        clientInfo: this.#options.clientInfo ?? { name: "agents-anywhere-connector", version: "3" },
        approvals,
        sessionMeta: gateway?.sessionMeta,
        ...(gateway?.provider !== undefined ? { onReady: (ready, init) => this.#setProvider(ready, init, gateway.provider as AcpSetProviderParams) } : {}),
        onUnownedRequest: (folder, method, params) => this.#handleAgentRequest(folder, undefined, method, params),
        onSpawn: (spawned) => {
          conn = spawned;
          this.#launching.add(spawned);
          if (approvals === undefined) return;
          const removed: Promise<void> = spawned.exited
            .then(() => approvals.remove())
            .catch(() => undefined)
            .finally(() => this.#approvalsFiles.delete(removed));
          this.#approvalsFiles.add(removed);
        },
      });
      if (generation !== this.#generation) {
        await process.close();
        throw new UnavailableError(`${this.#stoppedBecause} while it started`);
      }
      this.#processes.add(process);
      this.#offered = offeredMethods(process.init.authMethods);
      void process.conn.exited.then(() => {
        this.#processes.delete(process);
        if (this.#process === process) this.#process = undefined;
        this.#holdProcess(process);
      });
      if (launch !== this.#launch) process.retired = true;
      else if (!dedicated) this.#process = process;
      return process;
    } catch (error) {
      if (conn === undefined) await approvals?.remove().catch(() => undefined);
      // Killed by `dispose` / `stop` (it exited, so the request failed): say so rather than "the agent exited".
      throw this.#startError(generation === this.#generation ? error : new UnavailableError(`${this.#stoppedBecause} while it started`));
    } finally {
      if (conn !== undefined) this.#launching.delete(conn);
    }
  }

  /** Point a process that has just started at its model gateway: it must not answer through anything else. */
  async #setProvider(conn: AcpConnection, init: AcpInitializeResult, provider: AcpSetProviderParams): Promise<void> {
    if (init.agentCapabilities?.providers == null) throw new UnavailableError("this version of it cannot be pointed at a model gateway");
    try {
      await conn.request("providers/set", provider);
    } catch (error) {
      throw new UnavailableError(`it refused the model gateway: ${agentErrorText(error)}`);
    }
  }

  /**
   * An approvals file for a process about to start, with the extension installed (again, if it was removed or is from
   * an older Connector). Without them the process starts without approvals, which is said in the log.
   */
  async #approvalsFile(): Promise<PiApprovalsFile | undefined> {
    try {
      await installPiApprovals(this.#options.piExtensionsDir);
      return await PiApprovalsFile.create(this.#options.approvalsDir ?? path.join(os.tmpdir(), "aa-pi-approvals"));
    } catch (error) {
      this.#log("warn", `${this.name} starts without approvals: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Open a session (see `AgentProcess.open`) in a process with the settings of now. Rejects with `#startError`. */
  async #open(cwd: string, earlier?: string): Promise<OpenedSession> {
    const generation = this.#generation;
    const stopped = () => this.#startError(new UnavailableError(`${this.#stoppedBecause} while it started`));
    for (;;) {
      const process = await this.#acquire();
      this.#holdProcess(process);
      let opened: OpenedSession;
      try {
        try {
          opened = await process.open(cwd, earlier);
        } catch (error) {
          if (!isAuthRequired(error) || !(await this.#signInAgain(process))) throw error;
          opened = await process.open(cwd, earlier);
        }
      } catch (error) {
        // Nothing else needs it: the next try starts anew (the user may have signed in by then, say).
        if (!this.#isUsed(process)) await process.close();
        if (generation !== this.#generation) throw stopped();
        throw this.#startError(error);
      }
      if (generation !== this.#generation || process.closed) {
        await process.closeSession(opened.result.sessionId);
        if (generation !== this.#generation) throw stopped();
        throw this.#startError(exitedError(process.conn));
      }
      if (!process.retired) return opened;
      // The settings changed while the session was opened: it has nothing to lose yet, so it is opened again.
      await process.closeSession(opened.result.sessionId);
      this.#settleProcess(process);
    }
  }

  /** Processes are started anew from now on; the running ones are retired. */
  #relaunch(): void {
    this.#launch++;
    this.#process = undefined;
    for (const process of [...this.#processes]) {
      if (process.retired) continue;
      process.retired = true;
      for (const live of this.#sessionsOf(process)) this.#settle(live);
      this.#settleProcess(process);
    }
  }

  #sessionsOf(process: AgentProcess): LiveSession[] {
    return [...this.#sessions.values()].filter((live) => live.process === process);
  }

  /** A conversation, a prepared session or one being opened needs it. */
  #isUsed(process: AgentProcess): boolean {
    return process.inUse || this.#sessionsOf(process).length > 0 || [...this.#prepared].some((agent) => agent.process === process);
  }

  /**
   * Stop a process nothing needs any more: a retired or dedicated one at once, the shared one after the idle close
   * (without a session, or when all of its sessions have been idle that long).
   */
  #settleProcess(process: AgentProcess): void {
    this.#holdProcess(process);
    if (process.stopping || process.closed || process.opening || [...this.#prepared].some((agent) => agent.process === process)) return;
    const sessions = this.#sessionsOf(process);
    if (process.retired || process.dedicated) {
      if (sessions.length === 0) void process.close();
      return;
    }
    const ttl = this.#idleTtlMs;
    if (ttl === 0) return;
    if (sessions.length === 0) {
      const timer = setTimeout(() => {
        this.#processTimers.delete(process);
        if (this.#isUsed(process) || process.stopping || process.closed) return;
        this.#log("info", `${this.name}: closing its process after ${formatDuration(ttl)} without a conversation`);
        void process.close();
      }, ttl);
      timer.unref?.();
      this.#processTimers.set(process, timer);
    } else if (sessions.every((live) => live.expired)) {
      this.#log("info", `${this.name}: closing its process after ${formatDuration(ttl)} idle; the next message of a conversation restores it`);
      for (const live of sessions) this.#detach(live, "the agent was closed");
      const closed = process.close();
      for (const live of sessions) this.#whileClosing(live.sessionId, closed);
    }
  }

  /** The agent is letting go of the conversation's session until `closed`: a new start of it waits for that. */
  #whileClosing(sessionId: string, closed: Promise<void>): void {
    const done: Promise<void> = closed
      .catch(() => undefined)
      .then(() => {
        if (this.#closing.get(sessionId) === done) this.#closing.delete(sessionId);
      });
    this.#closing.set(sessionId, done);
  }

  #holdProcess(process: AgentProcess): void {
    const timer = this.#processTimers.get(process);
    if (timer !== undefined) clearTimeout(timer);
    this.#processTimers.delete(process);
  }

  // ── Sessions ──

  /** Make an opened session the live one of a conversation, as if the projector had listened from the start. */
  #attach(input: StartSessionInput, opened: OpenedSession): StartedSession {
    const { sessionId, cwd } = input;
    const store = this.#options.store;
    const { process, result, updates, restored, restoreError } = opened;
    if (process.closed) throw this.#startError(exitedError(process.conn));
    const acpSessionId = result.sessionId;
    const projector = new AcpTimelineProjector({
      store,
      sessionId,
      ...(this.#options.newId ? { newId: this.#options.newId } : {}),
      // AA's approvals setting is not the agent's: it stays when the agent reports its own settings.
      decorateConfig: (config) => withApprovals(config, process, acpSessionId),
    });
    // A reopened session that reports no settings keeps the ones the conversation shows (and the modern API).
    const reportsConfig = result.configOptions != null || result.modes != null;
    let leave: (reason: Error) => void = () => undefined;
    const gone = new Promise<never>((_resolve, reject) => (leave = reject));
    gone.catch(() => undefined);
    const live: LiveSession = {
      sessionId,
      acpSessionId,
      cwd,
      process,
      projector,
      turn: undefined,
      permissions: new Map(),
      supportsConfigOptions: Array.isArray(result.configOptions) || (restored !== undefined && !reportsConfig),
      stopped: false,
      gone,
      leave,
      idleTimer: undefined,
      expired: false,
      requests: 0,
    };
    this.#sessions.set(sessionId, live);
    process.claim(acpSessionId, {
      onRequest: (method, params) => this.#handleAgentRequest(cwd, live, method, params),
      onExit: () => this.#onExit(live),
      onUpdate: (params) => {
        if (!store.has(sessionId)) return;
        projector.handleNotification(params, acpSessionId);
        // The agent working on its own between turns is activity too.
        if (live.turn === undefined && ACTIVITY_UPDATES.has(String(params?.update?.sessionUpdate))) this.#settle(live);
      },
    });
    if (store.has(sessionId)) {
      // Saved with the conversation: its next session reopens it.
      store.setAcpSessionId(sessionId, acpSessionId);
      if (restored === undefined || reportsConfig) store.updateSession(sessionId, { config: configFromSessionResult(result) });
      // The session's own approvals mode (the conversation's, or the default for a new one), or none.
      store.updateSession(sessionId, { config: withApprovals(store.get(sessionId)?.config ?? [], process, acpSessionId) });
      store.updateControl(sessionId, { state: "idle", error: undefined });
      // What the agent sent before anyone listened (commands, setting changes, a banner, …).
      for (const params of updates) {
        try {
          projector.handleNotification(params, acpSessionId);
        } catch {
          // As for live updates: a projection failure must not stop the session.
        }
      }
      if (restored !== undefined) {
        this.#log("info", `${this.name} reopened its session for conversation ${sessionId} (session/${restored})`);
      } else if (restoreError !== undefined && hasAgentOutput(store, sessionId)) {
        this.#log("warn", `${this.name} could not restore its earlier context for conversation ${sessionId} and continues without it: ${restoreError}`);
      }
    }
    updates.length = 0;
    const started: StartedSession = { acpSessionId, config: store.get(sessionId)?.config ?? configFromSessionResult(result) };
    if (restored !== undefined) started.restored = restored;
    if (restoreError !== undefined) started.restoreError = restoreError;
    if (input.hold) started.release = this.#hold(live);
    else this.#settle(live);
    return started;
  }

  /**
   * Why the agent did not start, worded for the user (one "could not start …" prefix) with a stable reason:
   * `failed_precondition` / `agent_auth_required` when the agent wants a sign-in first (ACP `-32000`; the ways to sign
   * in go along as `auth_methods`, what it said as `agent_message`), otherwise `unavailable` / `agent_start_failed`
   * (program missing, it exited, it timed out, or it answered something unusable).
   */
  #startError(error: unknown): MeshCallError {
    const raw = agentErrorText(error);
    const message = raw.startsWith("could not start ") ? raw : `could not start ${this.name}: ${raw}`;
    if (isAuthRequired(error)) {
      const details: Record<string, unknown> = { reason: "agent_auth_required", agent: this.id, agent_message: raw };
      const methods = this.signInMethods;
      if (methods.length > 0) details.auth_methods = methods;
      return new MeshCallError("failed_precondition", message, { details });
    }
    return new UnavailableError(message, { details: { reason: "agent_start_failed", agent: this.id } });
  }

  sendPrompt(sessionId: string, input: { turnId: string; prompt: AcpContentBlock[] }): Promise<TurnResult> {
    const live = this.#require(sessionId);
    if (live.turn !== undefined) return Promise.reject(new MeshCallError("failed_precondition", "a turn is already running", { details: { reason: "turn_running" } }));
    this.#holdIdle(live);
    live.projector.beginTurn(input.turnId, input.prompt);
    const turn = (async (): Promise<TurnResult> => {
      let outcome: TurnResult;
      let failure: string | undefined;
      try {
        const prompt = live.process.promptImages ? await inlineImages(input.prompt) : input.prompt;
        const answer = live.process.conn.request("session/prompt", { sessionId: live.acpSessionId, prompt }, null);
        const result = await Promise.race([answer, live.gone]);
        outcome = result?.stopReason ?? "end_turn";
      } catch (error) {
        if (live.stopped) {
          // Ended on purpose (an agent that did not answer `session/cancel` in time, a session closed meanwhile).
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
      this.#settle(live);
      return outcome;
    })();
    live.turn = turn;
    return turn;
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) return;
    live.process.conn.notify("session/cancel", { sessionId: live.acpSessionId });
    // ACP: the client answers every waiting permission request `cancelled`, or the prompt never returns.
    this.#cancelPermissions(live);
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
    const live = this.#require(sessionId);
    const store = this.#options.store;
    const { process, acpSessionId } = live;
    if (configId === PI_APPROVALS_CONFIG_ID) {
      await setApprovalMode(process, acpSessionId, value);
      const config = withApprovals(store.get(sessionId)?.config ?? [], process, acpSessionId);
      if (store.has(sessionId)) store.updateSession(sessionId, { config });
      return config;
    }
    const release = this.#hold(live);
    try {
      let config: ConfigOption[];
      if (!live.supportsConfigOptions && configId === MODE_CONFIG_ID) {
        await process.conn.request("session/set_mode", { sessionId: acpSessionId, modeId: value });
        config = (store.get(sessionId)?.config ?? []).map((o) => (o.id === MODE_CONFIG_ID ? { ...o, current: value } : o));
      } else {
        try {
          const result = await process.conn.request("session/set_config_option", { sessionId: acpSessionId, configId, value });
          config = withApprovals(configOptionsFromAcp(result?.configOptions ?? []), process, acpSessionId);
        } catch (error) {
          if (error instanceof AcpRequestError && error.code === JsonRpcErrorCode.INVALID_PARAMS) throw new InvalidArgumentError(error.message);
          throw error;
        }
      }
      if (store.has(sessionId)) store.updateSession(sessionId, { config });
      return config;
    } finally {
      release();
    }
  }

  answerPermission(sessionId: string, input: AnswerInput): AnswerResult {
    // The projector listens to the store: the accepted answer resolves the agent's request.
    return this.#options.store.answerPendingRequest(sessionId, input);
  }

  /** Close the conversation's ACP session (saved with it: the next start reopens it). Resolves once the agent let go of it. */
  async closeSession(sessionId: string): Promise<void> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) {
      await this.#closing.get(sessionId);
      return;
    }
    const { process, acpSessionId } = live;
    const working = live.turn !== undefined;
    live.stopped = true;
    this.#detach(live, "the conversation was closed");
    const last = (process.retired || process.dedicated) && this.#sessionsOf(process).length === 0 && !process.opening;
    const closed = (last ? process.close() : process.closeSession(acpSessionId, { working })).catch(() => undefined).finally(() => this.#settleProcess(process));
    this.#whileClosing(sessionId, closed);
    await closed;
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

  /** Stop every process, with the sessions in it and the ones still starting; starts under way fail with `why`. */
  async #closeAll(why: string): Promise<void> {
    this.#generation++;
    this.#stoppedBecause = why;
    this.#process = undefined;
    for (const live of [...this.#sessions.values()]) this.#detach(live, why);
    for (const agent of [...this.#prepared]) agent.gone();
    await Promise.all([
      ...[...this.#processes].map((process) => process.close()),
      ...[...this.#launching].map((conn) => conn.close()),
      ...this.#closing.values(),
    ]);
    await Promise.all(this.#approvalsFiles);
  }

  // ── Internals ──

  #require(sessionId: string): LiveSession {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) throw new UnavailableError(`the agent for session ${sessionId} is not running`);
    return live;
  }

  /** Take a session off its process: it is not live any more, and nothing waits for the agent's answers to it. */
  #detach(live: LiveSession, reason: string): void {
    if (this.#sessions.get(live.sessionId) === live) this.#sessions.delete(live.sessionId);
    this.#holdIdle(live);
    this.#cancelPermissions(live);
    live.projector.dispose();
    live.leave(new UnavailableError(reason));
    this.#showApprovals(live.sessionId);
  }

  #onExit(live: LiveSession): void {
    if (this.#sessions.get(live.sessionId) !== live) return;
    // A running turn reports its own failure, with what the agent said last.
    this.#sessions.delete(live.sessionId);
    this.#holdIdle(live);
    this.#cancelPermissions(live);
    live.projector.dispose();
    const store = this.#options.store;
    if (live.turn === undefined && store.has(live.sessionId)) {
      // Idle agent gone: the next prompt starts it again (reopening its session).
      store.updateControl(live.sessionId, { state: "idle" });
    }
    this.#showApprovals(live.sessionId);
  }

  // ── Idle sessions ──

  /** How long a session may sit idle (0: for ever): the agent's own setting, else the host's `idleTtlMs`, else for ever. */
  get #idleTtlMs(): number {
    const ttl = this.#idleCloseMs ?? this.#options.idleTtlMs;
    return ttl !== undefined && ttl !== null && ttl > 0 ? ttl : 0;
  }

  /** Nothing in flight: no turn, no permission request, no request of ours. */
  #isIdle(live: LiveSession): boolean {
    return live.turn === undefined && live.permissions.size === 0 && live.requests === 0;
  }

  /** The session is not idle until the result is called. */
  #hold(live: LiveSession): () => void {
    live.requests++;
    this.#holdIdle(live);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      live.requests--;
      this.#settle(live);
    };
  }

  /**
   * Something ended in a session. If nothing is in flight any more and the agent can restore its context: a session of
   * a retired process moves on at once (its next message opens it in the next process), any other one is closed after
   * the idle close.
   */
  #settle(live: LiveSession): void {
    this.#holdIdle(live);
    if (live.process.restoreMethods.length === 0 || !this.#isIdle(live) || this.#sessions.get(live.sessionId) !== live) return;
    if (live.process.retired) {
      void this.closeSession(live.sessionId);
      return;
    }
    const ttl = this.#idleTtlMs;
    if (ttl === 0) return;
    live.idleTimer = setTimeout(() => this.#closeIdle(live, ttl), ttl);
    live.idleTimer.unref?.();
  }

  /** Something is in flight: the session is not idle. */
  #holdIdle(live: LiveSession): void {
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    live.idleTimer = undefined;
    live.expired = false;
  }

  /**
   * Idle for the whole idle close. The conversation stays, and its next message restores the session. The process goes
   * when all of its sessions are idle that long; until then only this session does, in an agent that can close it alone.
   */
  #closeIdle(live: LiveSession, ttl: number): void {
    live.idleTimer = undefined;
    if (this.#sessions.get(live.sessionId) !== live || !this.#isIdle(live)) return;
    live.expired = true;
    const process = live.process;
    this.#settleProcess(process);
    if (process.stopping || !process.closesSessions || this.#sessions.get(live.sessionId) !== live) return;
    this.#log("info", `${this.name}: closing the session of conversation ${live.sessionId} after ${formatDuration(ttl)} idle; its next message restores it`);
    void this.closeSession(live.sessionId);
  }

  #log(level: keyof RuntimeLogger, message: string): void {
    try {
      this.#options.logger?.[level](message);
    } catch {
      // Logging never breaks a session.
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

  /** Agent → client requests; `live` is undefined for a session no conversation has taken over yet. */
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
    const asked = this.#preset.approvals === "pi" ? piApprovalRequest(params, (id) => live.projector.hasToolCall(id)) : params;
    const { request, outcome } = live.projector.requestPermission(asked);
    const cancelled = new Promise<AcpRequestPermissionResult>((resolve) => live.permissions.set(request.request_id, resolve));
    this.#holdIdle(live);
    this.#push({ event_type: "approval", session_id: live.sessionId, title: this.#title(live.sessionId), body: request.title.slice(0, 512) });
    try {
      return await Promise.race([outcome, cancelled]);
    } finally {
      live.permissions.delete(request.request_id);
      this.#settle(live);
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

/** Whether the agent said or did anything in this conversation yet: whether it had a context to lose. */
function hasAgentOutput(store: SessionStore, sessionId: string): boolean {
  return store.listMessages(sessionId, { limit: 500 }).messages.some((message) => message.role === "assistant");
}

// ── AcpRuntimeHost: the runtimes of this device ─────────────────────────────────────────────────────────────────

export interface AcpRuntimeHostOptions extends Omit<AcpRuntimeOptions, "agentPath" | "resolveCommand"> {
  presets?: AcpRuntimePreset[];
  /** Add the Connector's own agents (`builtin` in `agents()`) for ids not given in `presets`. Default true. */
  includeDefaultPresets?: boolean;
  /**
   * The Connector's own agents, when the embedding app ships them: they count as installed. Default: the agents of the
   * catalog, installed on this device or not.
   */
  defaultPresets?: AcpRuntimePreset[];
  /** The agents Agents Anywhere knows (default `AGENT_CATALOG`; not used with `defaultPresets`). */
  catalog?: readonly CatalogAgent[];
  /** Looks for programs on this device. */
  finder?: AgentFinder;
  /** How long an agent's install may take. Default 30 min. */
  installTimeoutMs?: number;
  /** The agents that can be used here changed (one was installed, or is gone). */
  onAgentsChanged?: () => void;
  /** The agents the user added on this device (`custom-agents.json`). */
  customAgents?: readonly CustomAgent[];
  /** Persist them after `addAgent`, `updateAgent` or `removeAgent` changed one (all of them); a rejection refuses the change. */
  onCustomAgentsChange?: (agents: CustomAgent[]) => void | Promise<void>;
  /** Each agent's switch and settings as saved on this device (`agents.json`), by agent id. */
  agentSettings?: AgentOverrides;
  /**
   * Persist every agent's settings after `updateAgent` changed them (the whole map). The change applies only once
   * this resolves; a rejection refuses it. The values of `env` are secrets: keep them on the device.
   */
  onAgentSettingsChange?: (settings: AgentOverrides) => void | Promise<void>;
  /** The settings each agent's newest conversation was created with, as saved on this device (`last-session-config.json`). */
  lastSessionConfig?: LastSessionConfig;
  /** Persist them after a conversation was created (the whole map). A failure is logged: the conversation is fine. */
  onLastSessionConfigChange?: (config: LastSessionConfig) => void | Promise<void>;
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
  /** Added by the user (`addAgent`): it can be renamed and removed. */
  custom?: true;
  enabled: boolean;
  /** What a process started now would run. */
  command: string;
  args: string[];
  /** Names of its extra environment variables; the values never leave the device. */
  envKeys: string[];
  /** The command, args or environment differ from the preset. */
  customized: boolean;
  /** Agent processes running now, ones still starting included: one, or two while its settings change. */
  running: number;
  /** Conversations (and prepared ones) open in them. */
  sessions: number;
  /** AA's approvals turned on (agents whose preset has `approvals`; absent for others). */
  approvals?: boolean;
  /** Agents that can be pointed at a model gateway, and the one they are pointed at (its key never leaves the device). */
  gateway?: { api: GatewayApi; modelRequired: boolean; baseUrl?: string; model?: string };
  /** Known ways to sign in to it. */
  signIn: SignInMethod[];
  /** Minutes a conversation's agent may sit idle before it is closed; 0: never. */
  idleCloseMinutes: number;
  /**
   * It can be started here: its own program is there, and what starts it (an agent the user added: its command; others
   * the catalog does not know: always).
   */
  installed: boolean;
  /** Its own program, where it was found (agents of the catalog). */
  program?: string;
  /** The program is the one the user named. */
  programSet?: boolean;
  /** Its own program is there, what starts it is not. */
  missing?: string;
  /** Agents of the catalog. */
  website?: string;
  /** How it can be installed on this device (agents of the catalog). */
  install?: AgentInstallInfo;
}

export interface AgentInstallInfo {
  /** The preferred one first; `available`: what its command needs is there. */
  methods: { id: string; command: string; available: boolean; needs?: string }[];
  /** The newest install since the Connector started. */
  job?: InstallJob;
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
  /** The newest conversation's settings being applied to it (one pass at a time). */
  applying: Promise<void> | undefined;
  expiresAt: number;
  timer: NodeJS.Timeout | undefined;
}

/** Runtimes by id, and session-level operations routed to the runtime the session was created with. */
export class AcpRuntimeHost {
  readonly store: SessionStore;
  readonly #options: AcpRuntimeHostOptions & Pick<AcpRuntimeOptions, "agentPath" | "resolveCommand">;
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
  readonly #finder: AgentFinder;
  readonly #installer: AgentInstaller;
  /** The catalog agents registered here. */
  readonly #catalog = new Map<string, CatalogAgent>();
  /** The agents the user added. */
  readonly #custom = new Map<string, CustomAgent>();
  /** What was found of each of them, and of the catalog's. */
  readonly #found = new Map<string, FoundAgent>();
  #lastScan = 0;
  /** Every agent's saved changes, ids not registered here included (kept as they are). */
  #overrides = new Map<string, AgentOverride>();
  /** The settings each agent's newest conversation was created with, by agent id. */
  #lastSessionConfig = new Map<string, Record<string, string>>();
  /** `updateAgent` calls run one at a time, so none is lost. */
  #agentUpdates: Promise<unknown> = Promise.resolve();
  onPushEvent: ((event: PushEvent) => void) | undefined;

  constructor(options: AcpRuntimeHostOptions) {
    this.store = options.store;
    this.onPushEvent = options.onPushEvent;
    const catalog = (options.includeDefaultPresets ?? true) && options.defaultPresets === undefined ? (options.catalog ?? AGENT_CATALOG) : [];
    const finder = options.finder ?? new AgentFinder({ folders: agentFolders(catalog) });
    this.#finder = finder;
    this.#installer = new AgentInstaller({
      path: () => finder.path,
      ...(options.installTimeoutMs !== undefined ? { timeoutMs: options.installTimeoutMs } : {}),
      isInstalled: async (agentId) => {
        await this.refreshAgents();
        return this.#found.get(agentId)?.program !== undefined;
      },
    });
    this.#options = {
      ...options,
      onPushEvent: (event) => this.onPushEvent?.(event),
      agentPath: () => finder.path,
      resolveCommand: (command) => (/^~[\\/]/u.test(command) ? finder.userPath(command) : /[\\/]/u.test(command) ? undefined : finder.find([command])),
    };
    this.#preparedTtlMs = options.preparedTtlMs ?? DEFAULT_PREPARED_TTL_MS;
    this.#maxPrepared = Math.max(1, options.maxPrepared ?? DEFAULT_MAX_PREPARED);
    // An entry with nothing left once unknown keys are dropped (only a `name`, from an earlier Connector) is no change.
    const saved = Object.entries(AgentOverridesSchema.parse(options.agentSettings ?? {}));
    this.#overrides = new Map(saved.filter(([, override]) => Object.keys(override).length > 0));
    const last = LastSessionConfigSchema.safeParse(options.lastSessionConfig ?? {});
    if (last.success) this.#lastSessionConfig = new Map(Object.entries(last.data));
    else this.#options.logger?.warn(`ignoring the saved settings of the newest conversations: ${last.error.issues[0]?.message ?? "invalid"}`);
    for (const preset of options.presets ?? []) this.registerPreset(preset);
    if (options.includeDefaultPresets ?? true) {
      for (const preset of options.defaultPresets ?? []) {
        if (this.#runtimes.has(preset.id)) continue;
        this.registerPreset(preset);
        this.#builtin.add(preset.id);
      }
      for (const agent of catalog) {
        if (this.#runtimes.has(agent.id)) continue;
        const found = this.#look(agent);
        this.registerPreset(presetOf(agent, found.named));
        this.#builtin.add(agent.id);
        this.#catalog.set(agent.id, agent);
        this.#found.set(agent.id, found);
        this.#applySettings(agent.id);
      }
      this.#lastScan = Date.now();
    }
    for (const agent of CustomAgentsSchema.parse(options.customAgents ?? [])) {
      if (!this.#runtimes.has(agent.id)) this.#registerCustom(agent);
    }
  }

  #registerCustom(agent: CustomAgent): void {
    this.registerPreset(agent);
    this.#custom.set(agent.id, agent);
    this.#found.set(agent.id, this.#lookCustom(agent));
  }

  registerPreset(preset: AcpRuntimePreset): AcpRuntime {
    const runtime = new AcpRuntime(preset, {
      ...this.#options,
      programSignIn: () => this.#programSignIn(preset.id),
      onSignInChange: (methodId) => void this.#saveSignIn(preset.id, methodId),
    });
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
    this.#catalog.delete(runtime.id);
    this.#custom.delete(runtime.id);
    this.#found.delete(runtime.id);
    this.#applySettings(runtime.id);
  }

  /** Run an agent with its preset and this device's settings of now. */
  #applySettings(agentId: string): void {
    const runtime = this.#runtimes.get(agentId);
    const preset = this.#presets.get(agentId);
    if (runtime === undefined || preset === undefined) return;
    const override = this.#overrides.get(agentId);
    runtime.configure?.(this.#launchOf(agentId));
    runtime.configureApprovals?.(preset.approvals !== undefined && override?.approvals === true);
    runtime.configureIdle?.(idleMs(override));
    runtime.configureSignIn?.(override?.sign_in);
  }

  /** What a process of the agent is started with now: its preset with this device's changes, and what only the device adds. */
  #launchOf(agentId: string): AgentLaunch {
    const preset = this.#presets.get(agentId) as AcpRuntimePreset;
    const override = this.#overrides.get(agentId);
    const launch = effectivePreset(preset, override);
    const agent = this.#catalog.get(agentId);
    const added = agent === undefined ? {} : programEnv(agent, this.#found.get(agentId)?.named);
    return {
      ...launch,
      ...(Object.keys(added).length > 0 ? { env: { ...added, ...(launch.env ?? {}) } } : {}),
      ...(agent?.gateway !== undefined && override?.gateway !== undefined ? { gateway: agent.gateway.launch(override.gateway) } : {}),
    };
  }

  // ── Installed agents ──

  /** What is there of a catalog agent: the program the user named, else the first one found. */
  #look(agent: CatalogAgent): FoundAgent {
    const override = this.#overrides.get(agent.id);
    const named = override?.program !== undefined && this.#finder.isProgram(override.program) ? override.program : undefined;
    const program = named ?? this.#finder.find(agent.programs);
    const launcher = launcherOf(agent);
    const missing = program !== undefined && launcher !== undefined && this.#finder.find([launcher]) === undefined ? launcher : undefined;
    // A command of the user's own needs neither.
    const custom = override?.command !== undefined && this.#finder.resolve(override.command) !== undefined;
    return { program, named, missing, installed: custom || (program !== undefined && missing === undefined) };
  }

  /** Whether the command of an agent the user added is there. */
  #lookCustom(agent: CustomAgent): FoundAgent {
    return { program: undefined, named: undefined, missing: undefined, installed: this.#finder.resolve(agent.command) !== undefined };
  }

  /**
   * Look again what is installed, in the folders known by now (nothing when that was done less than `maxAgeMs` ago);
   * tells `onAgentsChanged` when the usable agents changed.
   */
  rescanAgents(maxAgeMs = 0): void {
    if (this.#catalog.size + this.#custom.size === 0 || Date.now() - this.#lastScan < maxAgeMs) return;
    this.#lastScan = Date.now();
    const before = JSON.stringify(this.list());
    this.#finder.rescan();
    for (const agent of this.#catalog.values()) {
      const was = this.#found.get(agent.id);
      const now = this.#look(agent);
      this.#found.set(agent.id, now);
      if (was?.named === now.named) continue;
      this.#presets.set(agent.id, presetOf(agent, now.named));
      this.#applySettings(agent.id);
    }
    for (const agent of this.#custom.values()) this.#found.set(agent.id, this.#lookCustom(agent));
    if (JSON.stringify(this.list()) !== before) this.#options.onAgentsChanged?.();
  }

  /** `rescanAgents` with the PATH of a login shell read again (slow: the shell's profile runs). */
  async refreshAgents(): Promise<void> {
    if (this.#catalog.size + this.#custom.size > 0) await this.#finder.refresh();
    this.rescanAgents();
  }

  /** Whether the agent can be started here (ids not registered: no). */
  isInstalled(agentId: string): boolean {
    if (!this.#runtimes.has(agentId)) return false;
    return this.#found.get(agentId)?.installed ?? true;
  }

  /** Start installing an agent of the catalog with one of its methods; `agents()` reports how it goes. */
  installAgent(agentId: string, methodId: string): AgentInfo {
    const runtime = this.runtime(agentId);
    const agent = this.#catalog.get(agentId);
    const method = agent === undefined ? undefined : installMethods(agent, devicePlatform()).find((m) => m.id === methodId);
    if (method === undefined) {
      throw new InvalidArgumentError(`${runtime.name} cannot be installed this way on this device`, { details: { reason: "unknown_install_method", agent: agentId } });
    }
    if (method.needs !== undefined && this.#finder.find([method.needs]) === undefined) {
      throw new MeshCallError("failed_precondition", `this needs ${method.needs}, which is not installed on this device`, {
        details: { reason: "install_needs_program", agent: agentId, program: method.needs },
      });
    }
    this.#installer.start(agentId, method.id, method.command);
    return this.#info(runtime);
  }

  async cancelInstall(agentId: string): Promise<AgentInfo> {
    const runtime = this.runtime(agentId);
    await this.#installer.cancel(agentId);
    return this.#info(runtime);
  }

  /**
   * Sign in to an agent with one of the ways `agent_auth_required` lists (ACP `authenticate`). Resolves once signed in,
   * which may take until someone did it in the device's browser; asking again joins.
   */
  async signIn(agentId: string, methodId: string): Promise<void> {
    const runtime = this.runtime(agentId);
    this.assertEnabled(agentId);
    if (runtime.signIn === undefined) throw new InvalidArgumentError(`${runtime.name} cannot be signed in to here`, { details: { reason: "unknown_sign_in_method", agent: agentId } });
    await runtime.signIn(methodId);
  }

  cancelSignIn(agentId: string): void {
    this.runtime(agentId).cancelSignIn?.();
  }

  /** What to run in a terminal to sign in to an agent this way. */
  signInCommand(agentId: string, methodId: string): SignInCommand {
    const runtime = this.runtime(agentId);
    this.assertEnabled(agentId);
    if (runtime.signInCommand === undefined) throw new InvalidArgumentError(`${runtime.name} cannot be signed in to here`, { details: { reason: "unknown_sign_in_method", agent: agentId } });
    return runtime.signInCommand(methodId);
  }

  #saveSignIn(agentId: string, methodId: string | undefined): Promise<void> {
    return this.#inTurn(async () => {
      const { sign_in: _before, ...others } = this.#overrides.get(agentId) ?? {};
      const override: AgentOverride = methodId === undefined ? others : { ...others, sign_in: methodId };
      const next = new Map(this.#overrides);
      if (Object.keys(override).length > 0) next.set(agentId, override);
      else next.delete(agentId);
      await this.#options.onAgentSettingsChange?.(Object.fromEntries(next));
      this.#overrides = next;
    }).catch((error: unknown) => this.#options.logger?.warn(`could not save how ${agentId} was signed in to: ${errorMessage(error)}`));
  }

  #programSignIn(agentId: string): { command: string; args: string[] } | undefined {
    const login = this.#catalog.get(agentId)?.login;
    const program = this.#found.get(agentId)?.program;
    return login === undefined || program === undefined ? undefined : { command: program, args: [...login] };
  }

  /** The agents that can be used here (`status.runtimes`): every registered one that is installed and not turned off. */
  list(): { id: string; name: string }[] {
    return [...this.#runtimes.values()].filter((r) => !this.isDisabled(r.id) && this.isInstalled(r.id)).map((r) => ({ id: r.id, name: r.name }));
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

  /**
   * Throws `failed_precondition` when the agent cannot be used here: `agent_disabled` (turned off) or
   * `agent_not_installed`; `invalid_argument` / `unknown_agent` when it is not there any more. It starts no process and
   * takes no turn then.
   */
  assertEnabled(agentId: string): void {
    const { name } = this.runtime(agentId);
    if (this.isDisabled(agentId)) {
      throw new MeshCallError("failed_precondition", `${name} is turned off on this device`, { details: { reason: "agent_disabled", agent: agentId } });
    }
    if (!this.isInstalled(agentId)) {
      const missing = this.#found.get(agentId)?.missing;
      const why = missing === undefined ? "is not installed on this device" : `needs ${missing}, which is not installed on this device`;
      throw new MeshCallError("failed_precondition", `${name} ${why}`, { details: { reason: "agent_not_installed", agent: agentId } });
    }
  }

  /** Every registered agent, turned off and not installed ones included, in the order of `list()`. */
  agents(): AgentInfo[] {
    return [...this.#runtimes.values()].map((runtime) => this.#info(runtime));
  }

  /** One agent; `invalid_argument` / `unknown_agent` when it is not registered here. */
  agent(agentId: string): AgentInfo {
    return this.#info(this.runtime(agentId));
  }

  /**
   * Turn an agent on or off (on: only an installed one), say where its program is, or change its command, args or extra
   * environment variables (see `AgentUpdate`); its name stays the preset's, unless the user added it. Saved through
   * `onAgentSettingsChange` (`onCustomAgentsChange`) before anything changes, then applied: idle conversations move to a
   * process with the new settings, busy ones once what they do has ended (`AgentRuntime.configure`), and prepared ones
   * (also when the agent was turned off) are closed so the next `prepare` opens them anew.
   */
  updateAgent(agentId: string, update: AgentUpdate): Promise<AgentInfo> {
    const run = async (): Promise<AgentInfo> => {
      const runtime = this.runtime(agentId);
      const parsed = AgentUpdateSchema.safeParse(update);
      if (!parsed.success) throw invalidAgentSettings(parsed.error);
      const before = this.#overrides.get(agentId) ?? {};
      const agent = this.#catalog.get(agentId);
      const program = this.#checkProgram(runtime, agent, parsed.data.program ?? undefined);
      const gateway = this.#checkGateway(runtime, agent, before.gateway, parsed.data.gateway ?? undefined);
      // One the user added is changed itself: there is nothing it could differ from.
      const addedBefore = this.#custom.get(agentId);
      const added = addedBefore === undefined ? undefined : this.#changeCustom(addedBefore, parsed.data);
      // A program of its own changes what the agent starts with before anything else does.
      const preset: AcpRuntimePreset | undefined = added ?? (agent !== undefined && program !== undefined ? presetOf(agent, program || undefined) : this.#presets.get(agentId));
      const after = applyAgentUpdate(preset ?? bareSettings(runtime), before, {
        ...parsed.data,
        ...(program !== undefined ? { program } : {}),
        ...(added !== undefined ? { command: null, args: null, env: null } : {}),
      });
      if (gateway !== undefined) after.gateway = gateway;
      else if (parsed.data.gateway != null) delete after.gateway;
      const checked = AgentOverrideSchema.safeParse(after);
      if (!checked.success) throw invalidAgentSettings(checked.error);
      // On only when installed; naming its program in the same change counts.
      if (parsed.data.enabled === true && !program) this.#assertInstalled(agentId);
      if (preset === undefined && hasLaunchSettings(after)) {
        throw new MeshCallError("failed_precondition", `${runtime.name} has no settings to change, only its switch`, {
          details: { reason: "agent_not_configurable", agent: agentId },
        });
      }
      const approvalsBefore = before.approvals === true;
      const approvalsAfter = after.approvals === true;
      if (approvalsAfter && preset?.approvals === undefined) {
        throw new MeshCallError("failed_precondition", `${runtime.name} has no approvals Agents Anywhere can add`, {
          details: { reason: "approvals_unsupported", agent: agentId },
        });
      }
      // The extension is installed (or removed) before the change is saved: a failure refuses it.
      if (approvalsAfter !== approvalsBefore) {
        try {
          if (approvalsAfter) await installPiApprovals(this.#options.piExtensionsDir);
          else await uninstallPiApprovals(this.#options.piExtensionsDir);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          throw new MeshCallError("failed_precondition", `could not ${approvalsAfter ? "install" : "remove"} the approvals extension: ${why}`, {
            details: { reason: "approvals_extension_failed", agent: agentId },
          });
        }
      }

      const next = new Map(this.#overrides);
      if (Object.keys(after).length > 0) next.set(agentId, after);
      else next.delete(agentId);
      const launchBefore = preset !== undefined ? this.#launchOf(agentId) : undefined;
      if (added !== undefined && JSON.stringify(added) !== JSON.stringify(addedBefore)) {
        await this.#options.onCustomAgentsChange?.([...this.#custom.values()].map((each) => (each.id === agentId ? added : each)));
        this.#custom.set(agentId, added);
      }
      await this.#options.onAgentSettingsChange?.(Object.fromEntries(next));
      this.#overrides = next;

      let relaunch = false;
      if (preset !== undefined && launchBefore !== undefined) {
        if (agent !== undefined) this.#found.set(agentId, this.#look(agent));
        if (added !== undefined) this.#found.set(agentId, this.#lookCustom(added));
        this.#presets.set(agentId, copyPreset(preset));
        relaunch = !sameLaunch(launchBefore, this.#launchOf(agentId));
      }
      this.#applySettings(agentId);
      // A prepared session has the old command, args or environment (or approvals), or its agent is off now: the next
      // `prepare` opens a new one.
      const turnedOff = before.enabled !== false && after.enabled === false;
      if (relaunch || turnedOff || approvalsAfter !== approvalsBefore) await this.#dropPreparedOf(agentId);
      if (JSON.stringify(before.gateway) !== JSON.stringify(after.gateway)) await this.#forgetModel(agentId);
      return this.#info(runtime);
    };
    return this.#inTurn(run);
  }

  /** Changes to agents run one at a time, so none is lost. */
  #inTurn<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#agentUpdates.then(run, run);
    this.#agentUpdates = result.catch(() => undefined);
    return result;
  }

  // ── Agents the user added (`add_agent`, `remove_agent`) ──

  /** Add an agent: a command that speaks ACP and is there. Saved through `onCustomAgentsChange` first. */
  addAgent(input: NewAgent): Promise<AgentInfo> {
    return this.#inTurn(async () => {
      const parsed = NewAgentSchema.safeParse(input);
      if (!parsed.success) throw invalidAgentSettings(parsed.error);
      const { name, command, args, env } = parsed.data;
      if (this.#custom.size >= MAX_CUSTOM_AGENTS) {
        throw new MeshCallError("resource_exhausted", `at most ${MAX_CUSTOM_AGENTS} agents can be added`, { details: { reason: "too_many_agents" } });
      }
      this.#assertNameFree(name);
      this.#assertCommand(command);
      const agent: CustomAgent = {
        id: this.#newCustomId(name),
        name,
        command,
        args: [...(args ?? [])],
        ...(env != null && Object.keys(env).length > 0 ? { env: { ...env } } : {}),
      };
      await this.#options.onCustomAgentsChange?.([...this.#custom.values(), agent]);
      this.#registerCustom(agent);
      return this.#info(this.runtime(agent.id));
    });
  }

  /**
   * Forget an agent the user added, its settings included, and stop its processes (see `stopAgent`). Its conversations
   * stay, but cannot be continued.
   */
  removeAgent(agentId: string): Promise<void> {
    return this.#inTurn(async () => {
      const runtime = this.runtime(agentId);
      this.assertCustom(agentId);
      await this.#options.onCustomAgentsChange?.([...this.#custom.values()].filter((agent) => agent.id !== agentId));
      this.#custom.delete(agentId);
      this.#runtimes.delete(agentId);
      this.#presets.delete(agentId);
      this.#found.delete(agentId);
      if (this.#overrides.has(agentId)) {
        this.#overrides = new Map([...this.#overrides].filter(([id]) => id !== agentId));
        await this.#options.onAgentSettingsChange?.(Object.fromEntries(this.#overrides));
      }
      if (this.#lastSessionConfig.delete(agentId)) await this.#saveLastSessionConfig(agentId);
      await Promise.all([this.#dropPreparedOf(agentId), runtime.stop ? runtime.stop() : runtime.dispose()]);
    });
  }

  /** `failed_precondition` / `agent_not_custom` for an agent the user did not add. */
  assertCustom(agentId: string): void {
    const runtime = this.runtime(agentId);
    if (this.#custom.has(agentId)) return;
    throw new MeshCallError("failed_precondition", `${runtime.name} was not added by you: it can be turned off instead`, {
      details: { reason: "agent_not_custom", agent: agentId },
    });
  }

  /** `agent` with `update` applied. */
  #changeCustom(agent: CustomAgent, update: AgentUpdate): CustomAgent {
    const name = update.name ?? agent.name;
    const command = update.command ?? agent.command;
    if (name.toLowerCase() !== agent.name.toLowerCase()) this.#assertNameFree(name);
    if (command !== agent.command) this.#assertCommand(command);
    const env: Record<string, string> = { ...(agent.env ?? {}) };
    for (const [key, value] of Object.entries(update.env ?? {})) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const next: CustomAgent = { id: agent.id, name, command, args: [...(update.args ?? agent.args)], ...(Object.keys(env).length > 0 ? { env } : {}) };
    const checked = CustomAgentsSchema.safeParse([next]);
    if (!checked.success) throw invalidAgentSettings(checked.error);
    return next;
  }

  #assertNameFree(name: string): void {
    const taken = [...this.#runtimes.values()].find((runtime) => runtime.name.toLowerCase() === name.toLowerCase());
    if (taken === undefined) return;
    throw new InvalidArgumentError(`there is already an agent called ${taken.name}`, { details: { reason: "agent_name_taken", agent: taken.id } });
  }

  #assertCommand(command: string): void {
    if (this.#finder.resolve(command) !== undefined) return;
    throw new InvalidArgumentError(`${command} was not found on this device`, { details: { reason: "command_not_found", command } });
  }

  #newCustomId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "") || "agent";
    for (let n = 1; ; n++) {
      const id = `${CUSTOM_AGENT_ID_PREFIX}${slug}${n === 1 ? "" : `-${n}`}`;
      if (!this.#runtimes.has(id)) return id;
    }
  }

  /** A program the user named (`""`: none any more), checked; `undefined`: not part of the change. */
  #checkProgram(runtime: AgentRuntime, agent: CatalogAgent | undefined, program: string | undefined): string | undefined {
    if (program === undefined) return undefined;
    if (agent === undefined) {
      throw new MeshCallError("failed_precondition", `${runtime.name} has no program to look for`, { details: { reason: "agent_not_configurable", agent: runtime.id } });
    }
    if (program === "") return "";
    const file = this.#finder.userPath(program);
    if (!path.isAbsolute(file)) {
      throw new InvalidArgumentError("the path must be absolute", { details: { reason: "program_path_relative", agent: runtime.id } });
    }
    const found = this.#finder.resolve(file);
    if (found === undefined) {
      throw new InvalidArgumentError(`there is no program at ${file}`, { details: { reason: "program_not_found", agent: runtime.id } });
    }
    return found;
  }

  /** The gateway after `change` (`undefined`: none, or not part of the change), checked. */
  #checkGateway(
    runtime: AgentRuntime,
    agent: CatalogAgent | undefined,
    current: ModelGateway | undefined,
    change: NonNullable<AgentUpdate["gateway"]> | undefined,
  ): ModelGateway | undefined {
    if (change === undefined) return undefined;
    const details = (reason: string) => ({ details: { reason, agent: runtime.id } });
    if (agent?.gateway === undefined) {
      throw new MeshCallError("failed_precondition", `${runtime.name} cannot be pointed at a model gateway`, details("gateway_unsupported"));
    }
    const baseUrl = change.base_url ?? current?.base_url ?? "";
    if (baseUrl === "") return undefined;
    // A key is never sent to a host it was not entered for.
    const keyStays = current !== undefined && new URL(current.base_url).origin === new URL(baseUrl).origin;
    const apiKey = change.api_key ?? (keyStays ? current.api_key : "");
    if (apiKey === "") throw new InvalidArgumentError("the gateway needs an API key", details("gateway_key_required"));
    const model = change.model ?? current?.model ?? "";
    if (model === "" && agent.gateway.modelRequired) {
      throw new InvalidArgumentError(`${runtime.name} needs to know the gateway's model`, details("gateway_model_required"));
    }
    return { base_url: baseUrl, api_key: apiKey, ...(model !== "" ? { model } : {}) };
  }

  #assertInstalled(agentId: string): void {
    const agent = this.#catalog.get(agentId);
    if (agent !== undefined) this.#found.set(agentId, this.#look(agent));
    if (this.isInstalled(agentId)) return;
    const name = this.#runtimes.get(agentId)?.name ?? agentId;
    throw new MeshCallError("failed_precondition", `${name} is not installed on this device`, { details: { reason: "agent_not_installed", agent: agentId } });
  }

  /**
   * Stop every process of `agentId`, ones still starting included. Conversations stay and start the agent again on
   * their next message, with the settings of that moment, reopening their earlier ACP sessions where the agent can.
   * Resolves with how many processes were stopped. Turns still running are not waited for (`SessionsService.stopAgent`
   * cancels them first).
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
    const agent = this.#catalog.get(runtime.id);
    const found = this.#found.get(runtime.id);
    const job = this.#installer.job(runtime.id);
    return {
      id: runtime.id,
      name: runtime.name,
      builtin: this.#builtin.has(runtime.id),
      ...(this.#custom.has(runtime.id) ? { custom: true as const } : {}),
      enabled: override.enabled !== false,
      command: effective.command,
      args: effective.args,
      envKeys: Object.keys(effective.env ?? {}),
      customized: preset !== undefined && !sameLaunch(effective, preset),
      running: this.#processCount(runtime),
      sessions: runtime.sessionCount?.() ?? this.#processCount(runtime),
      signIn: runtime.signInMethods ?? [],
      ...(preset?.approvals !== undefined ? { approvals: override.approvals === true } : {}),
      ...(agent?.gateway !== undefined
        ? {
            gateway: {
              api: agent.gateway.api,
              modelRequired: agent.gateway.modelRequired,
              ...(override.gateway !== undefined ? { baseUrl: override.gateway.base_url } : {}),
              ...(override.gateway?.model !== undefined ? { model: override.gateway.model } : {}),
            },
          }
        : {}),
      idleCloseMinutes: override.idle_close_minutes ?? idleMinutes(this.#options.idleTtlMs),
      installed: this.isInstalled(runtime.id),
      ...(found?.program !== undefined ? { program: found.program } : {}),
      ...(found?.named !== undefined ? { programSet: true } : {}),
      ...(found?.missing !== undefined ? { missing: found.missing } : {}),
      ...(agent !== undefined
        ? {
            website: agent.website,
            install: {
              methods: installMethods(agent, devicePlatform()).map(({ id, command, needs }) => ({
                id,
                command,
                available: needs === undefined || this.#finder.find([needs]) !== undefined,
                ...(needs !== undefined ? { needs } : {}),
              })),
              ...(job !== undefined ? { job } : {}),
            },
          }
        : {}),
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
   * Start the session's agent if it is not running (create, or the first prompt after a restart, a stop or an idle
   * close; the agent reopens its earlier session where it can). `preparedId`: take that prepared agent over when it
   * was prepared for this session's agent and folder and still runs; any other id is ignored and the agent starts as
   * usual.
   *
   * The conversation's settings are AA's: whatever the agent reports once it runs (its defaults in a new session, or
   * what a reopened one had), every setting the conversation had before this start, or got while it started, is set
   * back where the agent reports another value it offers. A value the agent no longer offers, or refuses, is dropped.
   */
  async ensureSession(sessionId: string, options: { preparedId?: string | undefined } = {}): Promise<void> {
    const session = this.store.get(sessionId);
    if (session === undefined) throw new MeshCallError("not_found", `no session ${sessionId}`, { details: { reason: "session_not_found" } });
    const runtime = this.runtime(session.agent);
    if (runtime.hasSession(sessionId)) return;
    this.assertEnabled(session.agent);
    const prepared = options.preparedId ? this.#takePrepared(options.preparedId, session.agent, session.cwd) : undefined;
    const wanted = new Map(session.config.map((option) => [option.id, option.current]));
    // Held until its settings are back: a close in between would lose them.
    const started = await runtime.startSession({ sessionId, cwd: session.cwd, hold: true, ...(prepared ? { prepared } : {}) });
    try {
      // Chosen while it was not running (`setConfig` keeps them until it runs): the latest choice.
      for (const [configId, value] of this.#pendingConfig.get(sessionId) ?? []) wanted.set(configId, value);
      this.#pendingConfig.delete(sessionId);
      for (const [configId, value] of wanted) {
        // Read again each time: one setting (the model) can change the others' choices.
        const option = this.store.get(sessionId)?.config.find((o) => o.id === configId);
        if (option === undefined || option.current === value || !option.options.some((o) => o.value === value)) continue;
        try {
          await runtime.setConfig(sessionId, configId, value);
        } catch {
          // Refused: the agent's value stays (and is what the conversation shows).
        }
      }
    } finally {
      started.release?.();
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
    // Shown with the settings the agent's newest conversation was created with, as the conversation will start.
    await this.#applyLastSessionConfig(entry, ready);
    this.#touchPrepared(entry);
    return { id: entry.id, agent: entry.agent, cwd: entry.cwd, config: ready.config, expiresAt: entry.expiresAt };
  }

  /** The settings `agentId`'s newest conversation on this device was created with (none yet: empty). */
  lastSessionConfig(agentId: string): Record<string, string> {
    return { ...this.#lastSessionConfig.get(agentId) };
  }

  /**
   * Remember the settings `sessionId` has now as its agent's newest (call once a conversation was created with its
   * settings applied): the next conversation with that agent starts with them.
   */
  async rememberSessionConfig(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (session === undefined || session.config.length === 0) return;
    this.#lastSessionConfig.set(session.agent, Object.fromEntries(session.config.map((option) => [option.id, option.current])));
    await this.#saveLastSessionConfig(session.agent);
  }

  /** The next conversation starts with the agent's own choice of model again (another gateway has other models). */
  async #forgetModel(agentId: string): Promise<void> {
    const config = this.#lastSessionConfig.get(agentId);
    if (config === undefined || !Object.keys(config).some(isModelSetting)) return;
    this.#lastSessionConfig.set(agentId, Object.fromEntries(Object.entries(config).filter(([id]) => !isModelSetting(id))));
    await this.#saveLastSessionConfig(agentId);
  }

  async #saveLastSessionConfig(agentId: string): Promise<void> {
    try {
      await this.#options.onLastSessionConfigChange?.(Object.fromEntries(this.#lastSessionConfig));
    } catch (error) {
      this.#options.logger?.warn(`could not save the settings of the newest ${agentId} conversation: ${String(error)}`);
    }
  }

  /** Set the prepared agent to the agent's newest settings where it still offers them (one pass at a time per agent). */
  #applyLastSessionConfig(entry: PreparedEntry, ready: PreparedAgent): Promise<void> {
    const apply = async (): Promise<void> => {
      const wanted = this.#lastSessionConfig.get(entry.agent);
      if (wanted === undefined || ready.setConfig === undefined) return;
      for (const [configId, value] of Object.entries(wanted)) {
        // Read again each time: one setting (the model) can change the others' choices.
        const option = ready.config.find((o) => o.id === configId);
        if (option === undefined || option.current === value || !option.options.some((o) => o.value === value)) continue;
        if (!ready.usable) return;
        try {
          await ready.setConfig(configId, value);
        } catch {
          // Refused: the agent's value stays (and is what the new conversation shows).
        }
      }
    };
    const pass = (entry.applying ?? Promise.resolve()).then(apply, apply);
    entry.applying = pass;
    return pass;
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
    const entry: PreparedEntry = { id: globalThis.crypto.randomUUID(), agent, cwd, key, starting: undefined, ready: undefined, applying: undefined, expiresAt: 0, timer: undefined };
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
    for (let attempt = 1; ; attempt++) {
      await this.ensureSession(sessionId);
      const runtime = this.runtimeFor(sessionId);
      // Closed in that moment (its settings changed, an idle close): opened once more.
      if (runtime.hasSession(sessionId) || attempt === 3) return runtime.sendPrompt(sessionId, { turnId, prompt });
    }
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

  /** Close every session's agent and every prepared agent, and stop installs (the Connector stops). Later calls start agents again. */
  async dispose(): Promise<void> {
    const prepared = [...this.#prepared.values()];
    await Promise.all([this.#installer.stop(), ...prepared.map((entry) => this.#dropPrepared(entry)), ...[...this.#runtimes.values()].map((r) => r.dispose())]);
  }
}

/** What was found of a catalog agent. */
interface FoundAgent {
  /** Its own program. */
  program: string | undefined;
  /** The same, when it is the one the user named. */
  named: string | undefined;
  /** What starts it is not there. */
  missing: string | undefined;
  installed: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof AcpRequestError && error.code === JsonRpcErrorCode.AUTH_REQUIRED;
}

/** Why a process that has exited cannot be used, with what it said last. */
function exitedError(conn: AcpConnection): UnavailableError {
  const said = conn.stderrTail.trim().slice(-500);
  return new UnavailableError(`the agent exited${said ? `: ${said}` : ""}`);
}

/** `15 min`, `30 s`, `400 ms`. */
function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${ms} ms`;
}

// ── Agent settings ──────────────────────────────────────────────────────────────────────────────────────────────

function copyPreset(preset: AgentLaunch): AgentLaunch {
  return {
    id: preset.id,
    name: preset.name,
    command: preset.command,
    args: [...(preset.args ?? [])],
    ...(preset.env ? { env: { ...preset.env } } : {}),
    ...(preset.approvals ? { approvals: preset.approvals } : {}),
    ...(preset.own_process ? { own_process: true } : {}),
    ...(preset.gateway ? { gateway: structuredClone(preset.gateway) } : {}),
  };
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
    ...(preset.approvals ? { approvals: preset.approvals } : {}),
    ...(preset.own_process ? { own_process: true } : {}),
  };
}

/**
 * `current` with `update` applied, keeping only what differs from the preset (an agent set back to its preset's
 * values is not customized, and follows the preset when a later Connector changes it). `reset` starts again from
 * the preset, except for the switch.
 */
function applyAgentUpdate(preset: AcpRuntimePreset, current: AgentOverride, update: AgentUpdate): AgentOverride {
  const next: AgentOverride = update.reset
    ? {
        ...(current.enabled === false ? { enabled: false } : {}),
        ...(current.approvals === true ? { approvals: true } : {}),
        ...(current.idle_close_minutes !== undefined ? { idle_close_minutes: current.idle_close_minutes } : {}),
        ...(current.program !== undefined ? { program: current.program } : {}),
        ...(current.gateway !== undefined ? { gateway: current.gateway } : {}),
      }
    : { ...current };
  if (update.enabled != null) next.enabled = update.enabled;
  if (update.approvals != null) next.approvals = update.approvals;
  if (update.idle_close_minutes != null) next.idle_close_minutes = update.idle_close_minutes;
  if (update.program != null) next.program = update.program;
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
  if (next.approvals === true) kept.approvals = true;
  if (next.idle_close_minutes !== undefined && next.idle_close_minutes > 0) kept.idle_close_minutes = next.idle_close_minutes;
  if (next.program !== undefined && next.program.length > 0) kept.program = next.program;
  if (next.gateway !== undefined) kept.gateway = { ...next.gateway };
  if (next.command !== undefined && next.command !== preset.command) kept.command = next.command;
  if (next.args !== undefined && !sameArgs(next.args, preset.args ?? [])) kept.args = next.args;
  if (next.env !== undefined && !sameEnv(next.env, preset.env ?? {})) kept.env = next.env;
  return kept;
}

/** An agent's own idle close in ms (0: never), or `undefined` when it has none. */
function idleMs(override: AgentOverride | undefined): number | undefined {
  return override?.idle_close_minutes !== undefined ? override.idle_close_minutes * 60_000 : undefined;
}

/** The host's idle close in whole minutes, as an agent without its own shows it (0: never). */
function idleMinutes(ttlMs: number | null | undefined): number {
  return ttlMs !== undefined && ttlMs !== null && ttlMs > 0 ? Math.max(1, Math.round(ttlMs / 60_000)) : 0;
}

/** The id of a setting that picks the model. */
function isModelSetting(configId: string): boolean {
  return /model/iu.test(configId);
}

function hasLaunchSettings(override: AgentOverride): boolean {
  return override.command !== undefined || override.args !== undefined || override.env !== undefined;
}

/** Same command, args, environment and gateway: a process started with either is the same. */
function sameLaunch(a: AgentLaunch, b: AgentLaunch): boolean {
  return (
    a.command === b.command &&
    sameArgs(a.args ?? [], b.args ?? []) &&
    sameEnv(a.env ?? {}, b.env ?? {}) &&
    JSON.stringify(a.gateway ?? null) === JSON.stringify(b.gateway ?? null)
  );
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
