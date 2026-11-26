// Supervises one long-running child process: spawn, log to a rotating file, health checks, and restart with
// exponential backoff. Used for the managed connector-v3 (which in turn owns the local MeshCall Router).

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import * as path from "node:path";

import type { ProcessState, ProcessStatus } from "../shared/bridge";

export interface BackoffOptions {
  /** First restart delay. */
  initialMs: number;
  /** Upper bound of the delay. */
  maxMs: number;
  /** Multiplier per consecutive failure. */
  factor: number;
  /** A run lasting at least this long resets the backoff. */
  resetAfterMs: number;
  /** Give up (state `failed`) after this many consecutive failed runs; 0 = never. */
  maxAttempts: number;
}

export interface HealthCheckOptions {
  /** Resolves true when healthy. Called only while the process is running. */
  check: () => Promise<boolean>;
  intervalMs: number;
  /** Grace period after spawn before the first check counts. */
  startupGraceMs: number;
  /** Consecutive failed checks before the process is killed (and restarted). */
  failuresBeforeRestart: number;
}

export interface ManagedProcessOptions {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  cwd?: string;
  /** stdout / stderr go here; rotated to `<file>.1` when larger than `maxLogBytes`. */
  logFile: string;
  maxLogBytes?: number;
  backoff?: Partial<BackoffOptions>;
  health?: HealthCheckOptions;
  /** SIGTERM first, SIGKILL after this long. */
  stopTimeoutMs?: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  resetAfterMs: 60_000,
  maxAttempts: 0,
};

/** Delay before restart number `attempt` (1-based). */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const exp = options.initialMs * options.factor ** Math.max(0, attempt - 1);
  return Math.min(options.maxMs, Math.round(exp));
}

export class ManagedProcess extends EventEmitter {
  readonly options: ManagedProcessOptions;
  readonly backoff: BackoffOptions;
  #child: ChildProcess | undefined;
  #state: ProcessState = "stopped";
  #wanted = false;
  #restarts = 0;
  #consecutiveFailures = 0;
  #lastExitCode: number | null = null;
  #lastError: string | null = null;
  #startedAt = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #healthTimer: NodeJS.Timeout | undefined;
  #healthFailures = 0;
  /** Why we killed the running process ourselves (reported instead of the signal). */
  #killReason: string | null = null;
  #log: WriteStream | undefined;
  #logBytes = 0;
  #exited: Promise<void> = Promise.resolve();

  constructor(options: ManagedProcessOptions) {
    super();
    this.options = options;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  }

  get status(): ProcessStatus {
    return {
      state: this.#state,
      pid: this.#child?.pid ?? null,
      restarts: this.#restarts,
      lastExitCode: this.#lastExitCode,
      lastError: this.#lastError,
    };
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  /** Start (or keep) the process running. Idempotent. */
  start(): void {
    this.#wanted = true;
    this.#consecutiveFailures = 0;
    if (this.#child || this.#restartTimer) return;
    this.#spawn();
  }

  /** Stop the process and any pending restart; resolves once it has exited. */
  async stop(): Promise<void> {
    this.#wanted = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    this.#stopHealth();
    const child = this.#child;
    if (child) {
      const exited = this.#exited;
      this.#writeLog(`[desktop] stopping ${this.options.name} (pid ${child.pid})\n`);
      child.kill("SIGTERM");
      const timeout = this.options.stopTimeoutMs ?? 8_000;
      const timer = setTimeout(() => {
        if (this.#child === child) {
          this.#writeLog(`[desktop] ${this.options.name} did not exit in ${timeout} ms, killing\n`);
          child.kill("SIGKILL");
        }
      }, timeout);
      await exited;
      clearTimeout(timer);
    }
    this.#setState("stopped");
  }

  /** Restart now (used after configuration changes). */
  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  #spawn(): void {
    this.#openLog();
    this.#setState("starting");
    this.#writeLog(`[desktop] ${new Date().toISOString()} starting ${this.options.name}: ${path.basename(this.options.command)} ${this.options.args.join(" ")}\n`);
    let child: ChildProcess;
    try {
      child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: typeof this.options.env === "function" ? this.options.env() : this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#onExit(null, error instanceof Error ? error.message : String(error));
      return;
    }
    this.#child = child;
    this.#startedAt = Date.now();
    this.#exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        if (done) return;
        done = true;
        if (this.#child === child) this.#child = undefined;
        const reason = this.#killReason;
        this.#killReason = null;
        this.#onExit(code, error ?? reason ?? (signal ? `killed by ${signal}` : null));
        resolve();
      };
      child.once("error", (error) => {
        // `error` without a following `exit` means the spawn itself failed.
        if (child.pid === undefined) finish(null, null, error.message);
        else this.#lastError = error.message;
      });
      child.once("exit", (code, signal) => finish(code, signal));
    });
    child.stdout?.on("data", (chunk: Buffer) => this.#writeLog(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.#writeLog(chunk));
    if (child.pid !== undefined) {
      this.#setState("running");
      this.#startHealth();
    }
  }

