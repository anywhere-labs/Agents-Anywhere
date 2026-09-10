export interface BridgeStatus {
  state: 'starting' | 'ready' | 'failed' | 'unavailable'
  message: string
  hint: string
  canRetry: boolean
  code?: string
}
