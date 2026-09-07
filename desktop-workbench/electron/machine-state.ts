import fs from "node:fs";
import path from "node:path";
import { localRuntimePath, readLocalState, updateLocalState } from "./local-runtime";

export type DesktopInstallation = {
  platform: NodeJS.Platform;
  appPath: string;
  executablePath: string;
  launchArgs: string[];
  packaged: boolean;
};

export const machineStatePath = localRuntimePath;

/** Both apps append IDs; only Desktop records installation paths. Never credentials. */
export class MachineStateStore {
  constructor(readonly filePath = machineStatePath()) {}

  readConnectorIds(): string[] {
    return readLocalState(this.filePath).connectorIds;
  }

  async recordInstallation(input: DesktopInstallation): Promise<void> {
    if (!path.isAbsolute(input.appPath) || !path.isAbsolute(input.executablePath)) {
      throw new Error("Desktop installation paths must be absolute.");
    }
    // Validate on every launch, even when the recorded strings have not changed.
    const desktop = { ...input, appPath: fs.realpathSync(input.appPath), executablePath: fs.realpathSync(input.executablePath) };
    if (!fs.statSync(desktop.executablePath).isFile()) throw new Error("Desktop executable is not a file.");
    fs.accessSync(desktop.executablePath, input.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    await updateLocalState(this.filePath, state => { state.desktop = { ...(state.desktop as object | undefined), ...desktop }; });
  }

  async recordConnectorId(id: string): Promise<void> {
    const connectorId = id.trim();
    if (!connectorId) throw new Error("A local Connector ID is required.");
    await updateLocalState(this.filePath, state => {
      if (!state.connectorIds.includes(connectorId)) state.connectorIds.push(connectorId);
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
