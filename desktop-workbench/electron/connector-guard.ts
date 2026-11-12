import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Duplex } from "node:stream";

type GuardExit = { code: number | null; signal: NodeJS.Signals | null; cleaned: boolean };
const STOP_TIMEOUT_MS = 6_000;

function stageGuard(source: string): string {
  // Resolve the system-assigned directory instead of inheriting a potentially
  // external TMPDIR or userData path. The guard must survive worktree loss.
  const base = fs.realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim());
  if (fs.statSync(base).dev !== fs.statSync("/private/var").dev) {
    throw new Error("DARWIN_USER_TEMP_DIR is not on the macOS data volume.");
  }
  const binary = fs.readFileSync(source);
  const hash = createHash("sha256").update(binary).digest("hex");
  const executable = path.join(base, `aa-connector-guard-${hash}`);
  if (!fs.existsSync(executable)) {
    const temporary = fs.mkdtempSync(path.join(base, "aa-connector-guard-"));
    try {
      const staged = path.join(temporary, "connector-guard");
      fs.writeFileSync(staged, binary, { mode: 0o700 });
      fs.renameSync(staged, executable);
    } finally {
      fs.rmdirSync(temporary);
    }
  }
  return executable;
}

export class ConnectorGuard {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<GuardExit>;
  private readonly control: Duplex;
  private stopped = false;

  constructor(options: {
    source: string;
    desktopPid: number;
    cwd: string;
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    onDiagnostic: (message: string) => void;
  }) {
    const executable = stageGuard(options.source);
    this.child = spawn(executable, [String(options.desktopPid), options.cwd, options.executable, ...options.args], {
      cwd: path.dirname(executable),
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    // libuv supplies a private socketpair on Unix. The guard alone inherits
    // fd 3, so neither uv nor its descendants can hold this channel open.
    this.control = this.child.stdio[3] as Duplex;
    this.control.on("error", () => this.control.destroy());
    let cleaned = false;
    const reader = readline.createInterface({ input: this.control });
    reader.on("error", () => this.control.destroy());
    reader.on("line", line => {
      if (line.startsWith("clean ")) cleaned = true;
      else options.onDiagnostic(line);
    });
    const controlClosed = new Promise<void>(resolve => reader.once("close", resolve));
    this.control.once("close", () => reader.close());
    const exited = new Promise<Omit<GuardExit, "cleaned">>(resolve => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
      this.child.on("error", () => {
        if (this.child.pid === undefined) resolve({ code: null, signal: null });
      });
    });
    // A detached descendant can retain stdout/stderr after the group is gone.
    // Only the guard owns the control socket, which carries the cleanup result.
    this.closed = Promise.all([exited, controlClosed]).then(([result]) => ({
      ...result, cleaned: cleaned || this.child.pid === undefined,
    }));
  }

  start(): void { this.control.write("start\n"); }

  watch(pid: number): void {
    if (!this.stopped) this.control.write(`watch ${pid}\n`);
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.control.write("stop\n");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Connector RPC process group is still stopping.")), STOP_TIMEOUT_MS);
        }),
      ]);
      if (!result.cleaned) throw new Error("Connector RPC process group cleanup could not be confirmed.");
    } finally {
      clearTimeout(timer);
    }
  }
}
