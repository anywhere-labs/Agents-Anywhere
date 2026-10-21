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
    fs.cpSync(source, staging, { recursive: true, dereference: true });
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
