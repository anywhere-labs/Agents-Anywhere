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

/** Which entry opened the Desktop onboarding flow that reached the complete page. */
export type DesktopOnboardingSource = "desktop" | "dsh-plugin";

export type DesktopOnboardingState = {
  /** Set once the user finished onboarding; a user launch then skips it. */
  completedAt: string | null;
  source: DesktopOnboardingSource | null;
};

export const machineStatePath = localRuntimePath;

const EMPTY_ONBOARDING: DesktopOnboardingState = { completedAt: null, source: null };

function readOnboardingRecord(state: Record<string, unknown>): DesktopOnboardingState {
  const value = state.onboarding;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_ONBOARDING };
  const record = value as Record<string, unknown>;
  return {
    completedAt: typeof record.completedAt === "string" && record.completedAt ? record.completedAt : null,
    source: record.source === "desktop" || record.source === "dsh-plugin" ? record.source : null,
  };
}

/** Desktop owns installation metadata and its own onboarding flag; Connector alone appends IDs and owns startup. */
export class MachineStateStore {
  constructor(readonly filePath = machineStatePath()) {}

  readConnectorIds(): string[] {
    return readMachineStateFile(this.filePath).connectorIds;
  }

  /**
   * Read-only. A missing record means "never completed"; a damaged one throws so
   * the caller can decide, instead of silently rewriting the file.
   */
  readOnboarding(): DesktopOnboardingState {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY_ONBOARDING };
    const state = JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, ""));
    if (!state || Array.isArray(state) || state.version !== 2) throw new Error("Unsupported local Connector record version.");
    return readOnboardingRecord(state);
  }

  async recordInstallation(input: DesktopInstallation): Promise<void> {
    if (!path.isAbsolute(input.appPath) || !path.isAbsolute(input.executablePath)) {
      throw new Error("Desktop installation paths must be absolute.");
    }
    const desktop = { ...input, appPath: fs.realpathSync(input.appPath), executablePath: fs.realpathSync(input.executablePath) };
    if (!fs.statSync(desktop.executablePath).isFile()) throw new Error("Desktop executable is not a file.");
    fs.accessSync(desktop.executablePath, input.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    await this.transact((state) => {
      const next = { ...(state.desktop && typeof state.desktop === "object" ? state.desktop : {}), ...desktop };
      if (JSON.stringify(state.desktop) === JSON.stringify(next)) return { value: null, changed: false };
      state.desktop = next;
      return { value: null, changed: true };
    });
  }

  /** Written only when the complete page is confirmed, never on entry. */
  async completeOnboarding(
    source: DesktopOnboardingSource,
    completedAt = new Date().toISOString(),
  ): Promise<DesktopOnboardingState> {
    if (source !== "desktop" && source !== "dsh-plugin") throw new Error("Unsupported Desktop onboarding source.");
    return this.transact((state) => {
      const next = { ...(state.onboarding && typeof state.onboarding === "object" ? state.onboarding : {}), completedAt, source };
      if (JSON.stringify(state.onboarding) === JSON.stringify(next)) return { value: readOnboardingRecord(state), changed: false };
      state.onboarding = next;
      return { value: { completedAt, source }, changed: true };
    });
  }

  /**
   * This short file transaction protects Desktop fields from concurrent Python
   * writes. It neither inspects nor acquires Connector startup ownership.
   */
  private transact<T>(update: (state: Record<string, unknown>) => { value: T; changed: boolean }): Promise<T> {
    return withMachineStateLock(this.filePath, () => {
      const state = fs.existsSync(this.filePath)
        ? JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, ""))
        : { version: 2, connectorIds: [] };
      if (!state || Array.isArray(state) || state.version !== 2) throw new Error("Unsupported local Connector record version.");
      const { value, changed } = update(state);
      if (!changed) return value;
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try { fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, this.filePath);
      } finally { fs.rmSync(temporary, { force: true }); }
      return value;
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
