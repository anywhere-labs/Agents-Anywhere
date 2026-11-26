/**
 * Terminal sessions for the v3 Connector (`aa.v3.Terminals`). Design: docs/v3/terminal-proposal.md; wire shapes:
 * contracts/aa-v3/1.0/terminals.schema.json.
 *
 * Process: by default a real pseudo-terminal from the optional native dependency `@lydell/node-pty`
 * (`TERM=xterm-256color`, resize reaches the PTY), loaded lazily. When it cannot be loaded or started, shells are
 * spawned with `child_process.spawn` over pipes (`TERM=dumb`), or on Linux wrapped in util-linux `script(1)`; the
 * mode actually used is reported in `TerminalInfo.mode`.
 *
 * Screen: every terminal feeds all of its output into a headless xterm.js (`@xterm/headless`) and tracks the last
 * output seq the emulator has fully parsed. A new attach gets a serialized `snapshot` of the screen as of that seq,
 * then the buffered chunks after it, then live output: no gaps, no duplicates. Output chunks are numbered and the
 * last ~1 MiB is kept, so a reconnect with `resume_seq` inside that window only receives what it missed.
 *
 * Control: one controller per terminal; everyone else is a viewer. `claim` takes over immediately and bumps the
 * control generation; `input` / `resize` are honoured only from the controlling stream with the current
 * generation. When the controller's stream ends its control is kept for a grace period (default 10 s).
 *
 * Process hygiene: on POSIX each shell leads its own process group (pipes: `detached`; node-pty: the child is a
 * session leader), so closing a terminal signals the whole group plus a snapshot of all descendants (job-control
 * shells put background jobs in their own groups). On Windows the tree is killed with `taskkill /T /F`.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import serializeModule from "@xterm/addon-serialize";
import headlessModule from "@xterm/headless";

const { Terminal: HeadlessTerminal } = headlessModule;
const { SerializeAddon } = serializeModule;
type HeadlessTerminal = InstanceType<typeof HeadlessTerminal>;
type SerializeAddon = InstanceType<typeof SerializeAddon>;

// ---------------------------------------------------------------------------
// Public types (shapes follow contracts/aa-v3/1.0/terminals.schema.json)
// ---------------------------------------------------------------------------

export type TerminalMode = "pty" | "pipe" | "script";
export type TerminalOwner = "user" | "agent";
export type AttachMode = "view" | "control";
export type RejectReason = "not_controller" | "stale_generation" | "agent_owned";

export interface TerminalController {
  /** `e2e:<peer_key>` on encrypted calls, the tunnel principal on normal ones. Not a secret. */
  client_id: string;
  label: string;
  /** false while the controller's attach is gone but its grace period has not ended. */
  connected: boolean;
  since: string;
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  created_at: string;
  running: boolean;
  exit_code: number | null;
  exit_signal: string | null;
  exited_at: string | null;
  pid: number | null;
  mode: TerminalMode;
  owner: TerminalOwner;
  controller: TerminalController | null;
  generation: number;
  /** Live attach streams, controller included. */
  viewers: number;
}

export type TerminalEvent =
  | { type: "snapshot"; data: string; seq: number; cols: number; rows: number }
  | { type: "output"; data: string; seq: number }
  | { type: "control"; controller: TerminalController | null; generation: number; you: boolean; cols: number; rows: number }
  | { type: "rejected"; reason: RejectReason; generation: number }
  | { type: "exit"; exit_code: number | null; exit_signal: string | null };

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  /** Shell arguments. Default: `["-i"]` on POSIX, none on Windows. */
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /**
   * `pty` (default): real PTY via `@lydell/node-pty`, falling back to the manager's fallback mode when it is not
   * available. `pipe`: plain pipes, works everywhere. `script`: pty via util-linux script(1), Linux only.
   */
  mode?: TerminalMode;
  /** Reserved: `agent` terminals are read-only for every client. Default `user`. */
  owner?: TerminalOwner;
}

export interface AttachOptions {
  /** Who is attaching (matches a reconnect within the grace period). Default `local`. */
  clientId?: string;
  /** Display name. Default: the client id. */
  label?: string;
  /**
   * `control` takes control only when nobody holds it or the current controller (connected or in its grace
   * period) has this `clientId`; otherwise the stream joins as a viewer. Only `claim()` takes over unconditionally.
   * Default `view`.
   */
  mode?: AttachMode;
  /** With `mode: "control"`: the size to apply, only if control is actually taken. */
  cols?: number;
  rows?: number;
  /** Last seq the client rendered: if everything after it is buffered, the stream starts with those chunks. */
  resumeSeq?: number;
  signal?: AbortSignal;
}

export interface ClaimOptions {
  cols?: number;
  rows?: number;
  /** Keep the terminal's current size (cols / rows are ignored). */
  keepSize?: boolean;
}

/**
 * One attach stream: iterate it for frames; send input, resizes, claims and releases through it. Ends after the
 * `exit` frame, when `close()` is called, when its signal aborts, or when it falls too far behind.
 */
