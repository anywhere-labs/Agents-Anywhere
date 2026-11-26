/**
 * Runs the install commands of agents (`core/agent-catalog.ts`) one after another, without a terminal: nothing can be
 * typed into them, what they print is kept (its end), and they can be cancelled. Commands come from the catalog, never
 * from a client.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { IS_WINDOWS, killOnProcessExit, signalTree } from "./process-tree.js";

/** Installers download programs of several hundred megabytes. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 3_000;
/** How much of the output is kept, and how much of it is shown. */
const KEPT_OUTPUT = 64 * 1024;
const SHOWN_OUTPUT = 8 * 1024;

export type InstallState = "waiting" | "running" | "succeeded" | "failed" | "cancelled";

export interface InstallJob {
  /** The install method's id. */
  method: string;
  command: string;
  state: InstallState;
  startedAt: number;
  endedAt?: number;
  /** What it exited with. */
  exitCode?: number;
  /** Why it failed, when it was not its exit code (it could not be started, or took too long). */
  error?: string;
  /** The end of what it printed, without colours and progress redraws. */
  output: string;
}

export interface AgentInstallerOptions {
  /** The PATH commands run with. */
  path: () => string | undefined;
  timeoutMs?: number;
  /**
   * Whether the agent is there now, once a command has ended: some installers fail after they installed (a sign-in they
   * go on with has no one to answer it).
   */
  isInstalled?: (agent: string) => Promise<boolean>;
}

interface RunningJob extends Omit<InstallJob, "output"> {
  raw: string;
  cancelled: boolean;
  /** While its command runs. */
  stop: ((state: "failed" | "cancelled", error?: string) => void) | undefined;
  done: Promise<void>;
}

export class AgentInstaller {
  readonly #options: AgentInstallerOptions;
  readonly #jobs = new Map<string, RunningJob>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: AgentInstallerOptions) {
    this.#options = options;
  }

  /** The newest install of an agent since the Connector started. */
  job(agent: string): InstallJob | undefined {
    const job = this.#jobs.get(agent);
    if (job === undefined) return undefined;
    const { raw, cancelled: _cancelled, stop: _stop, done: _done, ...info } = job;
    return { ...info, output: cleanOutput(raw).slice(-SHOWN_OUTPUT) };
  }

  /** Waiting or running. */
  isActive(agent: string): boolean {
    const state = this.#jobs.get(agent)?.state;
    return state === "waiting" || state === "running";
  }

  /** Run `command` once the installs before it are done. One at a time per agent: an active one stays as it is. */
  start(agent: string, method: string, command: string): InstallJob {
    if (!this.isActive(agent)) {
      const job: RunningJob = { method, command, state: "waiting", startedAt: Date.now(), raw: "", cancelled: false, stop: undefined, done: Promise.resolve() };
      this.#jobs.set(agent, job);
      job.done = this.#queue.then(() => this.#run(agent, job));
      this.#queue = job.done;
    }
    return this.job(agent) as InstallJob;
  }

  /** Stop an agent's install; resolves once it has ended. */
  async cancel(agent: string): Promise<void> {
    const job = this.#jobs.get(agent);
    if (job === undefined || !this.isActive(agent)) return;
    const running = job.state === "running";
    this.#cancel(job);
    if (running) await job.done;
  }

  /** Stop every install (the Connector stops). */
  async stop(): Promise<void> {
    for (const job of this.#jobs.values()) this.#cancel(job);
    await this.#queue;
  }

  #cancel(job: RunningJob): void {
    job.cancelled = true;
    if (job.state === "waiting") {
      job.state = "cancelled";
      job.endedAt = Date.now();
    } else if (job.state === "running") {
      job.stop?.("cancelled");
    }
  }

  async #run(agent: string, job: RunningJob): Promise<void> {
    if (job.state !== "waiting") return;
    job.state = "running";
    job.startedAt = Date.now();
    let dir: string | undefined;
    let outcome: "succeeded" | "failed" | "cancelled" = "failed";
    try {
      // Installers that leave files in the folder they run in leave them here.
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "aa-install-"));
      outcome = job.cancelled ? "cancelled" : await this.#execute(job, dir);
      const there = (await this.#options.isInstalled?.(agent)) ?? false;
      if (there && outcome === "failed") {
        outcome = "succeeded";
        delete job.error;
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      outcome = "failed";
    } finally {
      if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    job.stop = undefined;
    job.endedAt = Date.now();
    job.state = outcome;
  }

  #execute(job: RunningJob, cwd: string): Promise<"succeeded" | "failed" | "cancelled"> {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", NONINTERACTIVE: "1", DEBIAN_FRONTEND: "noninteractive", NO_COLOR: "1", TERM: "dumb" };
    const searchPath = this.#options.path();
    if (searchPath !== undefined) {
      const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      env[name] = searchPath;
    }
    const [command, args] = IS_WINDOWS
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", job.command]]
      : [existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", ["-c", job.command]];
    return new Promise((resolve) => {
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WINDOWS, windowsHide: true });
      const untrack = killOnProcessExit(() => signalTree(child, "SIGKILL"));
      const keep = (chunk: string): void => {
        job.raw = (job.raw + chunk).slice(-KEPT_OUTPUT);
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", keep);
      }
      let ended: "failed" | "cancelled" | undefined;
      let settled = false;
      const finish = (outcome: "succeeded" | "failed" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        untrack();
        clearTimeout(timer);
        resolve(outcome);
      };
      job.stop = (state, error) => {
        if (ended !== undefined) return;
        ended = state;
        if (error !== undefined) job.error = error;
        signalTree(child, "SIGTERM");
        setTimeout(() => {
          if (!settled) signalTree(child, "SIGKILL");
        }, KILL_GRACE_MS).unref();
      };
      const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => job.stop?.("failed", `stopped after ${Math.max(1, Math.round(timeoutMs / 60_000))} min`), timeoutMs);
      timer.unref();
      child.on("error", (error) => {
        job.error = error.message;
        finish("failed");
      });
      // `exit`, not `close`: something an installer starts may keep its output open. What it printed last still arrives.
      child.on("exit", (code) => {
        setTimeout(() => {
          if (ended === undefined && code !== null) job.exitCode = code;
          finish(ended ?? (code === 0 ? "succeeded" : "failed"));
        }, 50);
      });
    });
  }
}

/** Text as a terminal would end up showing it: no escape sequences, only the last state of redrawn lines. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-Z\\-_()#][0-9A-Za-z]?/gu, "")
    .split("\n")
    .map((line) => line.split("\r").filter((part) => part.trim().length > 0).at(-1) ?? "")
    .join("\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
