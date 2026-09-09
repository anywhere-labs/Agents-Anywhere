/**
 * Contract between the Electron main process (UI shell) and the Desktop backend
 * process.
 *
 * The backend is an independent Node process (`child_process.fork` with
 * `ELECTRON_RUN_AS_NODE=1`) that owns the Connector, its logs, the Desktop
 * settings and local binding stores, and the shared machine-state record. It
 * never touches the window, so a blocked or crashed backend cannot freeze the
 * user interface.
 *
 * Two channels exist on purpose:
 *
 * - Loopback HTTP + SSE carries every renderer-facing operation. The main
 *   process re-exposes it under `/desktop-api` on the app origin, so the
 *   renderer keeps talking to one same-origin endpoint and never sees a port,
 *   a token, or an IPC channel.
 * - The `fork()` IPC channel carries process lifecycle only (ready, shutdown)
 *   plus `netFetch`, which must run in Electron Main because it is the only
 *   place that gets Chromium's proxy and certificate handling.
 */

/** Header every loopback request must carry. The token is per launch. */
export const BACKEND_TOKEN_HEADER = "x-aa-desktop-token";

/** Same-origin prefix the main process proxies to the backend. */
export const BACKEND_API_PREFIX = "/desktop-api";

/** The backend must report ready within this window before startup fails. */
export const BACKEND_READY_TIMEOUT_MS = 20_000;

export type BackendInit = {
  /** `<userData>/connector` */
  dataPath: string;
  /** `<userData>/logs` */
  logsPath: string;
  /** `<userData>/desktop-settings.json` */
  settingsPath: string;
  /** `<dataPath>/desktop-binding.json` */
  bindingPath: string;
  /** `<dataPath>/connector.json` */
  configPath: string;
  connectorDir: string;
  resourcesPath: string;
  /**
   * Directory holding `<platform>-<arch>/uv[.exe]`, the uv that packaging
   * bundles. Development passes its build output so a dev launch runs the exact
   * uv the installer ships instead of whatever is on the developer's PATH.
   */
  uvBundleDir: string;
  homePath: string;
  documentsPath: string;
  packaged: boolean;
  preferredLanguages: readonly string[];
  /** Default server origin and API namespace for device registration. */
  defaultServerUrl: string;
  apiNamespace: string;
  /** This Desktop's own executable and app paths, recorded for discovery. */
  desktopExecutablePath: string;
  desktopAppPath: string;
};

export type BackendControlMessage =
  | { type: "ready"; port: number; token: string }
  | { type: "error"; message: string }
  | {
      type: "netFetch";
      id: number;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }
  | {
      type: "netFetchResult";
      id: number;
      ok: boolean;
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  | { type: "netFetchError"; id: number; message: string }
  | { type: "shutdown" }
  | { type: "shutdownComplete" };

export type BackendEventName = "ownership" | "state" | "logs" | "logsCleared" | "settings";

export type BackendEvent = { event: BackendEventName; data: unknown };

/** Log entries are coalesced for this long before one SSE frame is emitted. */
export const BACKEND_LOG_BATCH_MS = 100;
