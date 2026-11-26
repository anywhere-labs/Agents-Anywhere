// The files behind Pi approvals (`core/pi-approvals.ts`): the extension in Pi's global extensions folder, and one
// file per Pi process AA starts with the modes of its sessions.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_PI_APPROVAL_MODE,
  PI_APPROVALS_EXTENSION_FILE,
  PI_APPROVALS_EXTENSION_MARKER,
  piApprovalsExtensionSource,
  type PiApprovalMode,
} from "../core/pi-approvals.js";

/** Pi's global extensions folder: `$PI_CODING_AGENT_DIR/extensions`, or `~/.pi/agent/extensions` (as Pi resolves it). */
export function piExtensionsDir(agentDir: string | undefined = process.env.PI_CODING_AGENT_DIR): string {
  const dir = agentDir && agentDir.length > 0 ? agentDir.replace(/^~(?=$|[\\/])/u, os.homedir()) : path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, "extensions");
}

/** Whether `text` is AA's extension (its first line): only that is overwritten or removed. */
function isOurs(text: string): boolean {
  return text.startsWith(PI_APPROVALS_EXTENSION_MARKER);
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Install (or bring up to date) the extension in `dir`. Nothing is written when it is already current. A file of the
 * same name that is not AA's is left alone and reported as an error: the user's own extension is never replaced.
 */
export async function installPiApprovals(dir: string = piExtensionsDir()): Promise<void> {
  const file = path.join(dir, PI_APPROVALS_EXTENSION_FILE);
  const source = piApprovalsExtensionSource();
  const existing = await readIfExists(file);
  if (existing === source) return;
  if (existing !== undefined && !isOurs(existing)) {
    throw new Error(`${file} exists and is not the Agents Anywhere extension: move it away to turn approvals on`);
  }
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${PI_APPROVALS_EXTENSION_FILE}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, source, { encoding: "utf8", mode: 0o644 });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Remove the extension from `dir` if it is AA's (a file of the same name that is not, stays). */
export async function uninstallPiApprovals(dir: string = piExtensionsDir()): Promise<void> {
  const file = path.join(dir, PI_APPROVALS_EXTENSION_FILE);
  const existing = await readIfExists(file);
  if (existing === undefined || !isOurs(existing)) return;
  await fs.rm(file, { force: true });
}

/**
 * A Pi process's approvals: the mode of each of its sessions, in a file the extension reads before every tool call.
 * Written whenever one changes, removed when the process exits.
 */
export class PiApprovalsFile {
  readonly path: string;
  #modes = new Map<string, PiApprovalMode>();
  #off = false;
  /** Writes one after another, so the file always ends with the latest modes. */
  #writing: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    this.path = file;
  }

  /** A new file in `dir` (created 0700 if needed): every session asks until told otherwise. */
  static async create(dir: string): Promise<PiApprovalsFile> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = new PiApprovalsFile(path.join(dir, `pi-${randomUUID()}.json`));
    await file.#write(new Map(), false);
    return file;
  }

  /** Approvals were turned off while the process runs: nothing asks any more. */
  get off(): boolean {
    return this.#off;
  }

  /** The session's mode. */
  mode(sessionId: string): PiApprovalMode {
    return this.#modes.get(sessionId) ?? DEFAULT_PI_APPROVAL_MODE;
  }

  /** Change a session's mode; the extension reads it before the next tool call. */
  set(sessionId: string, mode: PiApprovalMode): Promise<void> {
    return this.#change((modes) => modes.set(sessionId, mode));
  }

  /** The session is closed. */
  forget(sessionId: string): Promise<void> {
    return this.#modes.has(sessionId) ? this.#change((modes) => modes.delete(sessionId)) : Promise.resolve();
  }

  /** Ask in no session any more. */
  turnOff(): Promise<void> {
    this.#off = true;
    return this.#change((modes) => modes.clear());
  }

  /** Remove the file (after any write still under way). */
  remove(): Promise<void> {
    return this.#after(() => fs.rm(this.path, { force: true }));
  }

  #change(change: (modes: Map<string, PiApprovalMode>) => unknown): Promise<void> {
    return this.#after(async () => {
      const next = new Map(this.#modes);
      change(next);
      await this.#write(next, this.#off);
    });
  }

  #after(task: () => Promise<void>): Promise<void> {
    const next = this.#writing.then(task, task);
    this.#writing = next.catch(() => undefined);
    return next;
  }

  /** Atomic: the extension never reads half a file. */
  async #write(modes: Map<string, PiApprovalMode>, off: boolean): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const state = { default: off ? "full_access" : DEFAULT_PI_APPROVAL_MODE, modes: Object.fromEntries(modes) };
    await fs.writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, this.path);
    this.#modes = modes;
  }
}
