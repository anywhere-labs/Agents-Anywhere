// Ports of agent collaboration (docs/agent-collaboration.md): how the collaboration use cases reach sessions (on this
// device, through the Server, through a secure channel), what they inject into Agent sessions, and the facts they
// read about this device's own sessions.

import type { Authority, ObservedItem, PermissionLevel, SessionAddress, TargetSignal } from '../../domain/collab/index.js'

/** The supervisor session a collaboration request acts for; `supervisionId`: the request is a supervision wake. */
export interface AgentActorRef {
  readonly deviceId: string
  readonly sessionId: string
  readonly grantId: string
  readonly supervisionId?: string | null
}

/** A client API request (`/api/v2/<path>`), as Web or Desktop would send it. */
export interface GatewayRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path under `/api/v2`, without a leading slash: `sessions/sess_x/runtime/messages`. */
  readonly path: string
  readonly body?: Record<string, unknown> | null
  readonly query?: Readonly<Record<string, string>>
}

export interface GatewayResponse {
  readonly status: number
  readonly body: unknown
}

/** What a target session looks like from outside: its directory facts and display label. */
export interface TargetView {
  readonly address: SessionAddress
  readonly signal: TargetSignal
  readonly title: string | null
  readonly runtimeType: string | null
  readonly runtimeId: string | null
  readonly cwd: string | null
  readonly createdBySessionId: string | null
  readonly depth: number
}

export interface ObservedPage {
  readonly items: readonly ObservedItem[]
  readonly headSeq: number
  readonly resetSeq: number
  readonly hasMore: boolean
}

export interface OpenNotice {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
}

/** Account-level directory reads (devices, runtime instances, sessions), served by the Server. */
export interface DirectoryDevice {
  readonly deviceId: string
  readonly name: string | null
  readonly online: boolean
  readonly e2eeMode: string | null
}

export interface DirectoryRuntime {
  readonly runtimeId: string
  readonly runtimeType: string
  readonly name: string | null
  readonly deviceId: string
}

export interface DirectorySession {
  readonly sessionId: string
  readonly deviceId: string
  readonly title: string | null
  readonly runtimeType: string | null
  readonly status: string | null
}

/**
 * The client API of every session the account can reach, as one port. The adapter picks the route per target device:
 * in-process on this device; through the Server with a delegation token in normal mode; through a secure channel as an
 * `agent` client in encrypted mode, never downgraded.
 */
export interface SessionGateway {
  request(deviceId: string, actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse>
  /** The target's directory facts; null when the session is unknown. */
  facts(target: SessionAddress, actor: AgentActorRef): Promise<TargetView | null>
  /** Items after `afterSeq` (oldest first), translated into the digest's terms. */
  observe(target: SessionAddress, actor: AgentActorRef, afterSeq: number, limit: number): Promise<ObservedPage>
  notices(target: SessionAddress, actor: AgentActorRef): Promise<OpenNotice[]>
  /** Which device holds a session this device does not know; null when it cannot be found. */
  locate(sessionId: string, actor: AgentActorRef): Promise<string | null>
  devices(actor: AgentActorRef): Promise<DirectoryDevice[]>
  runtimes(actor: AgentActorRef, deviceId: string): Promise<DirectoryRuntime[]>
  sessions(actor: AgentActorRef, limit: number): Promise<DirectorySession[]>
}

/** A stdio tool server to inject into an Agent session (ACP `mcpServers`), runtime-neutral. */
export interface ToolServerSpec {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** The Runtime should run its tools without asking a person: the collaboration grant already decides. */
  readonly autoApprove: boolean
}

/** What to inject when a session's Agent session opens (new, load, resume). */
export interface SessionToolProvider {
  toolServers(session: { readonly sessionId: string; readonly runtimeId: string; readonly runtimeType: string }): Promise<readonly ToolServerSpec[]>
}

/** The user's collaboration settings as the Server pushed them (`deviceSettings.agentCollaboration`). */
export interface CollabInstanceSettings {
  readonly enabled: boolean
  readonly crossDevice: boolean
  readonly authority: Authority
}

export interface CollabSettings {
  readonly enabled: boolean
  readonly crossDevice: boolean
  readonly instances: Readonly<Record<string, CollabInstanceSettings>>
}

/** Facts about this device's own sessions that collaboration needs and Conversation owns. */
export interface SupervisorFacts {
  /** The session's own permission level (caps the authority it may use). */
  permissionLevel(sessionId: string): Promise<PermissionLevel>
  /** Whether the session's Agent is in a turn (a wake waits until it is not). */
  busy(sessionId: string): Promise<boolean>
  /** A session of this device can host the collaboration tools (its Runtime supports injection). */
  canHostTools(runtimeId: string): Promise<boolean>
  /** This device's runtime instances (`aa_targets` lists them without the Server). */
  localRuntimes(): Promise<readonly { readonly runtimeId: string; readonly runtimeType: string; readonly name: string | null }[]>
}

/** Shows a person a question an Agent asked (a `collab_escalation` system item). */
export interface EscalationSink {
  escalate(sessionId: string, itemId: string, content: Record<string, unknown>): Promise<void>
}

/** How the injected tool server is started (the bundled `agent-tools` entry, with Node). */
export interface ToolServerLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** The local endpoint the tool server dials (`AA_AGENT_TOOLS_ENDPOINT`). */
  readonly endpoint: string
}

/** A device the collaboration client pinned (encrypted mode): its Agents may open secure channels to it. */
export interface PinnedPeer {
  readonly deviceId: string
  /** base64url X25519 public key. */
  readonly identityPub: string
  readonly identityPubFingerprint: string
  readonly label: string
  readonly pinnedAt: string
}

/**
 * The keys of this device's collaboration client (encrypted mode): its own identity, which other devices approve
 * as an `agent` client, and the device keys a person pinned for it (`/e2ee/v1/agent-identity`, `/e2ee/v1/peers`).
 */
export interface AgentPeerKeyring {
  /** The public half of the collaboration identity, created on first use. */
  identityPub(): Promise<string>
  peers(): Promise<PinnedPeer[]>
  pin(peer: { readonly deviceId: string; readonly identityPub: string; readonly label: string }): Promise<PinnedPeer>
  pinned(deviceId: string): Promise<PinnedPeer | null>
}
