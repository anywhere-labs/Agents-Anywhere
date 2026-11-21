/**
 * Headless terminal sessions for the v3 Connector (`aa.v3.Terminals`, wired
 * in Wave 2).
 *
 * No native addons: shells are spawned with `child_process.spawn` over pipes
 * (default) or, on Linux, wrapped in util-linux `script(1)` to get a real
 * pty. Output from stdout+stderr is merged, kept in a 64 KiB ring buffer for
 * late attachers, and fanned out to subscribers as base64 chunks.
 *
 * Process hygiene: on POSIX each shell is started `detached`, making it the
 * leader of its own process group, so closing a terminal signals the whole
 * group (shell plus anything it started). On Windows the tree is killed with
 * `taskkill /T /F`.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TerminalMode = "pipe" | "script";

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
}

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exit_code: number | null };

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  /** Shell arguments. Default: `["-i"]` on POSIX, none on Windows. */
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** `pipe` (default, works everywhere) or `script` (pty via util-linux script(1), Linux only). */
  mode?: TerminalMode;
}

export interface SubscribeOptions {
  signal?: AbortSignal;
  /** Skip the buffered history snapshot. */
  skipHistory?: boolean;
}

export interface TerminalManagerOptions {
  /** Ring buffer size per terminal. Default 64 KiB. */
  historyBytes?: number;
  /** Max concurrently tracked terminals (running or exited). Default 32. */
  maxTerminals?: number;
  /** Grace period between SIGTERM/SIGHUP and SIGKILL. Default 2000 ms. */
  killGraceMs?: number;
  /** A subscriber whose unread backlog exceeds this is dropped (it may resubscribe). Default 4 MiB. */
  maxSubscriberBacklogBytes?: number;
}

export class TerminalError extends Error {
  readonly code:
    | "terminal_not_found"
    | "terminal_not_running"
    | "terminal_limit_reached"
    | "terminal_manager_closed"
    | "invalid_argument"
    | "spawn_failed";

  constructor(code: TerminalError["code"], message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "TerminalError";
    this.code = code;
  }
}

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_HISTORY_BYTES = 64 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const EXIT_DRAIN_MS = 250;

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

class OutputRing {
  readonly #cap: number;
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(cap: number) {
    this.#cap = cap;
  }

