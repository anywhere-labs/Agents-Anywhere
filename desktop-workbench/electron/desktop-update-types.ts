export type DesktopUpdatePhase =
  | "checking-health"
  | "ready"
  | "force-required"
  | "checking-update"
  | "available"
  | "deferred"
  | "downloading"
  | "opening-installer"
  | "installer-opened";

export type DesktopUpdateErrorCode =
  | "required-update-unavailable"
  | "check-failed"
  | "invalid-download"
  | "download-failed"
  | "open-failed";

export type DesktopUpdateRelease = {
  versionCode: number;
  versionName: string;
  downloadUrl: string;
};

export type DesktopUpdateProgress = {
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

export type DesktopUpdateSnapshot = {
  supported: boolean;
  currentVersion: string;
  currentVersionCode: number;
  serverVersion: string | null;
  phase: DesktopUpdatePhase;
  forced: boolean;
  release: DesktopUpdateRelease | null;
  progress: DesktopUpdateProgress | null;
  errorCode: DesktopUpdateErrorCode | null;
};

export type DesktopUpdateDecision = {
  serverOrigin: string;
  versionCode: number;
  versionName: string;
  decision: "accepted" | "declined";
  decidedAt: string;
};

export type DesktopKnownMinimumVersion = {
  serverOrigin: string;
  version: string;
  confirmedAt: string;
};

export type DesktopUpdatePersistedState = {
  schemaVersion: 2;
  decisions: DesktopUpdateDecision[];
  knownMinimumVersions: DesktopKnownMinimumVersion[];
};
