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
 *   place that gets Chromium's proxy and certificate handling, and the
 *   Connector utility process, which only Main can fork
 *   (`utilityProcess`, v3 design 04-connector.md §9.4).
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
  resourcesPath: string;
  /**
   * The bundled TS Connector's utility-process entry (`dist/connector/desktop-main.js`,
   * built by `yarn bundle:connector`). Main forks it; the backend only asks.
   */
  connectorEntry: string;
  /** The bundled local MeshCall Router, or empty for meshcall's own lookup. */
  routerBinary: string;
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
  /** Backend → Main: fork the Connector utility process with this environment. */
  | { type: "connectorFork"; id: number; env: Record<string, string> }
  /** Backend → Main: a message for the Connector's `parentPort` (`{type: "shutdown"}`). */
  | { type: "connectorPost"; id: number; message: unknown }
  /** Backend → Main: kill the Connector process (it ignored `shutdown`). */
  | { type: "connectorKill"; id: number }
  /** Main → Backend: what the Connector posted (`ready`, `failed`, `stopped`). */
  | { type: "connectorMessage"; id: number; message: unknown }
  /** Main → Backend: one line the Connector wrote to stdout or stderr. */
  | { type: "connectorOutput"; id: number; line: string }
  /** Main → Backend: the process is gone (`code` null when it never started). */
  | { type: "connectorExit"; id: number; code: number | null; error?: string }
  | { type: "shutdown" }
  | { type: "shutdownComplete" };

export type BackendEventName = "ownership" | "state" | "logs" | "logsCleared" | "settings";

export type BackendEvent = { event: BackendEventName; data: unknown };

/** Log entries are coalesced for this long before one SSE frame is emitted. */
export const BACKEND_LOG_BATCH_MS = 100;
