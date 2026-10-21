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

/** Content-addressed, so a resolved uv.lock is reused until the bundled source changes. */
function payloadDigest(source: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(source)) {
    hash.update(path.relative(source, file).split(path.sep).join("/")).update("\0").update(fs.readFileSync(file)).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Copy `source` into `destination`, recursively and following symbolic links, with
 * the same semantics as `fs.cpSync(source, destination, { recursive: true,
 * dereference: true })` — which cannot be used here.
 *
 * `cpSync` without a `filter` dispatches to the native `cpSyncCopyDir` fast path, which
 * walks the tree with `std::filesystem` (nodejs/node#58461). On Windows that fast path
 * fails to convert a destination path containing a non-ASCII character to wide
 * characters — a Windows profile such as `C:\Users\苏元洛\...` always does — and the
 * resulting throw is fatal, because this runtime is built without exceptions: an
 * existing destination directory can be silently left empty, and a missing one can
 * abort the process (`length_error was thrown in -fno-exceptions mode with message
 * "basic_string"`, exit code `0xC0000409`). The async `cp` path traverses in
 * JavaScript instead, and so do the plain primitives below, which is why they are not
 * affected and this copy works on any path.
 */
function copyTree(source: string, destination: string): void {
  // `statSync` follows symlinks, which is what `dereference: true` asks for.
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    // Merging into an existing directory is a no-op, exactly like `cpSync`.
    fs.mkdirSync(destination, { recursive: true, mode: stats.mode & 0o777 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
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
  if (!complete(source)) throw new Error("Bundled Connector source is incomplete.");
  const root = path.join(dataPath, "connector-source");
  const target = path.join(root, payloadDigest(source));
  if (complete(target)) return target;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(`${target}.partial-`);
  try {
    copyTree(source, staging);
    if (!complete(staging)) throw new Error("Bundled Connector source is incomplete.");
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