  #onExit(code: number | null, error: string | null): void {
    this.#stopHealth();
    this.#lastExitCode = code;
    this.#writeLog(`[desktop] ${this.options.name} exited (code ${code ?? "none"}${error ? `, ${error}` : ""})\n`);
    if (!this.#wanted) {
      // A requested stop is not an error.
      this.#setState("stopped");
      return;
    }
    if (error) this.#lastError = error;
    else if (code !== 0) this.#lastError = `exited with code ${code}`;
    const ranFor = this.#startedAt ? Date.now() - this.#startedAt : 0;
    if (ranFor >= this.backoff.resetAfterMs) this.#consecutiveFailures = 0;
    this.#consecutiveFailures += 1;
    if (this.backoff.maxAttempts > 0 && this.#consecutiveFailures > this.backoff.maxAttempts) {
      this.#lastError = this.#lastError ?? `${this.options.name} kept exiting`;
      this.#wanted = false;
      this.#setState("failed");
      return;
    }
    const delay = backoffDelay(this.#consecutiveFailures, this.backoff);
    this.#writeLog(`[desktop] restarting ${this.options.name} in ${delay} ms\n`);
    this.#setState("backoff");
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#wanted) return;
      this.#restarts += 1;
      this.#spawn();
    }, delay);
  }

  #startHealth(): void {
    const health = this.options.health;
    if (!health) return;
    this.#healthFailures = 0;
    const tick = async () => {
      const child = this.#child;
      if (!child) return;
      if (Date.now() - this.#startedAt >= health.startupGraceMs) {
        const ok = await health.check().catch(() => false);
        if (this.#child !== child) return;
        if (ok) {
          this.#healthFailures = 0;
        } else {
          this.#healthFailures += 1;
          if (this.#healthFailures >= health.failuresBeforeRestart) {
            this.#killReason = `health check failed ${this.#healthFailures} times`;
            this.#writeLog(`[desktop] ${this.options.name} unhealthy, restarting\n`);
            this.#healthFailures = 0;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (this.#child === child) child.kill("SIGKILL");
            }, this.options.stopTimeoutMs ?? 8_000).unref();
          }
        }
      }
      if (this.#child === child) this.#healthTimer = setTimeout(() => void tick(), health.intervalMs);
    };
    this.#healthTimer = setTimeout(() => void tick(), health.intervalMs);
  }

  #stopHealth(): void {
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = undefined;
  }

  #setState(state: ProcessState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit("status", this.status);
  }

  #openLog(): void {
    if (this.#log) return;
    mkdirSync(path.dirname(this.options.logFile), { recursive: true });
    try {
      this.#logBytes = statSync(this.options.logFile).size;
    } catch {
      this.#logBytes = 0;
    }
    this.#log = createWriteStream(this.options.logFile, { flags: "a", mode: 0o600 });
  }

  #writeLog(chunk: Buffer | string): void {
    if (!this.#log) this.#openLog();
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    const max = this.options.maxLogBytes ?? 5 * 1024 * 1024;
    if (this.#logBytes + size > max && this.#logBytes > 0) {
      this.#log?.end();
      try {
        renameSync(this.options.logFile, `${this.options.logFile}.1`);
      } catch {
        // ignore: the next write recreates the file
      }
      this.#log = createWriteStream(this.options.logFile, { flags: "a", mode: 0o600 });
      this.#logBytes = 0;
    }
    this.#logBytes += size;
    this.#log?.write(chunk);
  }

  /** Flush and close the log file (tests, shutdown). */
  async closeLog(): Promise<void> {
    const log = this.#log;
    this.#log = undefined;
    if (log) await new Promise<void>((resolve) => log.end(resolve));
  }
}
