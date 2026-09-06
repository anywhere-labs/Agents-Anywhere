import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";

export type DesktopInstallation = {
  platform: NodeJS.Platform;
  appPath: string;
  executablePath: string;
  launchArgs: string[];
  packaged: boolean;
};

type MachineState = Record<string, unknown> & {
  version: 1;
  desktop?: DesktopInstallation;
  connectorIds: string[];
};

export function machineStatePath(home = userInfo().homedir): string {
  return path.join(home, ".agentsanywhere", "machine.json");
}

/** Desktop is the sole writer. Plugins read atomic snapshots, never credentials. */
export class MachineStateStore {
  constructor(readonly filePath = machineStatePath()) {}

  readConnectorIds(): string[] {
    return this.read().connectorIds;
  }

  recordInstallation(input: DesktopInstallation): void {
    if (!path.isAbsolute(input.appPath) || !path.isAbsolute(input.executablePath)) {
      throw new Error("Desktop installation paths must be absolute.");
    }
    // Validate on every launch, even when the recorded strings have not changed.
    const desktop = { ...input, appPath: fs.realpathSync(input.appPath), executablePath: fs.realpathSync(input.executablePath) };
    if (!fs.statSync(desktop.executablePath).isFile()) throw new Error("Desktop executable is not a file.");
    fs.accessSync(desktop.executablePath, input.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    this.update(state => ({ ...state, desktop: { ...state.desktop, ...desktop } }));
  }

  recordConnectorId(id: string): void {
    const connectorId = id.trim();
    if (!connectorId) throw new Error("A local Connector ID is required.");
    this.update(state => state.connectorIds.includes(connectorId) ? state : {
      ...state, connectorIds: [...state.connectorIds, connectorId],
    });
  }

  private read(repair = false): MachineState {
    let text: string;
    try { text = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, connectorIds: [] };
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch {
      if (!repair) throw new Error("The local machine record contains invalid JSON.");
      // Preserve corrupt contents for diagnosis before repairing the startup record.
      fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
      return { version: 1, connectorIds: [] };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (!repair) throw new Error("The local machine record is invalid.");
      return { version: 1, connectorIds: [] };
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1 && (!repair || record.version !== undefined)) throw new Error("Unsupported machine record version.");
    if (!repair && record.connectorIds !== undefined && (
      !Array.isArray(record.connectorIds) || record.connectorIds.some(id => typeof id !== "string" || !id.trim())
    )) throw new Error("The local Connector ID record is invalid.");
    const connectorIds = Array.isArray(record.connectorIds)
      ? [...new Set(record.connectorIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map(id => id.trim()))]
      : [];
    return { ...record, version: 1, connectorIds } as MachineState;
  }

  private update(change: (state: MachineState) => MachineState): void {
    // Synchronous read/modify/write plus Electron's single-instance lock serializes all writers.
    const next = change(this.read(true));
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    try { if (fs.readFileSync(this.filePath, "utf8") === contents) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporaryPath, "wx", 0o600);
      try { fs.writeFileSync(fd, contents, "utf8"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporaryPath, this.filePath);
    } finally { fs.rmSync(temporaryPath, { force: true }); }
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
