import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The two entries uv needs to treat a directory as the Connector project. */
const REQUIRED = [["pyproject.toml"], ["connector", "cli.py"]] as const;

function complete(directory: string): boolean {
  return REQUIRED.every(parts => fs.existsSync(path.join(directory, ...parts)));
}

function listFiles(root: string, current = root): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(root, file));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

/** The bundle's regular files, relative to `root`, in a stable order. */
function payloadFiles(root: string): string[] {
  return listFiles(root).map(file => path.relative(root, file));
}

/**
 * Content-addressed, so a resolved uv.lock is reused until the bundled source
 * changes. Hashing a copy against the bundle's own file list also verifies it.
 */
function payloadDigest(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.split(path.sep).join("/")).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Recursive copy that follows symlinks, i.e. what `fs.cpSync(source,
 * destination, { recursive: true, dereference: true })` does.
 *
 * `cpSync` without a `filter` hands the whole copy to Node's native
 * `cpSyncCopyDir`, which on Windows decodes the UTF-8 path with the ANSI code
 * page. In the Node 22 that Electron 39 ships, a destination under a profile
 * such as `C:\Users\汐穹` therefore throws EIO/EPERM, copies nothing, or aborts
 * the process (`0xC0000409`). These primitives are not affected.
 */
function copyTree(source: string, destination: string): void {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    // Default modes: a read-only bundle directory must not become one the copy
    // can neither fill nor clean up.
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name));
    return;
  }
  fs.copyFileSync(source, destination);
}

/**
 * Mirror the bundled Connector project into a writable data directory and
 * return the copy, as the DSH plugin does.
 *
 * `uv run` writes uv.lock into the project directory. The app bundle cannot be
 * that directory: a shared install may not be writable, and a new file inside
 * a signed macOS bundle breaks its code signature. The copy is staged next to
 * its target and renamed into place, so a launch either reuses a complete copy
 * or publishes one.
 */
export function materializeConnectorProject(source: string, dataPath: string): string {
  if (!complete(source)) throw new Error(`Bundled Connector source is incomplete: ${source}`);
  const files = payloadFiles(source);
  const digest = payloadDigest(source, files);
  const root = path.join(dataPath, "connector-source");
  const target = path.join(root, digest);
  if (complete(target)) {
    try { if (payloadDigest(target, files) === digest) return target; } catch { /* Repair incomplete payloads below. */ }
  }
  // The supervisor holds the environment lease before materializing or repairing.
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(`${target}.partial-`);
  try {
    try {
      copyTree(source, staging);
      // A copy that returned without copying everything is how this failed before.
      if (payloadDigest(staging, files) !== digest) throw new Error("the copy does not match the bundle");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not copy the bundled Connector source to ${staging}: ${reason}`, { cause: error });
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      // Another launch may have published the same payload first; reuse it.
      if (!complete(target)) throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
