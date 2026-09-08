import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localRuntimePath, readMachineStateFile } from "./local-runtime";
import { withMachineStateLock } from "./machine-state-lock";

export type DesktopInstallation = {
  platform: NodeJS.Platform;
  appPath: string;
  executablePath: string;
  launchArgs: string[];
  packaged: boolean;
};

export const machineStatePath = localRuntimePath;

/** Desktop owns installation metadata; Connector alone appends IDs and owns startup. */
export class MachineStateStore {
  constructor(readonly filePath = machineStatePath()) {}

  readConnectorIds(): string[] {
    return readMachineStateFile(this.filePath).connectorIds;
  }

  async recordInstallation(input: DesktopInstallation): Promise<void> {
    if (!path.isAbsolute(input.appPath) || !path.isAbsolute(input.executablePath)) {
      throw new Error("Desktop installation paths must be absolute.");
    }
    const desktop = { ...input, appPath: fs.realpathSync(input.appPath), executablePath: fs.realpathSync(input.executablePath) };
    if (!fs.statSync(desktop.executablePath).isFile()) throw new Error("Desktop executable is not a file.");
    fs.accessSync(desktop.executablePath, input.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    // This short file transaction protects installation metadata from concurrent
    // Python writes. It neither inspects nor acquires Connector startup ownership.
    await withMachineStateLock(this.filePath, () => {
      const state = fs.existsSync(this.filePath)
        ? JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, ""))
        : { version: 2, connectorIds: [] };
      if (!state || Array.isArray(state) || state.version !== 2) throw new Error("Unsupported local Connector record version.");
      const next = { ...(state.desktop && typeof state.desktop === "object" ? state.desktop : {}), ...desktop };
      if (JSON.stringify(state.desktop) === JSON.stringify(next)) return;
      state.desktop = next;
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try { fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, this.filePath);
      } finally { fs.rmSync(temporary, { force: true }); }
    });
  }

}

/** Packaged macOS launches the .app executable; dev Electron needs the project argument. */
export function desktopInstallation(input: {
  executablePath: string; appPath: string; packaged: boolean; platform: NodeJS.Platform;
}): DesktopInstallation {
  let appPath = input.appPath;
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (input.packaged) {
    appPath = input.platform === "darwin"
      ? paths.resolve(input.executablePath, "../../..") : paths.dirname(input.executablePath);
    if (input.platform === "darwin" && !appPath.endsWith(".app")) throw new Error("Desktop app bundle path is invalid.");
  }
  return { ...input, appPath, launchArgs: input.packaged ? [] : [appPath] };
}
