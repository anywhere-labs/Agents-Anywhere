import fs from "node:fs/promises";
import path from "node:path";

/** Only directories backed by a real local file may become Desktop workspaces. */
export async function droppedFolderPath(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !path.isAbsolute(value)) return null;
  try {
    const realPath = await fs.realpath(value);
    if (realPath.length > 4096) return null;
    const info = await fs.stat(realPath);
    return info.isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}
