import { contextBridge, ipcRenderer } from "electron";
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
  DesktopSettingsPatch,
  PublicLocalDesktopBinding,
} from "./connector-types";

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
