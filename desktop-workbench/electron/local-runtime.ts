// Read-only view. The Connector owns migration, identity history and runtime ownership.
import fs from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";

export type RuntimeOwner = {
  instanceId: string; kind: string; pid: number; processStartedAt?: string;
  childPid?: number; childStartedAt?: string;
  connectorId?: string; serverUrl?: string; startedAt: string;
  /** v3: the owner's Connector version (version arbitration, 04-connector.md §9.1). */
  connectorVersion?: string;
};
export type LocalState = Record<string, unknown> & { version: 2; connectorIds: string[]; runtime?: RuntimeOwner };
/**
 * What the gate can offer besides a recheck. `backendStopped`: the Desktop
 * backend process is gone and a recheck starts it again.
 */
export type OwnershipRecovery =
  | { kind: "backendStopped" };
/**
 * A newer Connector (CLI or DSH plugin) that serves this computer instead of
 * Desktop's own (v3 design 04-connector.md §9.1, contracts/local-machine 2.0
 * "版本交接"). Only what Desktop could learn without its control channel: the
 * lease record and the handover rendezvous the owner publishes.
 */
export type ExternalConnector = {
  /** `cli`, `dsh-plugin`, ...; empty when unknown. */
  kind: string;
  pid?: number;
  /** The owner's Connector version; absent when it could not be read. */
  version?: string;
  /** The device the owner connects; absent when its record does not say. */
  connectorId?: string;
  serverUrl?: string;
  /** Desktop's own Connector handed the machine over to it (rather than finding it at launch). */
  handedOver: boolean;
};
/**
 * `checking` is the value before the first probe answers. An `error` carries
 * the underlying failure in `message`, which the renderer quotes. `external`:
 * a newer Connector serves this computer; Desktop works through the Server
 * and takes the machine back once that Connector exits. `conflict`: a v2 or
 * unknown Connector holds the machine and Desktop cannot coexist with it.
 */
export type OwnershipState = {
  status: "owned" | "external" | "conflict" | "checking" | "error";
  message?: string;
  owner?: RuntimeOwner;
  recovery?: OwnershipRecovery;
  external?: ExternalConnector;
};
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

/** The lease owner the shared record names; `undefined` when there is none, `null` when the record cannot be read. */
export function readRuntimeOwner(home: string): RuntimeOwner | undefined | null {
  try {
    return readLocalState(localRuntimePath(home)).runtime;
  } catch {
    return null;
  }
}

/**
 * The version a v3 owner publishes next to its handover key
 * (`~/.agents-anywhere/router/<instanceId>.handover.json`, contracts/local-machine 2.0).
 * Only the version is read; the key is not Desktop's to use.
 */
export function readHandoverVersion(home: string, instanceId: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(instanceId)) return undefined;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(home, ".agents-anywhere", "router", `${instanceId}.handover.json`), "utf8"));
    const version = object(value) ? value.connectorVersion : undefined;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process with this pid exists (a pid owned by another user counts). */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
