import { isNumericProductVersion } from "./desktop-product-version";
import type {
  DesktopKnownMinimumVersion,
  DesktopUpdateDecision,
  DesktopUpdatePersistedState,
  DesktopUpdateRelease,
} from "./desktop-update-types";
import { readJsonFile, removeFile, writeJsonFile } from "./json-store";

const MAX_KNOWN_MINIMUM_VERSIONS = 32;
const MAX_DECISIONS = 32;

export class DesktopUpdateStore {
  constructor(private readonly filePath: string) {}

  get(
    serverOrigin: string,
    versionCode: number,
    versionName: string,
  ): DesktopUpdateDecision | null {
    return this.read().decisions.find(
      (entry) => entry.serverOrigin === serverOrigin &&
        entry.versionCode === versionCode &&
        entry.versionName === versionName,
    ) ?? null;
  }

  save(
    release: DesktopUpdateRelease,
    decision: DesktopUpdateDecision["decision"],
    serverOrigin: string,
    decidedAt = new Date().toISOString(),
  ): DesktopUpdateDecision {
    const value = normalizeDecision({
      serverOrigin,
      versionCode: release.versionCode,
      versionName: release.versionName,
      decision,
      decidedAt,
    });
    if (!value) throw new Error("The Desktop update decision is invalid.");
    const state = this.read();
    const decisions = state.decisions
      .filter((entry) => !sameRelease(entry, value))
      .concat(value)
      .slice(-MAX_DECISIONS);
    this.write({ ...state, decisions });
    return value;
  }

  getKnownMinimum(serverOrigin: string): DesktopKnownMinimumVersion | null {
    return this.read().knownMinimumVersions.find(
      (entry) => entry.serverOrigin === serverOrigin,
    ) ?? null;
  }

  saveKnownMinimum(
    serverOrigin: string,
    version: string,
    confirmedAt = new Date().toISOString(),
  ): DesktopKnownMinimumVersion {
    const value = normalizeKnownMinimum({ serverOrigin, version, confirmedAt });
    if (!value) throw new Error("The Desktop known minimum version is invalid.");
    const state = this.read();
    const knownMinimumVersions = state.knownMinimumVersions
      .filter((entry) => entry.serverOrigin !== serverOrigin)
      .concat(value)
      .slice(-MAX_KNOWN_MINIMUM_VERSIONS);
    this.write({ ...state, knownMinimumVersions });
    return value;
  }

  clearKnownMinimum(serverOrigin: string): void {
    const state = this.read();
    this.write({
      ...state,
      knownMinimumVersions: state.knownMinimumVersions.filter(
        (entry) => entry.serverOrigin !== serverOrigin,
      ),
    });
  }

  clear(): void {
    removeFile(this.filePath);
  }

  private read(): DesktopUpdatePersistedState {
    return normalizePersistedState(readJsonFile<unknown>(this.filePath, null));
  }

  private write(state: DesktopUpdatePersistedState): void {
    writeJsonFile(this.filePath, state);
  }
}

function normalizePersistedState(value: unknown): DesktopUpdatePersistedState {
  if (!value || typeof value !== "object") return emptyState();
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      decisions: normalizeDecisions(candidate.decisions ?? candidate.decision),
      knownMinimumVersions: normalizeKnownMinimumVersions(candidate.knownMinimumVersions),
    };
  }
  if (candidate.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      decisions: normalizeDecisions(candidate),
      knownMinimumVersions: [],
    };
  }
  return emptyState();
}

function emptyState(): DesktopUpdatePersistedState {
  return { schemaVersion: 2, decisions: [], knownMinimumVersions: [] };
}

function normalizeDecisions(value: unknown): DesktopUpdateDecision[] {
  const candidates = Array.isArray(value) ? value : [value];
  const decisions: DesktopUpdateDecision[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeDecision(candidate);
    if (!normalized) continue;
    const previousIndex = decisions.findIndex((entry) => sameRelease(entry, normalized));
    if (previousIndex >= 0) decisions.splice(previousIndex, 1);
    decisions.push(normalized);
  }
  return decisions.slice(-MAX_DECISIONS);
}

function normalizeKnownMinimumVersions(value: unknown): DesktopKnownMinimumVersion[] {
  if (!Array.isArray(value)) return [];
  const byOrigin = new Map<string, DesktopKnownMinimumVersion>();
  for (const candidate of value) {
    const normalized = normalizeKnownMinimum(candidate);
    if (normalized) byOrigin.set(normalized.serverOrigin, normalized);
  }
  return Array.from(byOrigin.values()).slice(-MAX_KNOWN_MINIMUM_VERSIONS);
}

function normalizeKnownMinimum(value: unknown): DesktopKnownMinimumVersion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DesktopKnownMinimumVersion>;
  if (
    typeof candidate.serverOrigin !== "string" ||
    !isCanonicalHttpOrigin(candidate.serverOrigin) ||
    typeof candidate.version !== "string" ||
    !isNumericProductVersion(candidate.version) ||
    typeof candidate.confirmedAt !== "string" ||
    !candidate.confirmedAt.trim()
  ) {
    return null;
  }
  return {
    serverOrigin: candidate.serverOrigin,
    version: candidate.version.trim(),
    confirmedAt: candidate.confirmedAt,
  };
}

function normalizeDecision(value: unknown): DesktopUpdateDecision | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DesktopUpdateDecision>;
  if (
    typeof candidate.serverOrigin !== "string" ||
    !isCanonicalHttpOrigin(candidate.serverOrigin) ||
    !Number.isSafeInteger(candidate.versionCode) ||
    Number(candidate.versionCode) < 1 ||
    typeof candidate.versionName !== "string" ||
    !isNumericProductVersion(candidate.versionName) ||
    (candidate.decision !== "accepted" && candidate.decision !== "declined") ||
    typeof candidate.decidedAt !== "string" ||
    !candidate.decidedAt.trim()
  ) {
    return null;
  }
  return {
    serverOrigin: candidate.serverOrigin,
    versionCode: Number(candidate.versionCode),
    versionName: candidate.versionName.trim(),
    decision: candidate.decision,
    decidedAt: candidate.decidedAt,
  };
}

function sameRelease(left: DesktopUpdateDecision, right: DesktopUpdateDecision): boolean {
  return left.serverOrigin === right.serverOrigin &&
    left.versionCode === right.versionCode &&
    left.versionName === right.versionName;
}

function isCanonicalHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      value === url.origin;
  } catch {
    return false;
  }
}
