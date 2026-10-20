export type RuntimeLogSource = 'plugin' | 'bridge' | 'connector'
export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RuntimeLogEntry {
  seq: number
  time: string
  source: RuntimeLogSource
  level: RuntimeLogLevel
  name: string
  message: string
  details?: string | null
  exception?: string | null
  method?: string
  outcome?: 'success' | 'failure' | 'pending' | 'info'
}

export interface RuntimeLogQuery {
  source?: RuntimeLogSource | null
  beforeSeq?: number | null
  afterSeq?: number | null
  limit?: number
}

export interface RuntimeLogPage {
  available: boolean
  items: RuntimeLogEntry[]
  firstSeq: number | null
  lastSeq: number | null
  total: number
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  logsPath: string | null
  updatedAt: string
}

export interface ConnectorLogEntry { id: number; time: string; text: string }
export interface ConnectorLogQuery { before?: number; after?: number }
export interface ConnectorLogPage {
  entries: ConnectorLogEntry[]
  hasMore: boolean
  oldestId: number | null
  newestId: number | null
}

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

