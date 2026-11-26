/**
 * Child processes that take others with them: an agent behind `npx`, an installer's shell. They are spawned as a process
 * group of their own (`detached`, except on Windows) and stopped as a whole, at the latest when the Connector exits.
 */

import { spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** Kills of the trees still running, for when the Connector's own process exits. */
const RUNNING = new Set<() => void>();
let exitHookInstalled = false;

/** Call `kill` if the Connector exits first: one `exit` listener however many trees run. The result takes it back. */
export function killOnProcessExit(kill: () => void): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const killTree of RUNNING) killTree();
    });
  }
  RUNNING.add(kill);
  return () => RUNNING.delete(kill);
}

/** Signal a child and everything it started (Windows: end them). */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export interface SpawnCommand {
  command: string;
  args: string[];
  /** The arguments are quoted already (`windowsVerbatimArguments`). */
  verbatim: boolean;
}

/**
 * How to spawn `command` without a shell. On Windows npm installs its programs as `.cmd` files, which only `cmd.exe`
 * runs: it gets them with every argument quoted twice (once for itself, once for the program the file starts).
 */
export function spawnCommand(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform, comSpec: string | undefined = process.env.ComSpec): SpawnCommand {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) return { command, args: [...args], verbatim: false };
  // As in cross-spawn: backslashes before a quote are doubled, quotes are escaped, and cmd's own characters get a `^`.
  const meta = /([()\][%!^"`<>&|;, *?])/gu;
  const quote = (arg: string): string => {
    const quoted = `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1")}"`;
    return quoted.replace(meta, "^$1").replace(meta, "^$1");
  };
  const line = [path.win32.normalize(command).replace(meta, "^$1"), ...args.map(quote)].join(" ");
  return { command: comSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
