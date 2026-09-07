import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState } from "../shared/desktop-updates";
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
import type { DesktopOAuthStartResult, DesktopServerConnection } from "./desktop-server";

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("desktopWorkbench", {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("workbench:openExternal", url),
  updates: {
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
  development: {
    clearCache: (): Promise<void> => ipcRenderer.invoke("workbench:development:clearCache"),
  },
  notifications: {
    show: (input: DesktopNotificationInput): Promise<DesktopNotificationResult> =>
      ipcRenderer.invoke("workbench:notifications:show", input),
    onClick: (callback: (input: { sessionId?: string }) => void): (() => void) =>
      subscribe("workbench:notifications:click", callback),
  },
  connector: {
    getState: (): Promise<ConnectorState> => ipcRenderer.invoke("workbench:connector:getState"),
    getConfig: (): Promise<ConnectorPublicConfig> => ipcRenderer.invoke("workbench:connector:getConfig"),
    saveConfig: (patch: ConnectorConfigPatch): Promise<ConnectorState> =>
      ipcRenderer.invoke("workbench:connector:saveConfig", patch),
    start: (): Promise<ConnectorState> => ipcRenderer.invoke("workbench:connector:start"),
    stop: (): Promise<ConnectorState> => ipcRenderer.invoke("workbench:connector:stop"),
    restart: (): Promise<ConnectorState> => ipcRenderer.invoke("workbench:connector:restart"),
    getLogs: (query?: ConnectorLogQuery): Promise<ConnectorLogPage> =>
      ipcRenderer.invoke("workbench:connector:getLogs", query),
    clearLogs: (): Promise<ConnectorLogPage> => ipcRenderer.invoke("workbench:connector:clearLogs"),
    saveSettings: (patch: DesktopSettingsPatch): Promise<ConnectorState> =>
      ipcRenderer.invoke("workbench:connector:saveSettings", patch),
    openDataFolder: (): Promise<string> => ipcRenderer.invoke("workbench:connector:openDataFolder"),
    openLogsFolder: (): Promise<string> => ipcRenderer.invoke("workbench:connector:openLogsFolder"),
    exportLogs: (): Promise<{ canceled: boolean; filePath: string | null; count: number }> =>
      ipcRenderer.invoke("workbench:connector:exportLogs"),
    factoryReset: (input: DesktopFactoryResetInput): Promise<void> =>
      ipcRenderer.invoke("workbench:connector:factoryReset", input),
    onState: (callback: (state: ConnectorState) => void): (() => void) =>
      subscribe("workbench:connector:state", callback),
    onLog: (callback: (entry: ConnectorLogEntry) => void): (() => void) =>
      subscribe("workbench:connector:log", callback),
    onLogsCleared: (callback: () => void): (() => void) =>
      subscribe("workbench:connector:logsCleared", callback),
  },
  device: {
    createAndConnect: (input: DesktopDeviceProvisionInput): Promise<PublicLocalDesktopBinding> =>
      ipcRenderer.invoke("workbench:device:createAndConnect", input),
    reconnectAndConnect: (input: DesktopDeviceReconnectInput): Promise<PublicLocalDesktopBinding> =>
      ipcRenderer.invoke("workbench:device:reconnectAndConnect", input),
    disconnectLocal: (input: DesktopDeviceAuthInput): Promise<PublicLocalDesktopBinding> =>
      ipcRenderer.invoke("workbench:device:disconnectLocal", input),
    getLocalBinding: (): Promise<PublicLocalDesktopBinding | null> =>
      ipcRenderer.invoke("workbench:device:getLocalBinding"),
    updateLocalBindingName: (input: DesktopDeviceNameInput): Promise<PublicLocalDesktopBinding> =>
      ipcRenderer.invoke("workbench:device:updateLocalBindingName", input),
  },
});
