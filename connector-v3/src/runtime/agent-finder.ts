/**
 * Where programs are on this device. Agents come from their own installers, npm, Homebrew, … into folders that are often
 * only on the PATH of the user's shell: a Connector started by the Desktop app or as a service does not have them. So
 * the folders of the Connector's PATH, of a login shell's PATH, and the folders installers usually use are searched, in
 * that order. Agent processes get the same folders as their PATH, so an agent also finds what it needs itself (`node`,
 * `git`, …).
 */

import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SHELL_TIMEOUT_MS = 5_000;
const MARKER = "__AA_PATH__";

/** Folders programs are installed in, besides those on a PATH (`~`: the home folder; `*`: each folder there, newest first). */
const POSIX_FOLDERS = [
  "~/.local/bin",
  "~/bin",
  "/opt/homebrew/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/snap/bin",
  "~/.bun/bin",
  "~/.cargo/bin",
  "~/.deno/bin",
  "~/go/bin",
  "~/.npm-global/bin",
  "~/.volta/bin",
  "~/.asdf/shims",
  "~/.local/share/mise/shims",
  "~/Library/pnpm",
  "~/.local/share/pnpm",
  "~/.yarn/bin",
  "~/.nvm/versions/node/*/bin",
  "~/.local/share/fnm/node-versions/*/installation/bin",
  "~/Library/Application Support/fnm/node-versions/*/installation/bin",
];

/** The same on Windows; `%NAME%` is an environment variable. */
const WINDOWS_FOLDERS = [
  "~/.local/bin",
  "%APPDATA%/npm",
  "%LOCALAPPDATA%/pnpm",
  "%LOCALAPPDATA%/Microsoft/WinGet/Links",
  "%LOCALAPPDATA%/Microsoft/WindowsApps",
  "%ProgramFiles%/nodejs",
  "%ProgramData%/chocolatey/bin",
  "~/scoop/shims",
  "~/.bun/bin",
  "~/.cargo/bin",
  "%LOCALAPPDATA%/Volta/bin",
];

export interface AgentFinderOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** More folders, searched last (the agents' own; same notation as the usual ones). */
  folders?: readonly string[];
  /** The usual folders (default: the platform's). */
  usualFolders?: readonly string[];
  /** The PATH of a login shell (default: the user's shell is asked; Windows: the PATH saved for the user and the machine). */
  readShellPath?: () => Promise<string | undefined>;
}

export class AgentFinder {
  readonly #platform: NodeJS.Platform;
  readonly #env: NodeJS.ProcessEnv;
  readonly #home: string;
  readonly #extra: readonly string[];
  readonly #readShellPath: () => Promise<string | undefined>;
  #shellPath: string | undefined;
  #folders: string[] = [];
  /** The names in each folder, since the last `rescan`. */
  readonly #entries = new Map<string, ReadonlySet<string>>();

  constructor(options: AgentFinderOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#env = options.env ?? process.env;
    this.#home = options.home ?? os.homedir();
    this.#extra = [...(options.usualFolders ?? (this.#platform === "win32" ? WINDOWS_FOLDERS : POSIX_FOLDERS)), ...(options.folders ?? [])];
    this.#readShellPath = options.readShellPath ?? (() => readShellPath(this.#platform, this.#env));
    this.rescan();
  }

  /** The folders searched, in order. */
  get folders(): readonly string[] {
    return this.#folders;
  }

  /** The same as a PATH, for the processes of agents and their installers. */
  get path(): string {
    return this.#folders.join(this.#delimiter);
  }

  /** Ask for the login shell's PATH again, then `rescan`. */
  async refresh(): Promise<void> {
    this.#shellPath = (await this.#readShellPath().catch(() => undefined)) ?? this.#shellPath;
    this.rescan();
  }

