export interface BridgeLogEntry {
  id?: string
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  details: string
  method?: string
  outcome?: 'success' | 'failure' | 'pending' | 'info'
}

export interface BridgeLogSnapshot {
  entries: BridgeLogEntry[]
  updatedAt: string
}