export interface TerminalAttachment extends AsyncIterableIterator<TerminalEvent> {
  readonly terminalId: string;
  readonly clientId: string;
  /** True once the stream has ended (no more frames will be queued). */
  readonly done: boolean;
  /** Write keystrokes. Resolves false when dropped (not the controller, stale generation, terminal gone). */
  input(data: Uint8Array | string, generation: number): Promise<boolean>;
  /** Resize the terminal. False when dropped. */
  resize(cols: number, rows: number, generation: number): boolean;
  /** Take control now. False when refused (agent-owned terminal, stream ended). */
  claim(options?: ClaimOptions): boolean;
  /** Give up control. False when this stream is not the controller. */
  release(): boolean;
  close(): void;
}

/** The parts of `@lydell/node-pty` the manager uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ): PtyProcess;
}

export interface TerminalManagerOptions {
  /** Output kept per terminal for `resume_seq` (whole chunks). Default 1 MiB. */
  replayBytes?: number;
  /** Lines of scrollback in the snapshot. Default 1000. */
  scrollback?: number;
  /** Max concurrently tracked terminals (running or exited). Default 32. */
  maxTerminals?: number;
  /** Grace period between SIGTERM/SIGHUP and SIGKILL. Default 2000 ms. */
  killGraceMs?: number;
  /** A subscriber whose unread backlog exceeds this is dropped (it may reattach). Default 4 MiB. */
  maxSubscriberBacklogBytes?: number;
  /** How long a disconnected controller keeps control. Default 10 000 ms. */
  controlGraceMs?: number;
  /** Loads node-pty; reject (or resolve undefined) to force the fallback. Default: dynamic `import("@lydell/node-pty")`. */
  loadPty?: () => Promise<PtyModule | undefined>;
  /** Mode used when no PTY is available. Default: `script` on Linux when util-linux script is installed, else `pipe`. */
  fallbackMode?: "pipe" | "script";
}

export class TerminalError extends Error {
  readonly code:
    | "terminal_not_found"
    | "terminal_not_running"
    | "terminal_limit_reached"
    | "terminal_manager_closed"
    | "not_controller"
    | "agent_owned"
    | "invalid_argument"
    | "spawn_failed";

  constructor(code: TerminalError["code"], message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "TerminalError";
    this.code = code;
  }
}

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_REPLAY_BYTES = 1024 * 1024;
const DEFAULT_SCROLLBACK = 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_CONTROL_GRACE_MS = 10_000;
const EXIT_DRAIN_MS = 250;
const NODE_PTY_SPECIFIER = "@lydell/node-pty";

/** Default loader: `@lydell/node-pty` is an optional dependency, so it may be missing or fail to load. */
export async function loadNodePty(): Promise<PtyModule | undefined> {
  // A variable specifier keeps TypeScript from requiring the package at compile time.
  const specifier: string = NODE_PTY_SPECIFIER;
  const mod = (await import(specifier)) as Partial<PtyModule> & { default?: Partial<PtyModule> };
  const spawnFn = mod.spawn ?? mod.default?.spawn;
  return typeof spawnFn === "function" ? { spawn: spawnFn } : undefined;
}

// ---------------------------------------------------------------------------
// Process abstraction: node-pty or child_process, same cleanup
// ---------------------------------------------------------------------------

interface ShellHandlers {
  onData(chunk: Buffer, raw: string | Buffer): void;
  /** The process exited (code / signal name). */
  onExit(code: number | null, signal: string | null): void;
  /** All output streams are closed. */
  onClosed(): void;
}

interface ShellProcess {
  readonly pid: number | undefined;
  write(data: Buffer): Promise<void>;
  resize(cols: number, rows: number): void;
  /** Close the shell's input (pipes: EOF on stdin; a PTY has no separate input to close). */
  endInput(): void;
  /** Stop reading output and release file descriptors. */
  dispose(): void;
  /** Signal only the process itself (Windows fallback; POSIX code signals the group by pid). */
  kill(signal?: NodeJS.Signals): void;
}

function wrapChild(child: ChildProcess, handlers: ShellHandlers): ShellProcess {
  const onData = (chunk: Buffer) => handlers.onData(chunk, chunk);
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  // EPIPE after the shell exits must not crash the Connector.
  child.stdin?.on("error", () => undefined);
  child.on("error", () => undefined);
  child.once("exit", (code, signal) => handlers.onExit(code, signal));
  child.once("close", () => handlers.onClosed());
  return {
    get pid() {
      return child.pid;
    },
    write(data) {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        return Promise.reject(new TerminalError("terminal_not_running", "the shell's input is closed"));
      }
      return new Promise<void>((resolve, reject) => {
        stdin.write(data, (err) => {
          if (err) reject(new TerminalError("terminal_not_running", `write failed: ${err.message}`, { cause: err }));
          else resolve();
        });
      });
    },
    resize() {
      // Pipes have no window size.
    },
    endInput() {
      child.stdin?.end();
    },
    dispose() {
      // Streams may still be held open by orphaned grandchildren; stop reading.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    },
    kill(signal) {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    },
  };
}

