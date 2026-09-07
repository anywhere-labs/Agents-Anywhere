export type DesktopUpdateError = "checkFailed" | "downloadNotConfigured" | "downloadFailed" | "openFailed" | "ignoreFailed";

export type DesktopUpdateState = {
  revision: number;
  currentVersion: string;
  latestVersion: string | null;
  checking: boolean;
  available: boolean;
  ignored: boolean;
  dialogOpen: boolean;
  phase: "idle" | "downloading" | "opening" | "downloaded";
  downloadedBytes: number;
  totalBytes: number | null;
  error: DesktopUpdateError | null;
};
