import fs from "node:fs";
import path from "node:path";

/**
 * The interpreter `scripts/prepare-python.mjs` bundles under
 * `<bundleDir>/<platform>-<arch>/`, a python-build-standalone install.
 * Callers check that it exists.
 */
export function bundledPythonExecutable(
  bundleDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const root = path.join(bundleDir, `${platform}-${arch}`);
  return platform === "win32" ? path.join(root, "python.exe") : path.join(root, "bin", "python3");
}

/** The interpreter directory (`home`) an environment's pyvenv.cfg records; null without an environment. */
export function environmentHome(environmentPath: string): string | null {
  let config: string;
  try {
    config = fs.readFileSync(path.join(environmentPath, "pyvenv.cfg"), "utf8");
  } catch {
    return null;
  }
  return /^\s*home\s*=\s*(.*?)\s*$/m.exec(config)?.[1] ?? "";
}

/**
 * Whether an environment whose pyvenv.cfg records `home` was created from
 * `python`. uv records the directory of the interpreter's real executable, so
 * a symlinked `bin/python3` matches through its target as well.
 */
export function environmentUsesPython(home: string, python: string): boolean {
  const recorded = comparablePath(home);
  return [python, realPath(python)].some((candidate) => comparablePath(path.dirname(candidate)) === recorded);
}

function realPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

function comparablePath(value: string): string {
  const resolved = realPath(path.resolve(value));
  // Windows and default macOS volumes are case-insensitive.
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}
