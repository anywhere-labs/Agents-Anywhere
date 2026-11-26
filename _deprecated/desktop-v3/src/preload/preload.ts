// Preload: the only bridge between the bundled workbench and the main process (`window.aaDesktop`).
// Keep it minimal and typed; the renderer-side types are in `web-v3/lib/platform/desktop.ts`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { ConnectorStatus, DesktopSettings, PairResult, RegisterInput } from "../shared/bridge";

// A sandboxed preload cannot require local modules, so the channel names are repeated here
// (`tests/preload.test.ts` checks them against `src/shared/bridge.ts`).
const IPC = {
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

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const bridge = {
  version: process.versions.electron ? `electron-${process.versions.electron}` : "unknown",
  platform: process.platform,
  secureStore: {
    available: () => invoke<boolean>(IPC.secureAvailable),
    get: (key: string) => invoke<string | null>(IPC.secureGet, key),
    set: (key: string, value: string) => invoke<void>(IPC.secureSet, key, value),
    delete: (key: string) => invoke<void>(IPC.secureDelete, key),
  },
  connector: {
    status: () => invoke<ConnectorStatus>(IPC.connectorStatus),
    start: () => invoke<ConnectorStatus>(IPC.connectorStart),
    stop: () => invoke<ConnectorStatus>(IPC.connectorStop),
    register: (input: RegisterInput) => invoke<ConnectorStatus>(IPC.connectorRegister, input),
    pair: (input?: { label?: string; ttlSeconds?: number }) => invoke<PairResult>(IPC.connectorPair, input ?? {}),
    logs: (lines?: number) => invoke<string>(IPC.connectorLogs, lines),
    onStatus: (listener: (status: ConnectorStatus) => void) => {
      const wrapped = (_event: IpcRendererEvent, status: ConnectorStatus) => listener(status);
      ipcRenderer.on(IPC.connectorStatusEvent, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC.connectorStatusEvent, wrapped);
      };
    },
  },
  settings: {
    get: () => invoke<DesktopSettings>(IPC.settingsGet),
    setControlUrl: (url: string) => invoke<DesktopSettings>(IPC.settingsSetControlUrl, url),
  },
  openExternal: (url: string) => invoke<void>(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld("aaDesktop", Object.freeze(bridge));
