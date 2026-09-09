import { windowMaterial } from "./window-material";
import type { OwnershipState } from "./local-runtime";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState } from "../shared/desktop-updates";
import { BACKEND_API_PREFIX, BACKEND_TOKEN_HEADER } from "./backend/protocol";
import type {
  ConnectorConfigPatch,
  ConnectorLogEntry,
  ConnectorLogPage,
  ConnectorLogQuery,
  ConnectorPublicConfig,
  ConnectorState,
  DesktopDeviceAuthInput,
  DesktopFactoryResetInput,
  DesktopDeviceNameInput,
  DesktopDeviceProvisionInput,
  DesktopDeviceReconnectInput,
  DesktopNotificationInput,
  DesktopNotificationResult,
  DesktopSettingsPatch,
  PublicLocalDesktopBinding,
} from "./connector-types";
import type { DesktopOAuthResult } from "./desktop-oauth";
import type { DesktopOnboardingEntry } from "./desktop-onboarding";
import type { DesktopOAuthStartResult, DesktopServerConnection } from "./desktop-server";

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * Connector and device state live in the backend process and are reached over
 * the same-origin `/desktop-api` proxy. Native shell concerns (window, updates,
 * notifications, OAuth, dialogs) stay on IPC.
 *
 * Packaged builds always load the renderer from the app's own scheme, so the
 * relative prefix works. The development renderer is served over HTTP by the
 * Next dev server, where no such proxy exists, so it asks Main for the loopback
 * origin and the per-launch token instead.
 */
type ApiTarget = { base: string; token: string };
const WORKBENCH_SCHEME = "aa-workbench:";
let devTarget: Promise<ApiTarget> | null = null;

function apiTarget(): Promise<ApiTarget> {
  if (typeof location !== "undefined" && location.protocol === WORKBENCH_SCHEME) {
    return Promise.resolve({ base: BACKEND_API_PREFIX, token: "" });
  }
  devTarget ??= ipcRenderer
    .invoke("workbench:backend:endpoint")
    .then((value: { baseUrl?: string; token?: string } | null) => value?.baseUrl
      ? { base: value.baseUrl, token: value.token ?? "" }
      : { base: BACKEND_API_PREFIX, token: "" })
    .catch(() => ({ base: BACKEND_API_PREFIX, token: "" }));
  return devTarget;
}

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const target = await apiTarget();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (target.token) headers.set(BACKEND_TOKEN_HEADER, target.token);
  const response = await fetch(`${target.base}${route}`, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : `桌面端服务请求失败（HTTP ${response.status}）。`;
    throw new Error(message);
  }
  return payload as T;
}

type EventFrame = { event: string; data: unknown };
const eventListeners = new Set<(frame: EventFrame) => void>();
let streamController: AbortController | null = null;

function ensureEventStream(): void {
  if (streamController) return;
  const controller = new AbortController();
  streamController = controller;
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const target = await apiTarget();
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (target.token) headers[BACKEND_TOKEN_HEADER] = target.token;
        const response = await fetch(`${target.base}/events`, { headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = parseFrame(buffer.slice(0, boundary));
            if (frame) for (const listener of eventListeners) listener(frame);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // The backend restarts with the app; reconnect below.
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  })();
}

function parseFrame(frame: string): EventFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) as unknown };
  } catch {
    return null;
  }
}

function onEvent(name: string, listener: (data: unknown) => void): () => void {
  const wrapper = (frame: EventFrame) => { if (frame.event === name) listener(frame.data); };
  eventListeners.add(wrapper);
  ensureEventStream();
  return () => { eventListeners.delete(wrapper); };
}

