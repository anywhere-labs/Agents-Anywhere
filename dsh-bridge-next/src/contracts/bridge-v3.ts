/**
 * Wire shapes of contracts/dsh-bridge/3.0 used by the plugin. The JSON Schemas in
 * that directory are the source of truth; tests/unit/bridge-v3-contract.test.ts
 * checks these shapes against them.
 */

export const BRIDGE_PROTOCOL = '3.0'
export const RENDEZVOUS_FILE = 'connector-acp.json'

export interface BridgeRendezvousV3 {
  version: 3
  protocol: 'acp'
  instanceId: string
  pid: number
  endpoint: { unixPath: string } | { pipe: string }
  key: string
}

export type HostKind = 'desktop' | 'web' | 'headless' | 'unknown'

export interface BridgeHello {
  t: 'hello'
  bridgeProtocol: string
  key: string
  hostInstance: string
  hostKind: HostKind
  dshVersion: string
  pluginVersion: string
  dshHome?: string
}

export type BridgeHandshakeReply =
  | { t: 'welcome', bridgeProtocol: string, connectorInstance: string, connectorVersion: string }
  | { t: 'reject', code: 'bad_key' | 'unsupported_protocol' | 'duplicate_host' | 'busy', message: string }

export interface DshFeatures {
  queue: boolean
  steer: boolean
  continue: boolean
  planning: boolean
  questions: boolean
  attachments: boolean
  fileUploads: boolean
  agentPresets: boolean
  permissionPresets: boolean
}

export interface DshAgentMeta {
  bridgeProtocol: string
  hostInstance: string
  dshVersion: string
  features: DshFeatures
}

export type Writer = 'host' | 'external' | 'none'

export interface DshSessionInfoMeta {
  createdAt?: string
  running: boolean
  lastSeq: number
  workspaceId?: string
  writer: Writer
}

export interface DshLoadResultMeta {
  lastSeq: number
  running: boolean
  continuable: number | null
  replayTruncated?: boolean
  writer: Writer
}

export interface DshUpdateMeta {
  seq?: number
  turn?: number
  step?: number
  /** The timeline item this update lands on (§6): stable across stream, commit and replay. */
  itemId?: string
  transient?: boolean
  attemptId?: string
  committed?: { messageId: string, replacesAttempt?: string }
  abandoned?: { attemptId: string }
  source?: 'user' | 'retry' | 'other'
  requestId?: string
  turnEvent?: DshTurnNotification
  /** On session_info_update: the writer of an attached session changed (§9). */
  writer?: Writer
}

export interface DshPromptMeta {
  requestId: string
  delivery?: 'turn' | 'queue'
  selections?: { model?: string, reasoningEffort?: string, permission?: string, agentPreset?: string }
}

export type DshTurnNotification =
  | { sessionId: string, phase: 'started', turn: number, seq: number, requestIds?: string[] }
  | { sessionId: string, phase: 'ended', turn: number, seq: number, requestIds: string[],
    stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled',
    reason: { kind: string, message?: string }, continuable: boolean }

export interface DshInteractionResolved {
  sessionId: string
  interactionId: string
  by: 'dsh' | 'timeout' | 'cancelled'
  optionId?: string
}

export const DSH_METHODS = {
  listSubscribe: '_session/list/subscribe',
  listUnsubscribe: '_session/list/unsubscribe',
  listChanges: '_session/list/changes',
  steering: '_session/steering',
  writer: '_dsh/session/writer',
  continue: '_dsh/session/continue',
  interactionResolved: '_dsh/interaction/resolved',
  hostFeatures: '_dsh/host/features',
  planningGet: '_dsh/planning/get',
  planningSet: '_dsh/planning/set',
} as const
