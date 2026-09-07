import type { ConnectorAction, ConnectorFolder, ConnectorManagement, ConnectorSettings } from './connector.js'
import type { MobileLoginSnapshot } from './mobile.js'

// The Connector bridge protocol stays in contracts/dsh-bridge.
export const HOST_NAMESPACE = 'agentsAnywhereOnboarding'
export const OAUTH_CLIENT_ID = 'agents-anywhere-dsh-plugin'
export const CLOUD_API_BASE_URL = 'https://web.agents-anywhere.com'

export type DesktopDetection =
  | { status: 'absent'; message: string }
  | { status: 'installed'; message: string; executablePath: string }
  | { status: 'error'; message: string }

export type FlowStage = 'idle' | 'authorizing' | 'pairing' | 'starting' | 'ready' | 'error'

export interface ConnectionSettings {
  apiBaseUrl: string
}

export type LoginRequest = { target: 'cloud' } | { target: 'server'; serverUrl: string }
export type DeviceRecoveryAction = 'check' | 'reconnect' | 'recreate'
export type DeviceRecoveryResult = { url: string } | null
export interface DeviceRecovery {
  connectorId: string
  status: 'checking' | 'deleted' | 'disconnected' | 'unavailable' | 'login_required'
  message: string
}

export interface AccountProfile {
  userId: string
  displayName: string
  email?: string | null
  avatar?: string | null
}

/** Public snapshots never contain account or Connector credentials. */
export interface OnboardingSnapshot {
  ownership?: { status: 'owned' | 'conflict' | 'error'; message?: string | undefined } | null
  desktop: DesktopDetection
  settings: ConnectionSettings
  stage: FlowStage
  message: string
  account: AccountProfile | null
  webAppUrl: string
  connectorId: string | null
  connectorRunning: boolean
  deviceRecovery: DeviceRecovery | null
  flowId: string | null
  connector: ConnectorManagement
}

export interface OnboardingHostApi {
  inspect(): Promise<OnboardingSnapshot>
  /** No input resumes the currently configured account; explicit input selects a login target. */
  begin(input?: LoginRequest): Promise<{ url: string }>
  cancel(): Promise<null>
  logout(): Promise<null>
  recoverDevice(action: DeviceRecoveryAction): Promise<DeviceRecoveryResult>
  controlConnector(action: ConnectorAction): Promise<null>
  saveConnectorSettings(settings: ConnectorSettings): Promise<null>
  openConnectorFolder(folder: ConnectorFolder): Promise<null>
  resetConnector(forceLocal: boolean): Promise<null>
  createMobileLogin(): Promise<MobileLoginSnapshot>
  inspectMobileLogin(id: string): Promise<MobileLoginSnapshot>
  confirmMobileLogin(id: string, approved: boolean): Promise<MobileLoginSnapshot>
}
