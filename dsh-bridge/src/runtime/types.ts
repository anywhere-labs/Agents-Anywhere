import type { ModelSelection } from '@deepseek-ai/dsh-agent'

export type RuntimeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'stopping'
  | 'waiting_approval'
  | 'blocked'
  | 'error'
  | 'disconnected'

export interface Capability {
  capabilityId: string
  scope: 'runtime' | 'session'
  runtime: 'dsh'
  sessionId?: string
  supported: boolean
  available: boolean
  allowed: boolean
  unavailableReason?: string
}

export interface ReasoningCatalogItem {
  id: string
  title: string
  selectionId: string
  enabled: boolean
  description?: string
}

export interface ModelCatalogItem {
  id: string
  title: string
  selectionId: string
  enabled: boolean
  reasoningItems: ReasoningCatalogItem[]
  description?: string
  disabledReason?: string
  metadata: Record<string, unknown>
}

export interface PermissionCatalogItem {
  id: string
  title: string
  selectionId: string
  enabled: boolean
  description?: string
  disabledReason?: string
  metadata: { preset: string }
}

export interface SessionState {
  sessionId: string
  externalSessionId: string
  runtime: 'dsh'
  status: RuntimeStatus
  selections: { model: string; permission: string }
  revision: number
  statusReason?: string
  error?: { code: string; message: string }
}

export interface TimelineItem {
  id: string
  sessionId: string
  type: 'message' | 'tool' | 'artifact' | 'marker' | 'system' | 'turn.start' | 'turn.end'
  status: 'pending' | 'inProgress' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'hidden'
  role: 'user' | 'assistant' | 'system' | 'tool' | null
  orderSeq: number
  revision: number
  contentHash: string
  content: Record<string, unknown>
  source: Record<string, unknown>
}

export interface SessionControllerSelection {
  current: ModelSelection | undefined
  assembled: ModelSelection | undefined
}

export interface InteractionNotice {
  noticeId: string
  sessionId: string
  externalSessionId: string
  runtime: 'dsh'
  type: 'interaction'
  interactionKind: 'approval'
  title: string
  severity: 'warning'
  status: 'open' | 'closed' | 'cancelled'
  responseRequired: boolean
  actions: Array<{ id: string; label: string; style: 'primary' | 'danger' }>
  details: Record<string, unknown>
}
