import { stat } from "node:fs/promises";

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** `<platform>-<arch>`, the directory name every per-target bundle uses. */
export function runtimeTargetKey() {
  return `${process.platform}-${process.arch}`;
}
