"use client"

export type ConnectorStatus = "stopped" | "running" | "error" | "expired credential" | string

export type ConnectorState = {
  platform?: NodeJS.Platform | string
  status: ConnectorStatus
  running: boolean
  pairing: boolean
  authFailed: boolean
  lastError: string | null
  configPath: string
  settingsPath?: string
  hasConfig: boolean
  openAtLogin?: boolean
  startConnectorOnLaunch?: boolean
  uvCommand?: string
  logs?: ConnectorLog[]
}

export type ConnectorConfig = {
  serverUrl: string
  connectorId: string
  connectorToken: string
  heartbeatSeconds?: number
  reconnectSeconds?: number
  syncExistingOnConnect?: boolean
  syncIntervalSeconds?: number
  stateDbPath?: string | null
}

export type ConnectorLog = {
  time?: string
  level?: string
  name?: string
  message?: string
  line?: string
  exception?: string
}

export type PairingState = {
  status: "starting" | "waiting" | "claimed" | "expired" | "consumed" | "cancelled" | "error" | string
  serverUrl?: string
  pairingId?: string
  code?: string
  config?: ConnectorConfig
  error?: string
}

export type DesktopSettings = {
  openAtLogin?: boolean
  startConnectorOnLaunch?: boolean
  uvCommand?: string
}

export type ConnectorDesktopApi = {
  getState: () => Promise<ConnectorState>
  getConfig: () => Promise<ConnectorConfig>
  saveConfig: (config: ConnectorConfig) => Promise<ConnectorConfig>
  start: (config?: ConnectorConfig) => Promise<ConnectorState>
  stop: () => Promise<ConnectorState>
  restart: () => Promise<ConnectorState>
  startPairing: (input: { server: string; timeout?: number; pollInterval?: number }) => Promise<PairingState>
  cancelPairing: () => Promise<PairingState>
  saveSettings: (settings: DesktopSettings) => Promise<ConnectorState>
  openConfigFolder: () => Promise<string>
  onState: (callback: (state: ConnectorState) => void) => () => void
  onLog: (callback: (log: ConnectorLog) => void) => () => void
  onPairing: (callback: (state: PairingState) => void) => () => void
}

declare global {
  interface Window {
    connectorDesktop?: ConnectorDesktopApi
  }
}

export function connectorDesktop(): ConnectorDesktopApi {
  if (!window.connectorDesktop) {
    throw new Error("Connector desktop bridge is not available.")
  }
  return window.connectorDesktop
}

export function logMessage(log: ConnectorLog): string {
  return log.message || log.line || ""
}
