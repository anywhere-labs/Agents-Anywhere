// Read-only view. Python Connector owns migration, identity history and runtime ownership.
import fs from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";

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

/** Read legacy metadata without migrating or rewriting it from a host process. */
export function readMachineStateFile(file: string): LocalState {
  const state = readLocalState(file);
  if (state.legacyMachineMigrated === true) return state;
  const legacyRoot = path.join(path.dirname(path.dirname(file)), ".agentsanywhere");
  const machine = readJson(path.join(legacyRoot, "machine.json"));
  const installation = readJson(path.join(legacyRoot, "desktop", "install.json"));
  if (machine && machine.version !== 1) throw new Error("Unsupported legacy machine record version.");
  if (installation && installation.version !== 1) throw new Error("Unsupported legacy installation record version.");
  return {
    ...machine, ...state,
    connectorIds: ids([...ids(machine?.connectorIds), ...state.connectorIds]),
    ...(state.desktop === undefined && (machine?.desktop || installation)
      ? { desktop: machine?.desktop ?? installation } : {}),
  };
}