function wrapPty(pty: PtyProcess, handlers: ShellHandlers): ShellProcess {
  let exited = false;
  pty.onData((data) => handlers.onData(Buffer.from(data, "utf8"), data));
  // node-pty reports exit only after its read side closed (or a short timeout), so output has drained.
  pty.onExit(({ exitCode, signal }) => {
    exited = true;
    if (signal) handlers.onExit(null, signalName(signal));
    else handlers.onExit(exitCode, null);
    handlers.onClosed();
  });
  return {
    get pid() {
      return pty.pid;
    },
    write(data) {
      if (exited) return Promise.reject(new TerminalError("terminal_not_running", "the shell exited"));
      try {
        // node-pty writes straight to the PTY socket, which accepts bytes; the typings only say string.
        pty.write(data as unknown as string);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(new TerminalError("terminal_not_running", `write failed: ${(err as Error).message}`, { cause: err }));
      }
    },
    resize(cols, rows) {
      if (exited) return;
      try {
        pty.resize(cols, rows);
      } catch {
        // The PTY is already closed.
      }
    },
    endInput() {
      // Hangup is delivered by signalling the group; nothing else to close.
    },
    dispose() {
      const destroy = (pty as { destroy?: () => void }).destroy;
      if (typeof destroy === "function") {
        try {
          destroy.call(pty);
        } catch {
          // already closed
        }
      }
    },
    kill(signal) {
      // ConPTY's kill throws (asynchronously) once the process is gone.
      if (exited) return;
      try {
        // ConPTY does not take signals.
        if (IS_WINDOWS) pty.kill();
        else pty.kill(signal);
      } catch {
        // already gone
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Output log: numbered chunks for resume
// ---------------------------------------------------------------------------

interface Chunk {
  seq: number;
  data: Buffer;
}

class ChunkLog {
  readonly #cap: number;
  readonly #chunks: Chunk[] = [];
  #head = 0;
  #size = 0;
  lastSeq = 0;

  constructor(cap: number) {
    this.#cap = cap;
  }

  /** Seq of the oldest chunk still kept (lastSeq + 1 when empty). */
  get firstSeq(): number {
    return this.#chunks[this.#head]?.seq ?? this.lastSeq + 1;
  }

  append(data: Buffer): number {
    const seq = ++this.lastSeq;
    this.#chunks.push({ seq, data });
    this.#size += data.byteLength;
    return seq;
  }

  /** Drop the oldest chunks over the cap, but never one the emulator has not parsed yet (snapshots need them). */
  trim(parsedSeq: number): void {
    while (this.#size > this.#cap) {
      const head = this.#chunks[this.#head];
      if (!head || head.seq > parsedSeq || head.seq === this.lastSeq) break;
      this.#size -= head.data.byteLength;
      this.#head++;
    }
    if (this.#head > 1024 && this.#head * 2 > this.#chunks.length) {
      this.#chunks.splice(0, this.#head);
      this.#head = 0;
    }
  }

  /** Chunks with seq > `seq`, oldest first. */
  after(seq: number): Chunk[] {
    const out: Chunk[] = [];
    for (let i = this.#head; i < this.#chunks.length; i++) {
      const chunk = this.#chunks[i]!;
      if (chunk.seq > seq) out.push(chunk);
    }
    return out;
  }

  /** True when every chunk after `seq` is still here. */
  canResumeFrom(seq: number): boolean {
    return Number.isInteger(seq) && seq >= 0 && seq <= this.lastSeq && seq >= this.firstSeq - 1;
  }
}

// ---------------------------------------------------------------------------
// Subscriptions (attach streams)
// ---------------------------------------------------------------------------

class Subscription implements AsyncIterableIterator<TerminalEvent> {
  readonly clientId: string;
  readonly label: string;
  /** Generation in which a `rejected` frame was last sent (at most one per generation). */
  rejectedGeneration = -1;
  readonly #queue: TerminalEvent[] = [];
  #backlog = 0;
  #done = false;
  #waiter: ((result: IteratorResult<TerminalEvent>) => void) | undefined;
  readonly #maxBacklog: number;
  readonly #onDispose: (sub: Subscription) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort = () => this.end();

  constructor(clientId: string, label: string, maxBacklog: number, onDispose: (sub: Subscription) => void, signal?: AbortSignal) {
    this.clientId = clientId;
    this.label = label;
    this.#maxBacklog = maxBacklog;
    this.#onDispose = onDispose;
    this.#signal = signal;
    signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  get done(): boolean {
    return this.#done;
  }

  push(event: TerminalEvent): void {
    if (this.#done) return;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter({ value: event, done: false });
      return;
    }
    const size = eventBytes(event);
    if (size > 0) {
      this.#backlog += size;
      if (this.#backlog > this.#maxBacklog) {
        // Slow consumer: drop it rather than buffer without bound. Reattaching starts from a snapshot.
        this.end();
        return;
      }
    }
    this.#queue.push(event);
  }

  /** Finish after already-queued events are consumed. */
  end(): void {
    if (this.#done) return;
    this.#done = true;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#onDispose(this);
    if (this.#waiter && this.#queue.length === 0) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<TerminalEvent>> {
    const event = this.#queue.shift();
    if (event) {
      this.#backlog -= eventBytes(event);
      return Promise.resolve({ value: event, done: false });
    }
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<TerminalEvent>> {
    this.#queue.length = 0;
    this.#backlog = 0;
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<TerminalEvent> {
    return this;
  }
}

function eventBytes(event: TerminalEvent): number {
  return event.type === "output" || event.type === "snapshot" ? event.data.length : 0;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

interface Terminal {
  info: Omit<TerminalInfo, "controller" | "generation" | "viewers">;
  proc: ShellProcess;
  log: ChunkLog;
  screen: HeadlessTerminal;
  serializer: SerializeAddon;
  /** Last seq the emulator has fully parsed. */
  parsedSeq: number;
  subscribers: Set<Subscription>;
  controller: TerminalController | null;
  /** The stream holding control, or undefined while nobody does / during the grace period. */
  controlStream: Subscription | undefined;
  generation: number;
  graceTimer: NodeJS.Timeout | undefined;
  exited: boolean;
  /** Resolves once the process exited and output has drained. */
  finished: Promise<void>;
  resolveFinished: (() => void) | undefined;
  closing: boolean;
}

export class TerminalManager {
  readonly #terminals = new Map<string, Terminal>();
  readonly #replayBytes: number;
  readonly #scrollback: number;
  readonly #maxTerminals: number;
  readonly #killGraceMs: number;
  readonly #maxBacklog: number;
  readonly #controlGraceMs: number;
  readonly #loadPty: () => Promise<PtyModule | undefined>;
  readonly #fallbackMode: "pipe" | "script" | undefined;
  #pty: Promise<PtyModule | undefined> | undefined;
  #closed = false;
  readonly #onProcessExit = () => this.#killAllSync();

  constructor(opts: TerminalManagerOptions = {}) {
    this.#replayBytes = opts.replayBytes ?? DEFAULT_REPLAY_BYTES;
    this.#scrollback = opts.scrollback ?? DEFAULT_SCROLLBACK;
    this.#maxTerminals = opts.maxTerminals ?? 32;
    this.#killGraceMs = opts.killGraceMs ?? 2000;
    this.#maxBacklog = opts.maxSubscriberBacklogBytes ?? 4 * 1024 * 1024;
    this.#controlGraceMs = opts.controlGraceMs ?? DEFAULT_CONTROL_GRACE_MS;
    this.#loadPty = opts.loadPty ?? loadNodePty;
    this.#fallbackMode = opts.fallbackMode;
    // Last-resort cleanup if the Connector exits without calling closeAll().
    process.once("exit", this.#onProcessExit);
  }

  /** Whether a real PTY is available on this device (loads node-pty on first use). */
  async ptyAvailable(): Promise<boolean> {
    return (await this.#ptyModule()) !== undefined;
  }

  list(): TerminalInfo[] {
    return [...this.#terminals.values()].map((t) => this.#info(t));
  }

  get(id: string): TerminalInfo {
    return this.#info(this.#require(id));
  }

  async create(opts: CreateTerminalOptions = {}): Promise<TerminalInfo> {
    if (this.#closed) throw new TerminalError("terminal_manager_closed", "terminal manager is shut down");
    this.#pruneExited();
    if (this.#terminals.size >= this.#maxTerminals) {
      throw new TerminalError("terminal_limit_reached", `at most ${this.#maxTerminals} terminals`);
    }
    const cols = validateDimension(opts.cols ?? DEFAULT_COLS, "cols");
    const rows = validateDimension(opts.rows ?? DEFAULT_ROWS, "rows");
    const cwd = resolveCwd(opts.cwd);
    const shell = opts.shell ?? defaultShell();
    if (typeof shell !== "string" || shell.length === 0 || shell.includes("\0")) {
      throw new TerminalError("invalid_argument", "shell must be a non-empty string");
    }
    const shellArgs = opts.args ?? (IS_WINDOWS ? [] : ["-i"]);
    const requested: TerminalMode = opts.mode ?? "pty";
    if (requested === "script" && process.platform !== "linux") {
      // BSD/macOS script(1) requires its own stdin to be a tty, which a
      // headless Connector cannot provide; util-linux script works over pipes.
      throw new TerminalError("invalid_argument", 'mode "script" is only available on Linux (util-linux script)');
    }
    const owner: TerminalOwner = opts.owner ?? "user";
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) baseEnv[key] = value;
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        if (typeof value !== "string") throw new TerminalError("invalid_argument", `env.${key} must be a string`);
      }
    }

    let mode: TerminalMode = requested;
    const id = `term_${randomBytes(9).toString("base64url")}`;
    // Late-bound so the process can be wired before the Terminal object exists.
    let terminal: Terminal | undefined;
    const pending: { chunks: [Buffer, string | Buffer][]; exit?: [number | null, string | null]; closed: boolean } = { chunks: [], closed: false };
    const handlers: ShellHandlers = {
      onData: (chunk, raw) => (terminal ? this.#onOutput(terminal, chunk, raw) : pending.chunks.push([chunk, raw])),
      onExit: (code, signal) => (terminal ? this.#onExit(terminal, code, signal) : (pending.exit = [code, signal])),
      onClosed: () => (terminal ? this.#onClosed(terminal) : (pending.closed = true)),
    };

    let proc: ShellProcess | undefined;
    if (mode === "pty") {
      const pty = await this.#ptyModule();
      if (pty) {
        const executable = resolveExecutable(shell, opts.env?.PATH ?? baseEnv.PATH);
        if (!executable) throw new TerminalError("spawn_failed", `could not start ${shell}: not found or not executable`);
        const env: Record<string, string> = { ...baseEnv, TERM: "xterm-256color", ...(opts.env ?? {}) };
        delete env.COLUMNS;
        delete env.LINES;
        try {
          proc = wrapPty(pty.spawn(shell, shellArgs, { name: env.TERM ?? "xterm-256color", cols, rows, cwd, env }), handlers);
        } catch {
          // A broken native build (e.g. spawn-helper not executable): use the fallback.
          proc = undefined;
        }
      }
      if (!proc) mode = this.#fallback();
    }
    if (!proc) {
      const env: Record<string, string> = {
        ...baseEnv,
        TERM: mode === "script" ? "xterm-256color" : "dumb",
        COLUMNS: String(cols),
        LINES: String(rows),
        ...(opts.env ?? {}),
      };
      const [command, args] = mode === "script" ? scriptCommand(shell, shellArgs) : [shell, shellArgs];
      const child = spawn(command, args, {
        cwd,
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
        const onError = (err: Error) => {
          child.off("spawn", onSpawn);
          reject(new TerminalError("spawn_failed", `could not start ${command}: ${err.message}`, { cause: err }));
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      proc = wrapChild(child, handlers);
    }

    const screen = new HeadlessTerminal({
      cols,
      rows,
      scrollback: this.#scrollback,
      allowProposedApi: true,
      // Pipes carry bare LF; a PTY (and script(1)) already translates to CRLF.
      convertEol: mode === "pipe",
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);

    terminal = {
      info: {
        id,
        cwd,
        shell,
        cols,
        rows,
        created_at: new Date().toISOString(),
        running: true,
        exit_code: null,
        exit_signal: null,
        exited_at: null,
        pid: proc.pid ?? null,
        mode,
        owner,
      },
      proc,
      log: new ChunkLog(this.#replayBytes),
      screen,
      serializer,
      parsedSeq: 0,
      subscribers: new Set(),
      controller: null,
      controlStream: undefined,
      generation: 0,
      graceTimer: undefined,
      exited: false,
      finished: Promise.resolve(),
      resolveFinished: undefined,
      closing: false,
    };
    const t = terminal;
    t.finished = new Promise<void>((resolve) => {
      t.resolveFinished = resolve;
    });
    this.#terminals.set(id, t);
    for (const [chunk, raw] of pending.chunks) this.#onOutput(t, chunk, raw);
    if (pending.exit) this.#onExit(t, ...pending.exit);
    if (pending.closed) this.#onClosed(t);
    return this.#info(t);
  }

  /**
   * Write to the terminal directly, bypassing control (in-process callers and tests). Remote clients go through
   * an attachment, where only the controller may write.
   */
  async write(id: string, data: Uint8Array | string): Promise<void> {
    const terminal = this.#require(id);
    if (!terminal.info.running) throw new TerminalError("terminal_not_running", `terminal ${id} is not running`);
    await terminal.proc.write(toBuffer(data));
  }

  /**
   * Change the size. With `by`, the caller must be the current controller (matched by client id; the unary
   * `resize` method has no stream, so the client id stands in for it). Without `by` the change is unconditional.
   */
  resize(id: string, cols: number, rows: number, by?: { clientId: string }): TerminalInfo {
    const terminal = this.#require(id);
    validateDimension(cols, "cols");
    validateDimension(rows, "rows");
    if (by) {
      if (terminal.info.owner === "agent") throw new TerminalError("agent_owned", `terminal ${id} is controlled by an agent`);
      if (terminal.controller?.client_id !== by.clientId) {
        throw new TerminalError("not_controller", `only the terminal's controller may resize it (claim control first)`);
      }
    }
    this.#applySize(terminal, cols, rows);
    return this.#info(terminal);
  }

  /**
   * Attach a stream. The first frames are, in order: a `snapshot` (or, with a usable `resumeSeq`, only the missed
   * chunks), the buffered output the snapshot does not include yet, and a `control` frame; then live frames. The
   * live registration happens in this same synchronous call, so nothing falls between them.
   */
  attach(id: string, opts: AttachOptions = {}): TerminalAttachment {
    const terminal = this.#require(id);
    const clientId = opts.clientId ?? "local";
    const label = opts.label || clientId;
    if (opts.cols !== undefined) validateDimension(opts.cols, "cols");
    if (opts.rows !== undefined) validateDimension(opts.rows, "rows");
    if (opts.resumeSeq !== undefined && (!Number.isInteger(opts.resumeSeq) || opts.resumeSeq < 0)) {
      throw new TerminalError("invalid_argument", "resume_seq must be a non-negative integer");
    }
    const sub = new Subscription(clientId, label, this.#maxBacklog, (s) => this.#detach(terminal, s), opts.signal);
    const attachment = this.#attachment(terminal, sub);
    if (opts.signal?.aborted) {
      sub.end();
      return attachment;
    }
    const running = terminal.info.running;
    if (running) terminal.subscribers.add(sub);

    if (opts.resumeSeq !== undefined && terminal.log.canResumeFrom(opts.resumeSeq)) {
      for (const chunk of terminal.log.after(opts.resumeSeq)) sub.push(outputEvent(chunk));
    } else {
      sub.push({
        type: "snapshot",
        data: Buffer.from(terminal.serializer.serialize({ scrollback: this.#scrollback }), "utf8").toString("base64"),
        seq: terminal.parsedSeq,
        cols: terminal.screen.cols,
        rows: terminal.screen.rows,
      });
      for (const chunk of terminal.log.after(terminal.parsedSeq)) sub.push(outputEvent(chunk));
    }

    if (sub.done) return attachment; // dropped while queueing the first frames (backlog)
    // mode=control never takes control away from another client (only an explicit claim does).
    const takesControl =
      running &&
      opts.mode === "control" &&
      terminal.info.owner !== "agent" &&
      (terminal.controller === null || terminal.controller.client_id === clientId);
    if (takesControl) {
      this.#claim(terminal, sub, { cols: opts.cols, rows: opts.rows, keepSize: opts.cols === undefined && opts.rows === undefined });
    } else {
      sub.push(this.#controlEvent(terminal, sub));
      if (opts.mode === "control" && terminal.info.owner === "agent") this.#reject(terminal, sub, "agent_owned");
    }
    if (!running) {
      sub.push(exitEvent(terminal));
      sub.end();
    }
    return attachment;
  }

  /** Kill the terminal (SIGHUP/SIGTERM, then SIGKILL after the grace period) and forget it. */
  async close(id: string): Promise<void> {
    const terminal = this.#require(id);
    await this.#terminate(terminal);
    this.#forget(terminal);
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#terminals.values()].map((t) => this.#terminate(t)));
    for (const terminal of [...this.#terminals.values()]) this.#forget(terminal);
    process.off("exit", this.#onProcessExit);
  }

  // -- control ---------------------------------------------------------------

  #attachment(terminal: Terminal, sub: Subscription): TerminalAttachment {
    const manager = this;
    return Object.assign(sub, {
      terminalId: terminal.info.id,
      async input(data: Uint8Array | string, generation: number): Promise<boolean> {
        if (!manager.#mayDrive(terminal, sub, generation)) return false;
        try {
          await terminal.proc.write(toBuffer(data));
          return true;
        } catch {
          return false;
        }
      },
      resize(cols: number, rows: number, generation: number): boolean {
        validateDimension(cols, "cols");
        validateDimension(rows, "rows");
        if (!manager.#mayDrive(terminal, sub, generation)) return false;
        manager.#applySize(terminal, cols, rows);
        return true;
      },
      claim(options: ClaimOptions = {}): boolean {
        if (options.cols !== undefined) validateDimension(options.cols, "cols");
        if (options.rows !== undefined) validateDimension(options.rows, "rows");
        if (sub.done || !terminal.info.running) return false;
        if (terminal.info.owner === "agent") {
          manager.#reject(terminal, sub, "agent_owned");
          return false;
        }
        manager.#claim(terminal, sub, options);
        return true;
      },
      release(): boolean {
        if (sub.done) return false;
        if (terminal.controlStream !== sub) {
          manager.#reject(terminal, sub, terminal.info.owner === "agent" ? "agent_owned" : "not_controller");
          return false;
        }
        manager.#clearControl(terminal);
        return true;
      },
      close(): void {
        sub.end();
      },
    }) as Subscription & TerminalAttachment;
  }

  /** Input / resize gate: owner, controller, generation. Sends `rejected` (once per generation) when dropped. */
  #mayDrive(terminal: Terminal, sub: Subscription, generation: number): boolean {
    if (sub.done) return false;
    if (terminal.info.owner === "agent") return this.#reject(terminal, sub, "agent_owned");
    if (terminal.controlStream !== sub) return this.#reject(terminal, sub, "not_controller");
    if (generation !== terminal.generation) return this.#reject(terminal, sub, "stale_generation");
    return terminal.info.running;
  }

  #reject(terminal: Terminal, sub: Subscription, reason: RejectReason): false {
    if (sub.rejectedGeneration !== terminal.generation) {
      sub.rejectedGeneration = terminal.generation;
      sub.push({ type: "rejected", reason, generation: terminal.generation });
    }
    return false;
  }

  #claim(terminal: Terminal, sub: Subscription, options: ClaimOptions): void {
    this.#stopGrace(terminal);
    if (terminal.controlStream !== sub) {
      terminal.generation += 1;
      terminal.controlStream = sub;
      terminal.controller = { client_id: sub.clientId, label: sub.label, connected: true, since: new Date().toISOString() };
    }
    const cols = options.keepSize ? terminal.info.cols : (options.cols ?? terminal.info.cols);
    const rows = options.keepSize ? terminal.info.rows : (options.rows ?? terminal.info.rows);
    if (cols !== terminal.info.cols || rows !== terminal.info.rows) this.#resizeProcess(terminal, cols, rows);
    this.#broadcastControl(terminal);
  }

  #clearControl(terminal: Terminal): void {
    this.#stopGrace(terminal);
    terminal.controller = null;
    terminal.controlStream = undefined;
    terminal.generation += 1;
    this.#broadcastControl(terminal);
  }

  #detach(terminal: Terminal, sub: Subscription): void {
    terminal.subscribers.delete(sub);
    if (terminal.controlStream !== sub) return;
    terminal.controlStream = undefined;
    if (!terminal.info.running || !terminal.controller) return;
    // Keep control for a grace period; a claim (e.g. the same client reconnecting with mode=control) ends it.
    terminal.controller = { ...terminal.controller, connected: false };
    terminal.graceTimer = setTimeout(() => {
      terminal.graceTimer = undefined;
      if (terminal.controlStream === undefined && terminal.controller) this.#clearControl(terminal);
    }, this.#controlGraceMs);
    terminal.graceTimer.unref();
    this.#broadcastControl(terminal);
  }

  #stopGrace(terminal: Terminal): void {
    if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
    terminal.graceTimer = undefined;
  }

  #applySize(terminal: Terminal, cols: number, rows: number): void {
    if (cols === terminal.info.cols && rows === terminal.info.rows) return;
    this.#resizeProcess(terminal, cols, rows);
    this.#broadcastControl(terminal);
  }

  #resizeProcess(terminal: Terminal, cols: number, rows: number): void {
    terminal.info.cols = cols;
    terminal.info.rows = rows;
    if (terminal.info.running) terminal.proc.resize(cols, rows);
    terminal.screen.resize(cols, rows);
  }

  #controlEvent(terminal: Terminal, sub: Subscription): TerminalEvent {
    return {
      type: "control",
      controller: terminal.controller ? { ...terminal.controller } : null,
      generation: terminal.generation,
      you: terminal.controlStream === sub,
      cols: terminal.info.cols,
      rows: terminal.info.rows,
    };
  }

  #broadcastControl(terminal: Terminal): void {
    for (const sub of terminal.subscribers) sub.push(this.#controlEvent(terminal, sub));
  }

  // -- output / exit -----------------------------------------------------------

  #onOutput(terminal: Terminal, chunk: Buffer, raw: string | Buffer): void {
    const seq = terminal.log.append(chunk);
    terminal.screen.write(raw, () => {
      terminal.parsedSeq = seq;
      terminal.log.trim(seq);
    });
    if (terminal.subscribers.size === 0) return;
    const event: TerminalEvent = { type: "output", data: chunk.toString("base64"), seq };
    for (const sub of terminal.subscribers) sub.push(event);
  }

  #onExit(terminal: Terminal, code: number | null, signal: string | null): void {
    const { info } = terminal;
    info.running = false;
    info.exit_code = code;
    info.exit_signal = signal;
    info.exited_at = new Date().toISOString();
    this.#stopGrace(terminal);
    // Like a tty hangup: anything the shell left behind in its group gets SIGHUP.
    signalGroup(terminal.proc, "SIGHUP");
    terminal.exited = true;
    setTimeout(() => this.#finalize(terminal), EXIT_DRAIN_MS).unref();
  }

  #onClosed(terminal: Terminal): void {
    if (terminal.exited) this.#finalize(terminal);
  }

  #finalize(terminal: Terminal): void {
    const resolve = terminal.resolveFinished;
    if (!resolve) return;
    terminal.resolveFinished = undefined;
    terminal.proc.dispose();
    const exit = exitEvent(terminal);
    const subs = [...terminal.subscribers];
    terminal.subscribers.clear();
    terminal.controlStream = undefined;
    if (terminal.controller) terminal.controller = { ...terminal.controller, connected: false };
    for (const sub of subs) {
      sub.push(exit);
      sub.end();
    }
    resolve();
  }

  // -- internals -----------------------------------------------------------

  #ptyModule(): Promise<PtyModule | undefined> {
    this.#pty ??= this.#loadPty().then(
      (mod) => (mod && typeof mod.spawn === "function" ? mod : undefined),
      () => undefined,
    );
    return this.#pty;
  }

  #fallback(): "pipe" | "script" {
    if (this.#fallbackMode) return this.#fallbackMode;
    return process.platform === "linux" && resolveExecutable("script", process.env.PATH) ? "script" : "pipe";
  }

  #info(terminal: Terminal): TerminalInfo {
    return {
      ...terminal.info,
      controller: terminal.controller ? { ...terminal.controller } : null,
      generation: terminal.generation,
      viewers: terminal.subscribers.size,
    };
  }

  #require(id: string): Terminal {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw new TerminalError("terminal_not_found", `no terminal ${id}`);
    return terminal;
  }

  #forget(terminal: Terminal): void {
    this.#stopGrace(terminal);
    this.#terminals.delete(terminal.info.id);
    terminal.screen.dispose();
  }

  async #terminate(terminal: Terminal): Promise<void> {
    const { proc, info } = terminal;
    if (info.running && !terminal.closing) {
      terminal.closing = true;
      // Snapshot descendant processes and their process groups BEFORE the shell
      // exits (interactive shells with job control may place background jobs in
      // their own PGIDs, which `kill(-shellPid)` alone would miss once the shell
      // exits via EOF).
      const descendants = IS_WINDOWS ? [] : snapshotDescendants(proc.pid);
      if (IS_WINDOWS) {
        proc.endInput();
        killTreeWindows(proc);
      } else {
        // Send SIGHUP before closing stdin so interactive shells propagate hangup
        // to their job table instead of exiting quietly on EOF.
        signalGroup(proc, "SIGHUP");
        signalGroup(proc, "SIGTERM");
        signalDescendants(descendants, "SIGHUP");
        signalDescendants(descendants, "SIGTERM");
        proc.endInput();
      }
      const timer = setTimeout(() => {
        if (info.running || !IS_WINDOWS) {
          signalGroup(proc, "SIGKILL");
          if (!IS_WINDOWS) signalDescendants(descendants, "SIGKILL");
        }
      }, this.#killGraceMs);
      timer.unref();
      try {
        await terminal.finished;
      } finally {
        clearTimeout(timer);
      }
      // Sweep the group and any job PGIDs once more: a child that trapped
      // SIGHUP/SIGTERM outlives the shell otherwise.
      signalGroup(proc, "SIGKILL");
      if (!IS_WINDOWS) signalDescendants(descendants, "SIGKILL");
    } else {
      await terminal.finished;
    }
  }

  #pruneExited(): void {
    if (this.#terminals.size < this.#maxTerminals) return;
    for (const terminal of [...this.#terminals.values()]) {
      if (!terminal.info.running && terminal.subscribers.size === 0) {
        this.#forget(terminal);
        if (this.#terminals.size < this.#maxTerminals) return;
      }
    }
  }

  #killAllSync(): void {
    for (const terminal of this.#terminals.values()) {
      if (!terminal.info.running) continue;
      if (IS_WINDOWS) killTreeWindows(terminal.proc, true);
      else signalGroup(terminal.proc, "SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outputEvent(chunk: Chunk): TerminalEvent {
  return { type: "output", data: chunk.data.toString("base64"), seq: chunk.seq };
}

function exitEvent(terminal: Terminal): TerminalEvent {
  return { type: "exit", exit_code: terminal.info.exit_code, exit_signal: terminal.info.exit_signal };
}

function toBuffer(data: Uint8Array | string): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function signalName(signal: number): string {
  for (const [name, value] of Object.entries(os.constants.signals)) if (value === signal) return name;
  return String(signal);
}

function defaultShell(): string {
  if (IS_WINDOWS) return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

/** The shell's path when it exists and is executable (absolute / relative path, or looked up on PATH). */
function resolveExecutable(command: string, pathEnv: string | undefined): string | undefined {
  const isFile = (candidate: string) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      if (!IS_WINDOWS) fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const exts = IS_WINDOWS ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const withExt = (base: string) => exts.map((ext) => base + ext).find(isFile);
  if (command.includes("/") || (IS_WINDOWS && command.includes("\\"))) return withExt(path.resolve(command));
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const found = withExt(path.join(dir, command));
    if (found) return found;
  }
  return undefined;
}

function resolveCwd(input: string | undefined): string {
  if (input !== undefined && (typeof input !== "string" || input.includes("\0"))) {
    throw new TerminalError("invalid_argument", "cwd must be a string without NUL bytes");
  }
  const cwd = input === undefined || input === "" ? os.homedir() : path.resolve(os.homedir(), input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new TerminalError("invalid_argument", `cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new TerminalError("invalid_argument", `cwd is not a directory: ${cwd}`);
  return cwd;
}

function validateDimension(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new TerminalError("invalid_argument", `${name} must be an integer between 1 and 1000`);
  }
  return value;
}

function scriptCommand(shell: string, args: string[]): [string, string[]] {
  // util-linux: script -q -f -e -c "<cmd>" /dev/null
  const cmd = [shell, ...args].map(shQuote).join(" ");
  return ["script", ["-qfec", cmd, "/dev/null"]];
}

function shQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function signalGroup(proc: ShellProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    proc.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

interface DescendantEntry {
  pid: number;
  pgid: number;
}

/**
 * Snapshot descendant PIDs (and their PGIDs) of `rootPid` on POSIX using `ps`.
 * Best-effort: returns an empty list if `ps` is unavailable or fails.
 */
function snapshotDescendants(rootPid: number | undefined): DescendantEntry[] {
  if (rootPid === undefined || IS_WINDOWS) return [];
  try {
    const out = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.status !== 0 || !out.stdout) return [];
    const byParent = new Map<number, DescendantEntry[]>();
    for (const line of out.stdout.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/u);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pgid = Number(parts[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
      const list = byParent.get(ppid);
      if (list) list.push({ pid, pgid });
      else byParent.set(ppid, [{ pid, pgid }]);
    }
    const found: DescendantEntry[] = [];
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const entry of byParent.get(current) ?? []) {
        if (seen.has(entry.pid)) continue;
        seen.add(entry.pid);
        found.push(entry);
        queue.push(entry.pid);
      }
    }
    return found;
  } catch {
    return [];
  }
}

function signalDescendants(entries: readonly DescendantEntry[], signal: NodeJS.Signals): void {
  const seenPgids = new Set<number>();
  for (const entry of entries) {
    // Only signal the descendant's PGID when it is its own process-group leader
    // (as created by a job-control shell), avoiding ever signalling an unrelated group.
    if (entry.pgid === entry.pid && !seenPgids.has(entry.pgid)) {
      seenPgids.add(entry.pgid);
      try {
        process.kill(-entry.pgid, signal);
      } catch {
        // ESRCH
      }
    }
    try {
      process.kill(entry.pid, signal);
    } catch {
      // ESRCH
    }
  }
}

function killTreeWindows(proc: ShellProcess, sync = false): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  const args = ["/pid", String(pid), "/T", "/F"];
  try {
    if (sync) spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
    else spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => proc.kill());
  } catch {
    proc.kill();
  }
}
