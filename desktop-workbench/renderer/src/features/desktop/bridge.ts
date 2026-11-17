/** Mirrors `OwnershipRecovery` in electron/local-runtime.ts. */
export type LocalOwnershipRecovery =
  | { kind: "backendStopped" }
/**
 * Mirrors `ExternalConnector` in electron/local-runtime.ts: a newer Connector
 * (CLI or DSH plugin) that serves this computer instead of Desktop's own.
 */
export type LocalExternalConnector = {
  kind: string
  pid?: number
  version?: string
  connectorId?: string
  serverUrl?: string
  /** Desktop's own Connector handed the machine over to it. */
  handedOver: boolean
}
/**
 * `checking` is the value before the first probe answers. An `error` carries
 * the underlying failure in `message`. `conflict`: a v2 or unknown Connector
 * holds the machine. `external`: a newer Connector serves this computer. The app keeps working
 * through the Server; only local Connector actions are unavailable, and
 * Desktop takes the machine back on its own once that Connector exits.
 */
export type LocalOwnershipState = {
  status: "owned" | "external" | "conflict" | "checking" | "error"
  message?: string
  recovery?: LocalOwnershipRecovery
  external?: LocalExternalConnector
}
import type { DesktopUpdateState } from "../../../../shared/desktop-updates"
export type { DesktopUpdateState } from "../../../../shared/desktop-updates"

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
  /** The device setting the server last handed to this Desktop; change it through the server. */
  confirmQuitOnShutdown?: boolean
  configPath?: string
  runtimePath?: string
  dataPath?: string
  logsPath?: string
  logChunkSizeKb?: number
  logRetainChunks?: number
  logRetentionDays?: number
  connectorProxy?: string
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

export type DesktopConnectorLogSource = "connector" | "bridge"

export type DesktopConnectorLog = {
  id?: string | number
  seq?: number
  timestamp?: string
  time?: string
  level?: string
  name?: string
  source?: DesktopConnectorLogSource | string
  message: string
  details?: string | null
  exception?: string | null
  gapBefore?: boolean
  [key: string]: unknown
}

export type DesktopConnectorLogPage = {
  items: DesktopConnectorLog[]
  firstSeq: number | null
  lastSeq: number | null
  hasMoreBefore: boolean
  hasMoreAfter?: boolean
  total: number
  logsPath?: string
}

export type DesktopConnectorSettings = Partial<Pick<
  DesktopConnectorState,
  | "openAtLogin"
  | "startConnectorOnLaunch"
  | "silentLaunch"
  | "notificationsEnabled"
  | "logChunkSizeKb"
  | "logRetainChunks"
  | "logRetentionDays"
  | "connectorProxy"
>>

export type DesktopConnectorConfigPatch = Partial<Pick<
  DesktopConnectorConfig,
  | "heartbeatSeconds"
  | "reconnectSeconds"
  | "syncExistingOnConnect"
  | "syncIntervalSeconds"
>>

export type DesktopServerConnection = {
  serverUrl: string
  apiNamespace: string
  oauthWebOrigin: string
}

export type DesktopOnboardingOpen = {
  /** Hash route the renderer must open, query included. */
  route: string
  source: "desktop" | "dsh-plugin"
  flowId: string | null
}

export type DesktopWorkbenchBridge = {
  platform: string
  files?: {
    droppedFolderPath: (file: File) => Promise<string | null>
  }
  windowMaterial?: "transparent" | "mica" | "opaque"
  ownership?: {
    getState: () => Promise<LocalOwnershipState>
    recheck: () => Promise<LocalOwnershipState>
    quit: () => Promise<void>
    onState: (listener: (state: LocalOwnershipState) => void) => () => void
  }
  window?: {
    setTheme?: (theme: "light" | "dark" | "system") => Promise<void>
    setTitleBarColors: (colors: { color: string; symbolColor: string }) => Promise<void>
  }
  versions: {
    chrome: string
    electron: string
    node: string
  }
  openExternal: (url: string) => Promise<void>
  updates?: {
    syncSession: (serverUrl: string | null) => Promise<DesktopUpdateState | null>
    getState: () => Promise<DesktopUpdateState | null>
    open: () => Promise<DesktopUpdateState | null>
    ignore: () => Promise<DesktopUpdateState | null>
    download: () => Promise<DesktopUpdateState | null>
    onState: (listener: (state: DesktopUpdateState) => void) => () => void
  }
  auth?: {
    getServer: () => Promise<DesktopServerConnection>
    startOAuth: (input?: { serverUrl?: string }) => Promise<
      | { status: "opened"; authorizeUrl: string }
      | { status: "error"; code: "invalidServer" | "serverUnavailable" | "invalidHealth" | "serverTimeout" | "oauth"; error: string }
    >
    consumeOAuthResult: () => Promise<
      | { status: "success"; accessToken: string; server: DesktopServerConnection }
      | { status: "error"; error: string }
      | null
    >
    onOAuthResult: (listener: () => void) => void | (() => void)
  }
  onboarding?: {
    complete: (source: "desktop" | "dsh-plugin") => Promise<{ completedAt: string | null; source: string | null }>
    /** A plugin deep link that arrived while the app was already running. */
    onOpen: (listener: (entry: DesktopOnboardingOpen) => void) => void | (() => void)
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
    getLogs: (options?: { source?: DesktopConnectorLogSource; pageSize?: number; beforeSeq?: number; afterSeq?: number }) => Promise<DesktopConnectorLogPage>
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
    /** Entries are batched by the backend, so one callback covers many lines. */
    onLog: (listener: (entries: DesktopConnectorLog[]) => void) => void | (() => void)
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