  push(chunk: Buffer): void {
    if (chunk.byteLength >= this.#cap) {
      this.#chunks = [Buffer.from(chunk.subarray(chunk.byteLength - this.#cap))];
      this.#size = this.#cap;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
    while (this.#size > this.#cap) {
      const head = this.#chunks[0];
      if (!head) break;
      const excess = this.#size - this.#cap;
      if (head.byteLength <= excess) {
        this.#chunks.shift();
        this.#size -= head.byteLength;
      } else {
        this.#chunks[0] = head.subarray(excess);
        this.#size -= excess;
      }
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

class Subscription implements AsyncIterableIterator<TerminalEvent> {
  readonly #queue: TerminalEvent[] = [];
  #backlog = 0;
  #done = false;
  #waiter: ((result: IteratorResult<TerminalEvent>) => void) | undefined;
  readonly #maxBacklog: number;
  readonly #onDispose: (sub: Subscription) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort = () => this.end();

  constructor(maxBacklog: number, onDispose: (sub: Subscription) => void, signal?: AbortSignal) {
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
    if (event.type === "output") {
      this.#backlog += event.data.length;
      if (this.#backlog > this.#maxBacklog) {
        // Slow consumer: drop it rather than buffer without bound. A fresh
        // subscribe() starts from the ring-buffer snapshot.
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
      if (event.type === "output") this.#backlog -= event.data.length;
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

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

interface Terminal {
  info: TerminalInfo;
  child: ChildProcess;
  ring: OutputRing;
  subscribers: Set<Subscription>;
  /** Resolves once the process exited and output has drained. */
  finished: Promise<void>;
  closing: boolean;
}

export class TerminalManager {
  readonly #terminals = new Map<string, Terminal>();
  readonly #historyBytes: number;
  readonly #maxTerminals: number;
  readonly #killGraceMs: number;
  readonly #maxBacklog: number;
  #closed = false;
  readonly #onProcessExit = () => this.#killAllSync();

  constructor(opts: TerminalManagerOptions = {}) {
    this.#historyBytes = opts.historyBytes ?? DEFAULT_HISTORY_BYTES;
    this.#maxTerminals = opts.maxTerminals ?? 32;
    this.#killGraceMs = opts.killGraceMs ?? 2000;
    this.#maxBacklog = opts.maxSubscriberBacklogBytes ?? 4 * 1024 * 1024;
    // Last-resort cleanup if the Connector exits without calling closeAll().
    process.once("exit", this.#onProcessExit);
  }

  list(): TerminalInfo[] {
    return [...this.#terminals.values()].map((t) => ({ ...t.info }));
  }

  get(id: string): TerminalInfo {
    return { ...this.#require(id).info };
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
    const mode: TerminalMode = opts.mode ?? "pipe";
    if (mode === "script" && process.platform !== "linux") {
      // BSD/macOS script(1) requires its own stdin to be a tty, which a
      // headless Connector cannot provide; util-linux script works over pipes.
      throw new TerminalError("invalid_argument", 'mode "script" is only available on Linux (util-linux script)');
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, {
      TERM: mode === "script" ? "xterm-256color" : "dumb",
      COLUMNS: String(cols),
      LINES: String(rows),
    });
    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        if (typeof value !== "string") throw new TerminalError("invalid_argument", `env.${key} must be a string`);
        env[key] = value;
      }
    }

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

    const id = `term_${randomBytes(9).toString("base64url")}`;
    const info: TerminalInfo = {
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
      pid: child.pid ?? null,
      mode,
    };
    const terminal: Terminal = {
      info,
      child,
      ring: new OutputRing(this.#historyBytes),
      subscribers: new Set(),
      finished: Promise.resolve(),
      closing: false,
    };
    terminal.finished = this.#wire(terminal);
    this.#terminals.set(id, terminal);
    return { ...info };
  }

  async write(id: string, data: Uint8Array | string): Promise<void> {
    const terminal = this.#require(id);
    const stdin = terminal.child.stdin;
    if (!terminal.info.running || !stdin || stdin.destroyed || !stdin.writable) {
      throw new TerminalError("terminal_not_running", `terminal ${id} is not running`);
    }
    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (err) => {
        if (err) reject(new TerminalError("terminal_not_running", `write failed: ${err.message}`, { cause: err }));
        else resolve();
      });
    });
  }

  /**
   * Update tracked dimensions. Pipes have no window size to change, so this
   * only affects metadata (and COLUMNS/LINES for terminals created later).
   */
  resize(id: string, cols: number, rows: number): TerminalInfo {
    const terminal = this.#require(id);
    terminal.info.cols = validateDimension(cols, "cols");
    terminal.info.rows = validateDimension(rows, "rows");
    return { ...terminal.info };
  }

  /**
   * Stream terminal events. The history snapshot and the live registration
   * happen synchronously in this call, so no output can fall between them.
   * The iterator ends after the `exit` event.
   */
  subscribe(id: string, opts: SubscribeOptions = {}): AsyncIterableIterator<TerminalEvent> {
    const terminal = this.#require(id);
    const sub = new Subscription(this.#maxBacklog, (s) => terminal.subscribers.delete(s), opts.signal);
    if (!opts.skipHistory) {
      const history = terminal.ring.snapshot();
      if (history.byteLength > 0) sub.push({ type: "output", data: history.toString("base64") });
    }
    if (opts.signal?.aborted) {
      sub.end();
      return sub;
    }
    if (terminal.info.running) {
      terminal.subscribers.add(sub);
    } else {
      sub.push({ type: "exit", exit_code: terminal.info.exit_code });
      sub.end();
    }
    return sub;
  }

  /** Kill the terminal (SIGHUP/SIGTERM, then SIGKILL after the grace period) and forget it. */
  async close(id: string): Promise<void> {
    const terminal = this.#require(id);
    await this.#terminate(terminal);
    this.#terminals.delete(id);
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#terminals.values()].map((t) => this.#terminate(t)));
    this.#terminals.clear();
    process.off("exit", this.#onProcessExit);
  }

  // -- internals -----------------------------------------------------------

  #require(id: string): Terminal {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw new TerminalError("terminal_not_found", `no terminal ${id}`);
    return terminal;
  }

  #wire(terminal: Terminal): Promise<void> {
    const { child, info } = terminal;
    const onData = (chunk: Buffer) => {
      terminal.ring.push(chunk);
      if (terminal.subscribers.size === 0) return;
      const event: TerminalEvent = { type: "output", data: chunk.toString("base64") };
      for (const sub of terminal.subscribers) sub.push(event);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // EPIPE after the shell exits must not crash the Connector.
    child.stdin?.on("error", () => undefined);
    child.on("error", () => undefined);

    return new Promise<void>((resolve) => {
      let exited = false;
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        // Streams may still be held open by orphaned grandchildren; stop reading.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        const exitEvent: TerminalEvent = { type: "exit", exit_code: info.exit_code };
        for (const sub of [...terminal.subscribers]) {
          sub.push(exitEvent);
          sub.end();
        }
        terminal.subscribers.clear();
        resolve();
      };
      child.once("exit", (code, signal) => {
        exited = true;
        info.running = false;
        info.exit_code = code;
        info.exit_signal = signal;
        info.exited_at = new Date().toISOString();
        // Like a tty hangup: anything the shell left behind in its group gets SIGHUP.
        signalGroup(child, "SIGHUP");
        setTimeout(finalize, EXIT_DRAIN_MS).unref();
      });
      child.once("close", () => {
        if (exited) finalize();
      });
    });
  }

  async #terminate(terminal: Terminal): Promise<void> {
    const { child, info } = terminal;
    if (info.running && !terminal.closing) {
      terminal.closing = true;
      // Snapshot descendant processes and their process groups BEFORE the shell
      // exits (interactive shells with job control may place background jobs in
      // their own PGIDs, which `kill(-shellPid)` alone would miss once the shell
      // exits via EOF).
      const descendants = IS_WINDOWS ? [] : snapshotDescendants(child.pid);
      if (IS_WINDOWS) {
        child.stdin?.end();
        killTreeWindows(child);
      } else {
        // Send SIGHUP before closing stdin so interactive shells propagate hangup
        // to their job table instead of exiting quietly on EOF.
        signalGroup(child, "SIGHUP");
        signalGroup(child, "SIGTERM");
        signalDescendants(descendants, "SIGHUP");
        signalDescendants(descendants, "SIGTERM");
        child.stdin?.end();
      }
      const timer = setTimeout(() => {
        if (info.running || !IS_WINDOWS) {
          signalGroup(child, "SIGKILL");
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
      signalGroup(child, "SIGKILL");
      if (!IS_WINDOWS) signalDescendants(descendants, "SIGKILL");
    } else {
      await terminal.finished;
    }
  }

  #pruneExited(): void {
    if (this.#terminals.size < this.#maxTerminals) return;
    for (const [id, terminal] of this.#terminals) {
      if (!terminal.info.running && terminal.subscribers.size === 0) {
        this.#terminals.delete(id);
        if (this.#terminals.size < this.#maxTerminals) return;
      }
    }
  }

  #killAllSync(): void {
    for (const terminal of this.#terminals.values()) {
      if (!terminal.info.running) continue;
      if (IS_WINDOWS) killTreeWindows(terminal.child, true);
      else signalGroup(terminal.child, "SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultShell(): string {
  if (IS_WINDOWS) return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/sh";
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

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) child.kill(signal);
    else process.kill(-pid, signal);
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

function killTreeWindows(child: ChildProcess, sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const args = ["/pid", String(pid), "/T", "/F"];
  try {
    if (sync) spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
    else spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  } catch {
    child.kill();
  }
}
