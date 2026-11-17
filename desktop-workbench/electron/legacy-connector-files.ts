import fs from "node:fs";
import path from "node:path";

/**
 * What the v2 Python Connector left in Desktop's Connector directory: its uv
 * virtual environment, uv's download cache, the copied Connector source and
 * the environment receipts. The embedded TS Connector uses none of them.
 *
 * `connector.json` (the device credential) and `desktop-binding.json` stay:
 * the TS Connector reads the same config, so the device keeps its identity
 * across the upgrade. v2 session files under `~/.agents-anywhere/` are not
 * touched either; the Connector imports them on its first start
 * (v3 design 12-migration.md §3.4).
 */
export const LEGACY_PYTHON_ENTRIES = [
  ".venv",
  "uv-cache",
  "connector-source",
  ".connector-environment.json",
  ".connector-environment-state.json",
] as const;

/** Removes the Python leftovers; returns the names that were present. Never throws. */
export async function removeLegacyPythonFiles(dataPath: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of LEGACY_PYTHON_ENTRIES) {
    const target = path.join(dataPath, name);
    try {
      await fs.promises.lstat(target);
    } catch {
      continue;
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(name);
    } catch {
      // A locked file stays until the next launch; nothing reads it.
    }
  }
  return removed;
}
