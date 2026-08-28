/** Bridge protocol version implemented by this package. */
export const PROTOCOL_VERSION = '1.0'
/** Runtime identifier exposed to Agents Anywhere. */
export const RUNTIME_ID = 'dsh'

/** One runtime or Session capability with its three independent gates. */
export interface Capability {
  capabilityId: string
  scope: 'runtime' | 'session'
  sessionId?: string
  supported: boolean
  available: boolean
  allowed: boolean
  unavailableReason?: string
}

/** Provider/model/reasoning selection exposed in the AA catalog. */
export interface ModelCatalogItem {
  selectionId: string
  provider: string
  model: string
  reasoningEffort: string | null
  name: string
  description?: string
  enabled: boolean
  disabledReason?: string
  contextWindow?: number
  inputModalities?: string[]
}

/** One permission preset exposed in the AA catalog. */
export interface PermissionCatalogItem {
  selectionId: string
  preset: string
  name: string
  description?: string
  enabled: boolean
}

/** Current model and permission selection IDs. */
export interface SelectionState {
  model: string
  permission: string
}

/** Status projected for one AA Session. */
export type RuntimeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'stopping'
  | 'waiting_approval'
  | 'blocked'
  | 'error'

/** Session state returned and notified by the bridge. */
export interface SessionState {
  sessionId: string
  externalSessionId: string
  runtime: 'dsh'
  status: RuntimeStatus
  selections: SelectionState
  revision: number
  error?: { code: string; message: string }
}

/** Reason a DSH Session is absent from the Desktop top-level navigation. */
export type SessionHiddenReason = 'archived' | 'blank' | 'subagent'

/** DSH navigation state consumed by Agents Anywhere session visibility projection. */
export interface SessionVisibilityMetadata {
  hidden: boolean
  localArchived: boolean
  blank: boolean
  origin: 'subagent' | null
  hiddenReasons: SessionHiddenReason[]
}

/** Native DSH Session discovery metadata. */
export interface SessionMeta {
  sessionId: string | null
  externalSessionId: string
  runtime: 'dsh'
  title: string | null
  cwd: string | null
  orderingTime: string
  revision: string
  requiresTimelineSync: boolean
  metadata: SessionVisibilityMetadata
}

/** Stable AA timeline item emitted by the DSH event projector. */
export interface TimelineItem {
  id: string
  type: 'message' | 'assistant_activity' | 'tool' | 'tool_call' | 'tool_result' | 'command' | 'turn_status'
  orderSeq: number
  revision: number
  contentHash: string
  payload: Record<string, unknown>
}

/** Interaction notice delivered to AA clients. */
export interface InteractionNotice {
  id: string
  sessionId: string
  externalSessionId: string
  type: 'interaction'
  interactionKind: 'approval' | 'user_question'
  responseRequired: boolean
  status: 'open' | 'closed' | 'cancelled'
  title: string
  details: Record<string, unknown>
  actions: Array<{ id: string; label: string; style?: string }>
}
