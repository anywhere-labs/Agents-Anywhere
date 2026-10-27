import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { environmentHasConnector, environmentHome, environmentUsesPython } from "./connector-python";
import { withMachineStateLock } from "./machine-state-lock";
import { readJsonFile, writeJsonFile } from "./json-store";
import { terminateConnectorProcess } from "./connector-process";
import type { ConnectorEnvironmentState } from "../shared/connector-environment";
export type { ConnectorEnvironmentState } from "../shared/connector-environment";

export type EnvironmentContext = { project: string; environment: string; uv: string; python: string; env: NodeJS.ProcessEnv; direct?: string };
type Options = {
  dataPath: string;
  resolve: (materialize?: boolean) => EnvironmentContext;
  onState: (state: ConnectorEnvironmentState) => void;
  log: (message: string) => void;
  /** Injectable only to exercise long installs without wall-clock delays. */
  now?: () => number;
  watchdogMs?: number;
};
type Receipt = { schema: 1; fingerprint: string };

export class ConnectorEnvironment {
  private preparation: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private child: ChildProcess | null = null;
  private lock: { directory: string; token: string } | null = null;
  private state: ConnectorEnvironmentState;
  private readonly now: () => number;
  private readonly receiptPath: string;
  private readonly statePath: string;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.receiptPath = path.join(options.dataPath, ".connector-environment.json");
    this.statePath = path.join(options.dataPath, ".connector-environment-state.json");
    const previous = readJsonFile<ConnectorEnvironmentState | null>(this.statePath, null);
    // Never trust persisted ready/preparing before inspecting the current inputs.
    this.state = previous?.status === "failed" || previous?.status === "cancelled" ? previous : {
      status: previous ? "stale" : "unknown", phase: "checking", event: "environment.checking",
      message: previous ? "Checking the environment left by the previous Desktop." : "Environment has not been checked.",
      startedAt: null, updatedAt: null, lastActivityAt: null, stalled: false,
    };
  }
  getState(): ConnectorEnvironmentState { return structuredClone(this.state); }
  prepare(): Promise<void> {
    if (this.preparation) return this.preparation;
    const controller = new AbortController();
    this.controller = controller;
    this.preparation = this.run(controller.signal).finally(() => { this.preparation = null; this.controller = null; });
    return this.preparation;
  }
  async cancel(): Promise<ConnectorEnvironmentState> {
    this.controller?.abort();
    await this.preparation?.catch(() => undefined);
    return this.getState();
  }
  async shutdown(): Promise<void> { await this.cancel(); this.release(); }

  /** Reset also holds the same lease as installation and the running RPC. */
  async reset(clean: (context: EnvironmentContext) => void): Promise<void> {
    await this.cancel();
    const context = this.options.resolve();
    await this.acquire(context.environment);
    try {
      fs.rmSync(this.receiptPath, { force: true });
      clean(context);
      this.publish({ status: "stale", phase: "checking", event: "environment.stale", message: "Environment cleared. Prepare it again.", progress: undefined, error: undefined });
    } finally { this.release(); }
  }

  private async run(signal: AbortSignal): Promise<void> {
    this.publish({ status: "checking", phase: "checking", event: "environment.checking", message: "Checking Connector environment.",
      startedAt: this.timestamp(), progress: undefined, error: undefined, stderr: undefined, exitCode: undefined, stalled: false });
    try {
      const initial = this.options.resolve();
      await this.acquire(initial.environment);
      const context = this.options.resolve(true);
      this.publish({ mirrors: { pypiIndexUrl: context.env.UV_INDEX ?? "", pythonInstallMirror: context.env.UV_PYTHON_INSTALL_MIRROR ?? "", downloadsPython: !context.python } });
      signal.throwIfAborted();
      if (!context.direct) {
        const previous = readJsonFile<Receipt | null>(this.receiptPath, null);
        const complete = this.complete(context);
        const fingerprint = previous?.schema === 1 && complete ? await this.fingerprint(context, signal) : null;
        if (previous?.schema !== 1 || previous.fingerprint !== fingerprint || !complete) {
          // A failed or cancelled sync must invalidate even an earlier good receipt.
          fs.rmSync(this.receiptPath, { force: true });
          this.publish({ status: "preparing", phase: "syncing", event: "environment.started", message: "Preparing Connector dependencies." });
          await this.sync(context, signal);
          signal.throwIfAborted();
          if (!this.complete(context)) throw new Error(`uv sync completed without a usable Connector environment: ${context.environment}`);
          const resolved = await this.fingerprint(context, signal);
          signal.throwIfAborted();
          persistJson(this.receiptPath, { schema: 1, fingerprint: resolved } satisfies Receipt);
        }
      }
      signal.throwIfAborted();
      this.publish({ status: "ready", phase: "ready", event: "environment.ready", message: "Connector environment is ready.", stalled: false });
      // Retain the lease while this Desktop can run RPC from the environment.
    } catch (error) {
      if (this.child) await terminateConnectorProcess(this.child);
      this.child = null;
      this.release();
      const message = error instanceof Error ? error.message : String(error);
      this.publish(signal.aborted
        ? { status: "cancelled", phase: "cancelled", event: "environment.cancelled", message: "Environment preparation cancelled.", error: undefined, stalled: false }
        : { status: "failed", phase: "failed", event: "environment.failed", message, error: { kind: classifyEnvironmentError(message), message }, stalled: false });
      throw error;
    }
  }
  private complete(context: EnvironmentContext): boolean {
    const home = environmentHome(context.environment);
    return home !== null && environmentHasConnector(context.environment)
      && fs.existsSync(this.environmentPython(context)) && (!context.python || environmentUsesPython(home, context.python));
  }
  private environmentPython(context: EnvironmentContext): string {
    return path.join(context.environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }
  private async fingerprint(context: EnvironmentContext, signal: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    const add = (name: string, value: string | Buffer) => { hash.update(name).update("\0").update(value).update("\0"); };
    const visit = (directory: string) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (["__pycache__", "_reference", "_deprecated", ".venv", ".git"].includes(entry.name) || entry.name.endsWith(".pyc")) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) add(path.relative(context.project, file), fs.readFileSync(file));
      }
    };
    visit(path.join(context.project, "connector"));
    for (const file of ["pyproject.toml", "uv.lock"]) add(file, fs.existsSync(path.join(context.project, file)) ? fs.readFileSync(path.join(context.project, file)) : "missing");
    const python = context.python || (fs.existsSync(this.environmentPython(context)) ? this.environmentPython(context) : "");
    add("python", python ? `${fs.realpathSync(python)}:${await version(python, signal, context.env)}` : "uv-managed-missing");
    add("uv", `${context.uv}:${await version(context.uv, signal, context.env)}`);
    add("platform", `${process.platform}:${process.arch}`);
    add("environment", context.environment);
    // Hash configuration; credentials embedded in index URLs never enter the receipt.
    for (const key of Object.keys(context.env).filter(key => /^(UV_|PIP_|PYTHON|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT|REQUESTS_CA)/i.test(key)).sort()) add(key, context.env[key] ?? "");
    return hash.digest("hex");
  }
  private async sync(context: EnvironmentContext, signal: AbortSignal): Promise<void> {
    const child = spawn(context.uv, ["sync", "--project", context.project, ...(context.python ? ["--python", context.python] : [])], {
      cwd: context.project, env: context.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.writeOwner(child.pid);
    let lastActivity = this.now();
    let fileActivity = activityStamp(context.environment, context.env.UV_CACHE_DIR);
    const watchdog = setInterval(() => {
      const next = activityStamp(context.environment, context.env.UV_CACHE_DIR);
      if (next !== fileActivity) { fileActivity = next; lastActivity = this.now(); }
      const stalled = this.now() - lastActivity >= (this.options.watchdogMs ?? 120_000);
      if (stalled !== this.state.stalled) this.publish({ stalled, lastActivityAt: new Date(lastActivity).toISOString() });
    }, 1000);
    const recent: string[] = [];
    let lastPublish = 0;
    const buffers = new Map<NodeJS.ReadableStream, string>();
    const output = (line: string) => {
      line = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim().slice(0, 2000);
      if (!line) return;
      lastActivity = this.now();
      recent.push(line); if (recent.length > 12) recent.shift();
      this.options.log(line);
      const parsed = parseEnvironmentOutput(line, this.state.progress);
      // Keep snapshots bounded during uv's carriage-return download updates.
      if (this.now() - lastPublish >= 100 || parsed.phase !== this.state.phase) {
        lastPublish = this.now();
        this.publish({ ...parsed, message: line, lastActivityAt: this.timestamp(), stalled: false });
      } else this.state = { ...this.state, ...parsed, message: line, lastActivityAt: this.timestamp(), stalled: false };
    };
    for (const stream of [child.stdout!, child.stderr!]) {
      buffers.set(stream, "");
      stream.on("data", (data: Buffer) => {
        lastActivity = this.now();
        const lines = ((buffers.get(stream) ?? "") + data.toString()).split(/[\r\n]/);
        buffers.set(stream, lines.pop()!.slice(-8000));
        for (const line of lines) output(line);
      });
    }
    const abort = () => { void terminateConnectorProcess(child).catch(error => this.options.log(String(error))); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, exitSignal) => {
          for (const line of buffers.values()) output(line);
          this.publish({ exitCode: code, stderr: recent.join("\n") });
          if (code === 0 && !signal.aborted) resolve();
          else reject(new Error(`Connector environment preparation exited with code ${code}${exitSignal ? ` (${exitSignal})` : ""}\n${recent.join("\n")}`));
        });
      });
    } finally {
      clearInterval(watchdog);
      signal.removeEventListener("abort", abort);
      await terminateConnectorProcess(child);
      this.child = null;
      this.writeOwner();
    }
  }
  /** Preserve the running RPC PID too, so a backend crash cannot permit a live env reset. */
  recordProcess(pid?: number): void { this.writeOwner(pid); }

  private async acquire(environment: string): Promise<void> {
    if (this.lock) return;
    const directory = `${environment}.desktop-lock`;
    await withMachineStateLock(`${directory}.lease`, () => {
      if (fs.existsSync(directory)) {
        const owner = readJsonFile<{ pid?: number; childPid?: number } | null>(path.join(directory, "owner.json"), null);
        if (alive(owner?.pid) || alive(owner?.childPid) || (!owner && Date.now() - fs.statSync(directory).mtimeMs < 10_000)) {
          throw new Error(`Environment is busy (Desktop PID ${owner?.pid ?? "unknown"}, child PID ${owner?.childPid ?? "none"}): ${directory}`);
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
      fs.mkdirSync(directory, { mode: 0o700 });
      this.lock = { directory, token: randomUUID() };
      this.writeOwner();
    });
  }
  private writeOwner(childPid?: number): void {
    if (this.lock) writeJsonFile(path.join(this.lock.directory, "owner.json"), { pid: process.pid, childPid, token: this.lock.token });
  }
  private release(): void {
    if (!this.lock) return;
    const { directory, token } = this.lock;
    if (readJsonFile<{ token?: string } | null>(path.join(directory, "owner.json"), null)?.token === token) fs.rmSync(directory, { recursive: true, force: true });
    this.lock = null;
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private publish(patch: Partial<ConnectorEnvironmentState>): void {
    this.state = { ...this.state, ...patch, updatedAt: this.timestamp() };
    // A full disk or read-only data directory must still produce a live failure event.
    // The success receipt above is mandatory; progress snapshots are best effort.
    try { persistJson(this.statePath, this.state); }
    catch (error) {
      try { this.options.log(`Could not persist Connector environment status: ${String(error)}`); } catch { /* Log storage may be unavailable too. */ }
    }
    this.options.onState(this.getState());
  }
}
function alive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function version(executable: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, ["--version"], { signal, env, timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Could not inspect ${executable}: ${error.message}`));
    else resolve((stdout || stderr).trim());
  }));
}
/** Watch bounded directory metadata too: uv can write downloads without printing. */
function activityStamp(...directories: Array<string | undefined>): string {
  const values: string[] = [];
  const visit = (directory: string, depth: number) => {
    try {
      const stat = fs.statSync(directory); values.push(`${directory}:${stat.mtimeMs}:${stat.size}`);
      if (depth && stat.isDirectory()) for (const name of fs.readdirSync(directory).slice(0, 100)) visit(path.join(directory, name), depth - 1);
    } catch { /* Directories appear during sync. */ }
  };
  for (const directory of directories) if (directory) visit(directory, 2);
  return values.join("|");
}
export function classifyEnvironmentError(message: string): NonNullable<ConnectorEnvironmentState["error"]>["kind"] {
  if (/environment is busy/i.test(message)) return "busy";
  if (/no space left|ENOSPC|disk full/i.test(message)) return "disk";
  if (/permission denied|EACCES|EPERM|access is denied/i.test(message)) return "permission";
  if (/no solution|resolution|conflicting|unsatisfiable/i.test(message)) return "resolution";
  if (/fetch|download|network|dns|connection|certificate|timed? ?out/i.test(message)) return "network";
  if (/exited|spawn|inspect/i.test(message)) return "process";
  return "unknown";
}
export function parseEnvironmentOutput(line: string, previous?: ConnectorEnvironmentState["progress"]): Partial<ConnectorEnvironmentState> {
  const progress = { ...previous };
  let phase: ConnectorEnvironmentState["phase"] = "syncing";
  let event = "environment.syncing";
  const download = /^(Downloading|Downloaded)\s+([^\s(]+)(?:\s+\(([\d.]+)\s*(KiB|MiB|GiB|kB|MB|GB)\))?/i.exec(line);
  if (download) {
    phase = "downloading"; event = "environment.downloading"; progress.package = download[2];
    if (download[3]) {
      const units: Record<string, number> = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1000, MB: 1e6, GB: 1e9 };
      progress.totalBytes = Number(download[3]) * (units[download[4]!] ?? 1);
    } else { delete progress.totalBytes; }
    if (download[1]!.toLowerCase() === "downloaded") progress.downloadedBytes = progress.totalBytes;
    else delete progress.downloadedBytes;
  } else if (/^(Building|Built)\s+/i.test(line)) {
    phase = "building"; event = "environment.package"; progress.package = line.split(/\s+/)[1];
  } else if (/^(Resolving|Resolved)\s+/i.test(line)) {
    phase = "resolving";
    const count = /Resolved (\d+) packages?/.exec(line); if (count) progress.totalPackages = Number(count[1]);
  } else {
    const count = /Installed (\d+) packages?/.exec(line); if (count) progress.completedPackages = Number(count[1]);
  }
  return { phase, event, progress };
}

/** Remove incomplete atomic-write files on cancellation, disk errors or failed rename. */
function persistJson(file: string, value: unknown): void {
  try { writeJsonFile(file, value); }
  finally { fs.rmSync(`${file}.${process.pid}.tmp`, { force: true }); }
}