contextBridge.exposeInMainWorld("desktopWorkbench", {
  platform: process.platform,
  windowMaterial: windowMaterial(),
  window: {
    setTheme: (theme: "light" | "dark"): Promise<void> => ipcRenderer.invoke("workbench:window:setTheme", theme),
    setTitleBarColors: (colors: { color: string; symbolColor: string }): Promise<void> =>
      ipcRenderer.invoke("workbench:window:setTitleBarColors", colors),
  },
  ownership: {
    getState: (): Promise<OwnershipState> => ipcRenderer.invoke("workbench:ownership:getState"),
    recheck: (): Promise<OwnershipState> => ipcRenderer.invoke("workbench:ownership:recheck"),
    quit: (): Promise<void> => ipcRenderer.invoke("workbench:ownership:quit"),
    onState: (callback: (state: OwnershipState) => void): (() => void) => subscribe("workbench:ownership:state", callback),
  },
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("workbench:openExternal", url),
  updates: {
    syncSession: (serverUrl: string | null): Promise<DesktopUpdateState | null> => ipcRenderer.invoke("workbench:updates:syncSession", serverUrl),
    getState: (): Promise<DesktopUpdateState | null> => ipcRenderer.invoke("workbench:updates:getState"),
    open: (): Promise<DesktopUpdateState | null> => ipcRenderer.invoke("workbench:updates:open"),
    ignore: (): Promise<DesktopUpdateState | null> => ipcRenderer.invoke("workbench:updates:ignore"),
    download: (): Promise<DesktopUpdateState | null> => ipcRenderer.invoke("workbench:updates:download"),
    onState: (callback: (state: DesktopUpdateState) => void): (() => void) => subscribe("workbench:updates:state", callback),
  },
  auth: {
    getServer: (): Promise<DesktopServerConnection> => ipcRenderer.invoke("workbench:auth:getServer"),
    startOAuth: (input?: { serverUrl?: string }): Promise<DesktopOAuthStartResult> =>
      ipcRenderer.invoke("workbench:auth:startOAuth", input),
    consumeOAuthResult: (): Promise<DesktopOAuthResult | null> =>
      ipcRenderer.invoke("workbench:auth:consumeOAuthResult"),
    onOAuthResult: (callback: () => void): (() => void) =>
      subscribe("workbench:auth:oauthResultReady", callback),
  },
  onboarding: {
    /** Recorded only from the complete page; a later user launch then skips the flow. */
    complete: (source: DesktopOnboardingEntry["source"]): Promise<{ completedAt: string | null; source: string | null }> =>
      ipcRenderer.invoke("workbench:onboarding:complete", { source }),
    onOpen: (callback: (entry: Omit<DesktopOnboardingEntry, "key">) => void): (() => void) =>
      subscribe("workbench:onboarding:open", callback),
  },
  notifications: {
    show: (input: DesktopNotificationInput): Promise<DesktopNotificationResult> =>
      ipcRenderer.invoke("workbench:notifications:show", input),
    onClick: (callback: (input: { sessionId?: string }) => void): (() => void) =>
      subscribe("workbench:notifications:click", callback),
  },
  connector: {
    getState: (): Promise<ConnectorState> => api<ConnectorState>("/state"),
    getConfig: (): Promise<ConnectorPublicConfig> => api<ConnectorPublicConfig>("/config"),
    saveConfig: (patch: ConnectorConfigPatch): Promise<ConnectorState> =>
      api<ConnectorState>("/config", { method: "POST", body: JSON.stringify(patch ?? {}) }),
    start: (): Promise<ConnectorState> => api<ConnectorState>("/start", { method: "POST", body: "{}" }),
    stop: (): Promise<ConnectorState> => api<ConnectorState>("/stop", { method: "POST", body: "{}" }),
    restart: (): Promise<ConnectorState> => api<ConnectorState>("/restart", { method: "POST", body: "{}" }),
    getLogs: (query?: ConnectorLogQuery): Promise<ConnectorLogPage> => {
      const search = new URLSearchParams();
      if (query?.pageSize !== undefined) search.set("pageSize", String(query.pageSize));
      if (query?.beforeSeq !== undefined) search.set("beforeSeq", String(query.beforeSeq));
      if (query?.afterSeq !== undefined) search.set("afterSeq", String(query.afterSeq));
      const suffix = search.size > 0 ? `?${search.toString()}` : "";
      return api<ConnectorLogPage>(`/logs${suffix}`);
    },
    clearLogs: (): Promise<ConnectorLogPage> => api<ConnectorLogPage>("/logs/clear", { method: "POST", body: "{}" }),
    saveSettings: (patch: DesktopSettingsPatch): Promise<ConnectorState> =>
      api<ConnectorState>("/settings", { method: "POST", body: JSON.stringify(patch ?? {}) }),
    openDataFolder: (): Promise<string> => ipcRenderer.invoke("workbench:connector:openDataFolder"),
    openLogsFolder: (): Promise<string> => ipcRenderer.invoke("workbench:connector:openLogsFolder"),
    exportLogs: (): Promise<{ canceled: boolean; filePath: string | null; count: number }> =>
      ipcRenderer.invoke("workbench:connector:exportLogs"),
    factoryReset: (input: DesktopFactoryResetInput): Promise<void> =>
      ipcRenderer.invoke("workbench:connector:factoryReset", input),
    onState: (callback: (state: ConnectorState) => void): (() => void) =>
      onEvent("state", (data) => callback(data as ConnectorState)),
    /** Entries arrive pre-batched so the renderer re-renders once per batch. */
    onLog: (callback: (entries: ConnectorLogEntry[]) => void): (() => void) =>
      onEvent("logs", (data) => callback(Array.isArray(data) ? data as ConnectorLogEntry[] : [data as ConnectorLogEntry])),
    onLogsCleared: (callback: () => void): (() => void) => onEvent("logsCleared", () => callback()),
  },
  device: {
    createAndConnect: (input: DesktopDeviceProvisionInput): Promise<PublicLocalDesktopBinding> =>
      api<PublicLocalDesktopBinding>("/device/create", { method: "POST", body: JSON.stringify(input) }),
    reconnectAndConnect: (input: DesktopDeviceReconnectInput): Promise<PublicLocalDesktopBinding> =>
      api<PublicLocalDesktopBinding>("/device/reconnect", { method: "POST", body: JSON.stringify(input) }),
    disconnectLocal: (input: DesktopDeviceAuthInput): Promise<PublicLocalDesktopBinding> =>
      api<PublicLocalDesktopBinding>("/device/disconnect", { method: "POST", body: JSON.stringify(input) }),
    getLocalBinding: (): Promise<PublicLocalDesktopBinding | null> =>
      api<PublicLocalDesktopBinding | null>("/device/binding"),
    updateLocalBindingName: (input: DesktopDeviceNameInput): Promise<PublicLocalDesktopBinding> =>
      api<PublicLocalDesktopBinding>("/device/rename", { method: "POST", body: JSON.stringify({ name: input?.name ?? "" }) }),
  },
});
