// Shared with dsh-bridge-next/src/host/desktop/local-runtime.ts and Python runtime_owner.py.
import fs from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { withMachineStateLock } from "./machine-state-lock.js";

export const CONFLICT_MESSAGE = "当前已有其他 Connector 在运行，请先退出对应应用或手动结束进程后重试。";
export type RuntimeOwner = {
  instanceId: string; kind: string; pid: number; processStartedAt?: string;
  childPid?: number; childStartedAt?: string;
  connectorId?: string; serverUrl?: string; startedAt: string;
};
export type LocalState = Record<string, unknown> & { version: 2; connectorIds: string[]; runtime?: RuntimeOwner };
export type OwnershipState = { status: "owned" | "conflict" | "error"; message?: string; owner?: RuntimeOwner };
export const localRuntimePath = (home = userInfo().homedir): string => path.join(home, ".agents-anywhere", "connector-runtime.json");

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!object(value)) throw new Error("Invalid local Connector record.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("无法读取本机 Connector 记录，请检查文件格式与访问权限。", { cause: error });
  }
}
function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id.trim())) throw new Error("Invalid local Connector IDs.");
  return [...new Set((value as string[]).map(id => id.trim()))];
}
function validateOwner(value: unknown): RuntimeOwner {
  if (!object(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.kind !== "string" ||
      typeof value.instanceId !== "string" || !value.instanceId || typeof value.startedAt !== "string" ||
      (value.childPid !== undefined && (!Number.isSafeInteger(value.childPid) || Number(value.childPid) <= 0)) ||
      [value.processStartedAt, value.childStartedAt].some(v => v !== undefined && typeof v !== "string")) {
    throw new Error("Invalid local Connector owner.");
  }
  return value as RuntimeOwner;
}
export function readLocalState(file: string): LocalState {
  const value = readJson(file);
  if (!value) return { version: 2, connectorIds: [] };
  // The old CLI wrote a flat PID record at the same canonical location.
  if (value.version === undefined && Number.isSafeInteger(value.pid) && typeof value.kind === "string") {
    const runtime = validateOwner({ ...value, instanceId: `legacy-${value.pid}`, startedAt: value.startedAt ?? "" });
    return { version: 2, connectorIds: typeof value.connectorId === "string" && value.connectorId ? [value.connectorId] : [], runtime };
  }
  if (value.version !== 2) throw new Error("Unsupported local Connector record version.");
  if (value.runtime !== undefined) validateOwner(value.runtime);
  return { ...value, version: 2, connectorIds: ids(value.connectorIds) } as LocalState;
}
function writeState(file: string, state: LocalState): void {
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === contents) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, contents, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Only this transaction may merge, migrate, claim or release the shared record. */
export async function updateLocalState<T>(file: string, change: (state: LocalState) => T): Promise<T> {
  return withMachineStateLock(file, async () => {
    let state = readLocalState(file);
    if (state.legacyMachineMigrated === true) {
      const result = change(state);
      writeState(file, state);
      return result;
    }
    const legacyRoot = path.join(path.dirname(path.dirname(file)), ".agentsanywhere");
    const legacyMachine = path.join(legacyRoot, "machine.json");
    const legacyInstall = path.join(legacyRoot, "desktop", "install.json");
    // Hold the previous writer's lock until migration has been published and removed.
    return withMachineStateLock(legacyMachine, () => {
      const machine = readJson(legacyMachine);
      const installation = readJson(legacyInstall);
      if (machine && machine.version !== 1) throw new Error("Unsupported legacy machine record version.");
      if (installation && installation.version !== 1) throw new Error("Unsupported legacy installation record version.");
      if (machine) state = { ...machine, ...state, version: 2, connectorIds: ids([...ids(machine.connectorIds), ...state.connectorIds]),
        ...(state.desktop === undefined && machine.desktop !== undefined ? { desktop: machine.desktop } : {}) };
      if (installation && state.desktop === undefined) state.desktop = installation;
      state.legacyMachineMigrated = true;
      const result = change(state);
      writeState(file, state);
      if (machine) fs.rmSync(legacyMachine);
      if (installation) fs.rmSync(legacyInstall);
      return result;
    });
  });
}

export function processIdentity(pid: number): string | undefined {
  try {
    const value = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] });
    return value.trim().replace(/\s+/g, " ") || undefined;
  } catch { return undefined; }
}
export function processAlive(pid: number | undefined, identity?: string): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const current = identity ? processIdentity(pid) : undefined;
  return !identity || !current || identity === current;
}
export const ownerAlive = (owner: RuntimeOwner): boolean => processAlive(owner.pid, owner.processStartedAt) || processAlive(owner.childPid, owner.childStartedAt);

export class LocalRuntimeLease {
  readonly instanceId = randomUUID();
  private acquired = false;
  private readonly identity = processIdentity(process.pid);
  constructor(readonly kind: string, readonly filePath = localRuntimePath(), private readonly legacyPaths: string[] = []) {}

  async claim(): Promise<OwnershipState> {
    try {
      const result: OwnershipState = await updateLocalState(this.filePath, state => {
        const current = state.runtime;
        if (current && current.instanceId !== this.instanceId && ownerAlive(current)) {
          return { status: "conflict", message: CONFLICT_MESSAGE, owner: current };
        }
        for (const file of this.legacyPaths) {
          if (path.resolve(file) === path.resolve(this.filePath)) continue;
          const legacy = readLocalState(file).runtime;
          if (legacy && ownerAlive(legacy)) return { status: "conflict", message: CONFLICT_MESSAGE, owner: legacy };
        }
        state.runtime = current?.instanceId === this.instanceId ? current : {
          instanceId: this.instanceId, kind: this.kind, pid: process.pid,
          ...(this.identity ? { processStartedAt: this.identity } : {}), startedAt: new Date().toISOString(),
        };
        return { status: "owned" };
      });
      this.acquired = result.status === "owned";
      return result;
    } catch (error) { return { status: "error", message: error instanceof Error ? error.message : "无法检查本机 Connector 状态。" }; }
  }

  async require(): Promise<void> {
    const result = await this.claim();
    if (result.status !== "owned") throw new Error(result.message);
  }

  environment(): Record<string, string> {
    return { AA_CONNECTOR_OWNER_INSTANCE: this.instanceId, AA_CONNECTOR_OWNER_PID: String(process.pid), AA_CONNECTOR_OWNER_KIND: this.kind };
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    await updateLocalState(this.filePath, state => {
      if (state.runtime?.instanceId !== this.instanceId) return;
      // Never make a still-running child invisible if shutdown failed.
      if (processAlive(state.runtime.childPid, state.runtime.childStartedAt)) return;
      delete state.runtime;
      this.acquired = false;
    });
  }
}
