// Shared settings API types will live here. The Connector bridge protocol stays in contracts/dsh-bridge.
export const HOST_NAMESPACE = 'agentsAnywhereOnboarding'
export const OAUTH_CLIENT_ID = 'agents-anywhere-dsh-plugin'

export type DesktopDetection =
  | { status: 'absent'; message: string }
  | { status: 'installed'; message: string; executablePath: string }
  | { status: 'error'; message: string }

export type FlowStage = 'idle' | 'authorizing' | 'pairing' | 'starting' | 'ready' | 'error'

export interface ConnectionSettings {
  apiBaseUrl: string
  webBaseUrl: string
}

/** Public snapshots never contain account or Connector credentials. */
export interface OnboardingSnapshot {
  desktop: DesktopDetection
  settings: ConnectionSettings
  stage: FlowStage
  message: string
  account: { userId: string; displayName: string } | null
  connectorId: string | null
  connectorRunning: boolean
  flowId: string | null
}

export interface OnboardingHostApi {
  inspect(): Promise<OnboardingSnapshot>
  begin(): Promise<{ url: string }>
  configure(settings: ConnectionSettings): Promise<OnboardingSnapshot>
  cancel(): Promise<null>
  logout(): Promise<null>
}
