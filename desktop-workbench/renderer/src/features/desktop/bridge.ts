export type DesktopConnectorStatus =
  | "unconfigured"
  | "stopped"
  | "starting"
  | "online"
  | "reconnecting"
  | "offline"
  | "error"
  | string

export type DesktopConnectorState = {
  platform?: string
  status: DesktopConnectorStatus
  running: boolean
  authFailed: boolean
  lastError: string | null
  hasConfig: boolean
  hasCredential?: boolean
  serverUrl: string
  connectorId: string
  manualDisconnected: boolean
  setupIssue: string
  openAtLogin: boolean
  startConnectorOnLaunch: boolean
  silentLaunch: boolean
  configPath?: string
  runtimePath?: string
  dataPath?: string
  connectorDir?: string
  resolvedUvPath?: string
  uvMissing?: boolean
  uvPath?: string
  logChunkSizeKb?: number
  logRetainChunks?: number
  logRetentionDays?: number
  uvPypiIndexUrl?: string
}

export type DesktopLocalBinding = {
  connectorId: string
  serverUrl: string
  name?: string | null
  ownerUserId?: string | null
  manualDisconnected?: boolean
  hasCredential?: boolean
}

export type DesktopConnectorConfig = {
  serverUrl?: string | null
  connectorId?: string | null
  hasCredential?: boolean
  heartbeatSeconds?: number
  reconnectSeconds?: number
  syncExistingOnConnect?: boolean
  syncIntervalSeconds?: number
  statePath?: string | null
  [key: string]: unknown
}

export type DesktopConnectorLog = {
  id?: string | number
  seq?: number
  timestamp?: string
  time?: string
  level?: string
  message: string
  [key: string]: unknown
}

export type DesktopConnectorLogPage = {
  items: DesktopConnectorLog[]
  firstSeq: number | null
  lastSeq: number | null
  hasMoreBefore: boolean
  total: number
}

export type DesktopConnectorSettings = Partial<Pick<
  DesktopConnectorState,
  | "openAtLogin"
  | "startConnectorOnLaunch"
  | "silentLaunch"
  | "uvPath"
  | "logChunkSizeKb"
  | "logRetainChunks"
  | "logRetentionDays"
  | "uvPypiIndexUrl"
>>

export type DesktopWorkbenchBridge = {
  platform: string
  versions: {
    chrome: string
    electron: string
    node: string
  }
  openExternal: (url: string) => Promise<void>
  device?: {
    createAndConnect: (input: {
      userToken: string
      userId: string
      serverUrl?: string
      name?: string
    }) => Promise<DesktopLocalBinding>
    reconnectAndConnect: (input: {
      userToken: string
      userId: string
      serverUrl?: string
      connectorId?: string
    }) => Promise<DesktopLocalBinding>
    disconnectLocal: (input: {
      userToken: string
      userId: string
      serverUrl?: string
    }) => Promise<DesktopLocalBinding>
    getLocalBinding: () => Promise<DesktopLocalBinding | null>
    updateLocalBindingName: (input: { name: string }) => Promise<DesktopLocalBinding>
  }
  connector?: {
    getState: () => Promise<DesktopConnectorState>
    getConfig: () => Promise<DesktopConnectorConfig | null>
    saveConfig: (config: Record<string, unknown>) => Promise<DesktopConnectorConfig>
    start: () => Promise<DesktopConnectorState>
    stop: () => Promise<DesktopConnectorState>
    restart: () => Promise<DesktopConnectorState>
    getLogs: (options?: { pageSize?: number; beforeSeq?: number; afterSeq?: number }) => Promise<DesktopConnectorLogPage>
    clearLogs: () => Promise<DesktopConnectorLogPage>
    saveSettings: (settings: DesktopConnectorSettings) => Promise<DesktopConnectorState>
    openDataFolder: () => Promise<string>
    openLogsFolder?: () => Promise<string>
    exportLogs?: () => Promise<{ canceled: boolean; filePath: string | null; count: number }>
    factoryReset?: () => Promise<void>
    onState: (listener: (state: DesktopConnectorState) => void) => void | (() => void)
    onLog: (listener: (entry: DesktopConnectorLog) => void) => void | (() => void)
    onLogsCleared: (listener: () => void) => void | (() => void)
  }
}

declare global {
  interface Window {
    desktopWorkbench?: DesktopWorkbenchBridge
  }
}

export function getDesktopWorkbenchBridge(): DesktopWorkbenchBridge | null {
  if (typeof window === "undefined") return null
  return window.desktopWorkbench ?? null
}

export function hasDesktopConnectorBridge(): boolean {
  const bridge = getDesktopWorkbenchBridge()
  return Boolean(bridge?.device && bridge.connector)
}