  /** Forget what is installed: the next `find` reads the folders again. */
  rescan(): void {
    this.#entries.clear();
    const split = (value: string | undefined): string[] => (value ?? "").split(this.#delimiter).filter((dir) => dir.length > 0);
    const all = [...split(this.#pathVariable), ...split(this.#shellPath), ...this.#extra.flatMap((folder) => this.#expand(folder))];
    // Relative entries of a PATH depend on the folder something runs in: they are not searched.
    this.#folders = [...new Set(all.filter((folder) => this.#paths.isAbsolute(folder)).map((folder) => this.#paths.normalize(folder)))];
  }

  /** Where the first of `names` that is installed is. */
  find(names: readonly string[]): string | undefined {
    for (const name of names) {
      for (const folder of this.#folders) {
        const entries = this.#list(folder);
        for (const file of this.#fileNames(name)) {
          if (!entries.has(this.#platform === "win32" ? file.toLowerCase() : file)) continue;
          const found = this.#paths.join(folder, file);
          if (this.isProgram(found)) return found;
        }
      }
    }
    return undefined;
  }

  /** Where a command starts from: a program by its name, or a path to one. */
  resolve(command: string): string | undefined {
    if (!/[\\/]/u.test(command)) return this.find([command]);
    const file = this.userPath(command);
    return this.#fileNames(file).find((candidate) => this.isProgram(candidate));
  }

  /** A path the user wrote, with `~` as the home folder. */
  userPath(file: string): string {
    return file.replace(/^~(?=$|[\\/])/u, () => this.#home);
  }

  /** A file that can be run. */
  isProgram(file: string): boolean {
    try {
      if (!statSync(file).isFile()) return false;
      if (this.#platform !== "win32") accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  get #paths(): path.PlatformPath {
    return this.#platform === "win32" ? path.win32 : path.posix;
  }

  get #delimiter(): string {
    return this.#paths.delimiter;
  }

  get #pathVariable(): string | undefined {
    if (this.#platform !== "win32") return this.#env.PATH;
    const name = Object.keys(this.#env).find((key) => key.toUpperCase() === "PATH");
    return name === undefined ? undefined : this.#env[name];
  }

  /** The files a program of that name may be: on Windows with each extension of PATHEXT. */
  #fileNames(name: string): string[] {
    if (this.#platform !== "win32") return [name];
    const extensions = (this.#env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0);
    if (extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))) return [name];
    return extensions.map((ext) => name + ext.toLowerCase());
  }

  #list(folder: string): ReadonlySet<string> {
    let entries = this.#entries.get(folder);
    if (entries === undefined) {
      try {
        const names = readdirSync(folder);
        entries = new Set(this.#platform === "win32" ? names.map((name) => name.toLowerCase()) : names);
      } catch {
        entries = new Set();
      }
      this.#entries.set(folder, entries);
    }
    return entries;
  }

  #expand(folder: string): string[] {
    let missing = false;
    const named = folder.replace(/%([^%]+)%/gu, (_match, name: string) => {
      const value = this.#env[name];
      if (!value) missing = true;
      return value ?? "";
    });
    if (missing) return [];
    const full = this.userPath(named);
    const star = full.indexOf("*");
    if (star < 0) return [full];
    const parent = full.slice(0, star - 1);
    try {
      return readdirSync(parent)
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
        .map((name) => full.replace("*", () => name));
    } catch {
      return [];
    }
  }
}

/** The PATH an interactive login shell has, or what Windows gives a new terminal. */
async function readShellPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (platform === "win32") {
    const script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], env);
    return output?.trim() || undefined;
  }
  // `printenv` rather than `$PATH`, which is a list in some shells. What the profile prints is outside the markers.
  for (const shell of new Set([env.SHELL, "/bin/zsh", "/bin/bash"])) {
    if (!shell) continue;
    const output = await run(shell, ["-ilc", `printf '%s' '${MARKER}'; printenv PATH; printf '%s' '${MARKER}'`], env);
    const found = output?.split(MARKER)[1]?.trim();
    if (found) return found;
  }
  return undefined;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // A group of its own: a profile that starts something and waits goes with it.
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], env, detached: process.platform !== "win32", windowsHide: true });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(undefined);
    }, SHELL_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (output += chunk));
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(output));
  });
}
