export interface ConnectorSettings {
  /** '' follows the system, 'direct' skips any proxy, otherwise a proxy URL. */
  connectorProxy: string
  syncIntervalSeconds: number
}

export const DEFAULT_CONNECTOR_SETTINGS: ConnectorSettings = {
  connectorProxy: '', syncIntervalSeconds: 30,
}

export const SYNC_INTERVALS = [15, 30, 60, 300] as const

export type ConnectorAction = 'start' | 'stop' | 'restart'
export type ConnectorFolder = 'data' | 'logs'
export interface ConnectorManagement {
  settings: ConnectorSettings
  dataPath: string
  logsPath: string
  canOpenFolders: boolean
  deviceName: string | null
  lastError: string | null
}
