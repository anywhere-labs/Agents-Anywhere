export interface BridgeLogEntry {
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  details: string
}

export interface BridgeLogSnapshot {
  entries: BridgeLogEntry[]
  updatedAt: string
}
