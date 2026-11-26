// Contract between the main process, the preload bridge and the renderer (`window.aaDesktop`).
// The renderer side of these types lives in `web-v3/lib/platform/desktop.ts`; keep the two in sync.

export const IPC = {
  secureAvailable: "aa:secure:available",
  secureGet: "aa:secure:get",
  secureSet: "aa:secure:set",
  secureDelete: "aa:secure:delete",
  connectorStatus: "aa:connector:status",
  connectorStart: "aa:connector:start",
  connectorStop: "aa:connector:stop",
  connectorRegister: "aa:connector:register",
  connectorPair: "aa:connector:pair",
  connectorLogs: "aa:connector:logs",
  connectorStatusEvent: "aa:connector:status-event",
  settingsGet: "aa:settings:get",
  settingsSetControlUrl: "aa:settings:set-control-url",
  openExternal: "aa:open-external",
} as const;

export type DeviceMode = "normal" | "encrypted";

export type ProcessState = "stopped" | "starting" | "running" | "backoff" | "failed";

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  restarts: number;
  lastExitCode: number | null;
  lastError: string | null;
}

export interface ConnectorStatus {
  registered: boolean;
  deviceId: string | null;
  deviceName: string | null;
  mode: DeviceMode | null;
  controlUrl: string | null;
  connector: ProcessStatus;
  localRouter: { url: string; httpUrl: string } | null;
  runtimes: { id: string; name: string }[];
  dataDir: string;
  logFile: string;
}

export interface RegisterInput {
  /** Control plane URL as the renderer knows it: absolute, or the app-relative `/api/control`. */
  controlUrl: string;
  accessToken: string;
  name: string;
  mode: DeviceMode;
}

export interface PairResult {
  uri: string;
  expires_at: string;
  /** SVG markup of a QR code for `uri`, rendered locally (the pairing secret never leaves this machine). */
  qr_svg: string;
}

export interface DesktopSettings {
  controlUrl: string;
}
