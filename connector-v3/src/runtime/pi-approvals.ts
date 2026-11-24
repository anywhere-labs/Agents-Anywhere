// The files behind Pi approvals (`core/pi-approvals.ts`): the extension in Pi's global extensions folder, and one
// mode file per Pi process AA starts.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
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

/** A Pi process's mode file: written when it starts and whenever its conversation's mode changes, removed when it exits. */
export class PiApprovalsFile {
  readonly path: string;
  #mode: PiApprovalMode;
  /** Writes one after another, so the file always ends with the latest mode. */
  #writing: Promise<void> = Promise.resolve();

  private constructor(file: string, mode: PiApprovalMode) {
    this.path = file;
    this.#mode = mode;
  }

  /** A new file in `dir` (created 0700 if needed), holding `mode`. */
  static async create(dir: string, mode: PiApprovalMode): Promise<PiApprovalsFile> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = new PiApprovalsFile(path.join(dir, `pi-${randomUUID()}.json`), mode);
    await file.set(mode);
    return file;
  }

  get mode(): PiApprovalMode {
    return this.#mode;
  }

  /** Replace the mode; the extension reads it before the next tool call. Atomic: it never reads half a file. */
  set(mode: PiApprovalMode): Promise<void> {
    const write = async (): Promise<void> => {
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify({ mode })}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, this.path);
      this.#mode = mode;
    };
    const next = this.#writing.then(write, write);
    this.#writing = next.catch(() => undefined);
    return next;
  }

  /** Remove the file (after any write still under way). */
  remove(): Promise<void> {
    const rm = () => fs.rm(this.path, { force: true });
    const next = this.#writing.then(rm, rm);
    this.#writing = next.catch(() => undefined);
    return next;
  }
}
