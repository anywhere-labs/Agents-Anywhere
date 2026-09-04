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
  notificationsEnabled: boolean
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
  | "notificationsEnabled"
  | "uvPath"
  | "logChunkSizeKb"
  | "logRetainChunks"
  | "logRetentionDays"
  | "uvPypiIndexUrl"
>>

export type DesktopUpdatePhase =
  | "checking-health"
  | "ready"
  | "force-required"
  | "checking-update"
  | "available"
  | "deferred"
  | "downloading"
  | "opening-installer"
  | "installer-opened"

export type DesktopUpdateErrorCode =
  | "required-update-unavailable"
  | "check-failed"
  | "invalid-download"
  | "download-failed"
  | "open-failed"

export type DesktopUpdateSnapshot = {
  supported: boolean
  currentVersion: string
  currentVersionCode: number
  serverVersion: string | null
  phase: DesktopUpdatePhase
  forced: boolean
  release: {
    versionCode: number
    versionName: string
    downloadUrl: string
  } | null
  progress: {
    receivedBytes: number
    totalBytes: number | null
    percent: number | null
  } | null
  errorCode: DesktopUpdateErrorCode | null
}

export type DesktopConnectorConfigPatch = Partial<Pick<
  DesktopConnectorConfig,
  | "heartbeatSeconds"
  | "reconnectSeconds"
  | "syncExistingOnConnect"
  | "syncIntervalSeconds"
>>

export type DesktopWorkbenchBridge = {
  platform: string
  versions: {
    chrome: string
    electron: string
    node: string
  }
  openExternal: (url: string) => Promise<void>
  lifecycle?: {
    onBeforeQuit: (listener: () => void | Promise<void>) => () => void
    trackTerminal?: (input: { connectorId: string; terminalId: string; userId: string; token: string }) => Promise<void>
    closeTerminal?: (input: { connectorId: string; terminalId: string }) => Promise<{ handled: boolean }>
    untrackTerminal?: (input: { connectorId: string; terminalId: string }) => Promise<void>
    updateTerminalAuth?: (input: { userId: string; token: string }) => Promise<void>
  }
  development?: {
    clearCache: () => Promise<void>
  }
  updates?: {
    getState: () => Promise<DesktopUpdateSnapshot>
    checkNow: () => Promise<DesktopUpdateSnapshot>
    install: () => Promise<DesktopUpdateSnapshot>
    defer: () => Promise<DesktopUpdateSnapshot>
    onState: (listener: (state: DesktopUpdateSnapshot) => void) => void | (() => void)
  }
  notifications?: {
    show: (input: {
      title: string
      body: string
      sessionId?: string
    }) => Promise<{
      shown: boolean
      reason?: "disabled" | "unsupported" | "invalid"
    }>
    onClick: (listener: (input: { sessionId?: string }) => void) => void | (() => void)
  }
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
    saveConfig: (config: DesktopConnectorConfigPatch) => Promise<DesktopConnectorState>
    start: () => Promise<DesktopConnectorState>
    stop: () => Promise<DesktopConnectorState>
    restart: () => Promise<DesktopConnectorState>
    getLogs: (options?: { pageSize?: number; beforeSeq?: number; afterSeq?: number }) => Promise<DesktopConnectorLogPage>
    clearLogs: () => Promise<DesktopConnectorLogPage>
    saveSettings: (settings: DesktopConnectorSettings) => Promise<DesktopConnectorState>
    openDataFolder: () => Promise<string>
    openLogsFolder?: () => Promise<string>
    exportLogs?: () => Promise<{ canceled: boolean; filePath: string | null; count: number }>
    factoryReset?: (input:
      | {
          userToken: string
          userId: string
          serverUrl?: string
          forceLocal?: false
        }
      | {
          userToken?: string
          userId?: string
          serverUrl?: string
          forceLocal: true
        }
    ) => Promise<void>
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
