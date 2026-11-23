// Agents Anywhere v3 unified TypeScript types:
// - contracts/aa-v3/1.0/control.schema.json
// - contracts/aa-v3/1.0/pairing.schema.json
// - connector-v3/src/core/timeline.ts & rpc/*.ts
// - server-v3/aa_control/core/models.py (auth, drive, assistant, mcp)

export type ID = string
export type Instant = string

export type DeviceMode = "normal" | "encrypted"
export type DevicePlatform = "macos" | "linux" | "windows"
export type ClientPlatform = "ios" | "android" | "desktop" | "web"
export type PresenceState = "online" | "offline"
export type SessionState = "idle" | "running" | "error" | "disconnected" | "waiting"
export type DeviceResultStatus = "ok" | "offline" | "timeout" | "error" | "encrypted"
export type AuthMode = "local" | "oidc"
export type McpScope = "devices:read" | "sessions:read" | "sessions:write" | "approvals:answer"

// ---------------------------------------------------------------------------
// Auth & Control HTTP
// ---------------------------------------------------------------------------

export type EntitlementValue = string | number | boolean

export interface OidcPublicConfig {
  issuer: string
  client_id: string | null
  scopes: string
  authorization_endpoint: string | null
  token_endpoint: string | null
  userinfo_endpoint: string | null
  jwks_uri: string | null
  end_session_endpoint: string | null
}

export interface AuthConfigResponse {
  auth_mode: AuthMode
  needs_bootstrap: boolean
  registration_open: boolean
  oauth_enabled: boolean
  oauth_provider_label: string | null
  oidc: OidcPublicConfig | null
  server_time: string
}

export interface UserView {
  id: string
  email: string | null
  display_name: string
  role: string
  created_at: string
  plan: string | null
  entitlements: Record<string, EntitlementValue>
  active_context: Record<string, unknown> | null
}

export interface AuthTokenResponse {
  user: UserView
  access_token: string
  refresh_token: string
  expires_in: number
  client_id: string
}

export interface RouterTokenEntry {
  router_id: string
  router_url: string
  token: string
  token_id: string
  expires_at: string
}

export interface ClientRouterTokenResponse {
  principal: string
  tokens: RouterTokenEntry[]
}

export interface RegisterDeviceResponse {
  device: DeviceRecord
  device_secret: string
  notice: string
}

// ---------------------------------------------------------------------------
// Control Plane RPC (aa.v3.Control)
// ---------------------------------------------------------------------------

export interface DeviceError {
  code: string
  message: string
}

export interface NormalDeviceSummary {
  runtimes: string[]
  active_sessions: number
  pending_approvals: number
}

export interface DeviceRecord {
  id: string
  name: string
  platform: DevicePlatform
  connector_version: string
  mode_hint: DeviceMode
  presence: PresenceState
  created_at: string
  last_seen_at: string
  summary?: NormalDeviceSummary | null
  e2e_public_key_hint?: string | null
}

export type WatchDevicesEvent =
  | { type: "snapshot"; devices: DeviceRecord[] }
  | { type: "upsert"; device: DeviceRecord }
  | { type: "remove"; device_id: string }

export interface OpenTunnelResponse {
  router_url: string
  credential: string
  tunnel_id: string
  expires_at: string
  mode: DeviceMode
}

export interface SessionSummary {
  id: string
  title: string
  agent: string
  device_id: string
  cwd: string
  state: SessionState
  unread: boolean
  pinned: boolean
  updated_at: Instant
}

export interface SessionListPayload {
  sessions: SessionSummary[]
  projects: string[]
}

export interface DeviceSessionResult {
  device_id: string
  status: DeviceResultStatus
  value?: SessionListPayload | null
  error?: DeviceError | null
}

// ---------------------------------------------------------------------------
// E2EE Pairing & Client Trust (contracts/aa-v3/1.0/pairing.schema.json)
// ---------------------------------------------------------------------------

export type TrustTier = "verified_app" | "web_browser"
export type LockBadge = "green" | "grey"

export type PairingErrorCode =
  | "invalid_pairing_uri"
  | "invalid_pairing_code"
  | "pairing_expired"
  | "pairing_used"
  | "e2e_handshake_failed"
  | "device_pub_mismatch"
  | "e2e_required_locally"
  | "e2e_not_paired"
  | "tunnel_revoked"
  | "device_offline"

export interface PairingPayload {
  v: 1
  instance_id: string
  device_pub: string
  pairing_id: string
  psk: string
  expires_at: Instant
}

export interface ClientDeviceTrustRecord {
  device_id: string
  device_pub: string
  require_e2ee: true
  trust_tier: TrustTier
  paired_at: Instant
  device_name_hint?: string
}

export interface PairedClientEntry {
  client_pub: string
  label: string
  platform: "ios" | "android" | "desktop" | "web" | "cli"
  paired_at: Instant
  last_seen_at?: Instant
}

// ---------------------------------------------------------------------------
// Device Timeline & Session RPC (aa.v3.Sessions / Device / Terminals)
// ---------------------------------------------------------------------------

export type AgentKind = "codex" | "claude" | "dsh" | (string & {})
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other"
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed"
export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"

export interface ConfigOption {
  id: string
  name: string
  description?: string
  category?: "mode" | "model" | "thought_level" | "model_config" | (string & {})
  current: string
  options: { value: string; name: string; description?: string; group?: string }[]
}

/**
 * aa.v3.Device/agents: an agent on the device with its settings (connector-v3 README › Agent 管理). A disabled agent
 * is not offered for new conversations; settings apply to agent processes started afterwards. Environment values never
 * leave the device: only their names come back.
 */
export interface AgentEntry {
  id: string
  name: string
  builtin: boolean
  enabled: boolean
  command: string
  args: string[]
  env_keys: string[]
  customized: boolean
  /** Live processes of this agent (conversations whose agent is up, and the one started for a new conversation). */
  running: number
  /** Conversations of this agent with a turn running now. */
  busy: number
}

/** aa.v3.Device/update_agent: `reset` first drops every override; `env` values of null remove a variable. */
export interface AgentUpdate {
  id: string
  enabled?: boolean
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string | null>
  reset?: boolean
}

/**
 * aa.v3.Sessions/prepare: the agent started ahead of the conversation (as soon as the new-conversation page has an
 * agent and a directory), so its options can be chosen before the first message; `create({ prepared_id })` takes it
 * over. Preparing again before `expires_at` returns the same id and pushes the expiry back.
 */
export interface PreparedAgent {
  prepared_id: string
  agent: AgentKind
  cwd: string
  config: ConfigOption[]
  expires_at: Instant
}

export interface Session {
  id: ID
  title: string
  agent: AgentKind
  device: { id: ID; name: string }
  cwd: string
  branch?: string
  created_at: Instant
  updated_at: Instant
  message_count: number
  config: ConfigOption[]
  forked_from?: { session_id: ID; message_id: ID }
}

export interface TextPart {
  type: "text"
  text: string
}

export interface ThinkingPart {
  type: "thinking"
  text: string
}

export interface ToolPart {
  type: "tool"
  id: ID
  title: string
  kind: ToolKind
  status: ToolStatus
  input?: unknown
  output?: unknown
  diffs?: { path: string; old_text?: string; new_text: string }[]
  locations?: { path: string; line?: number }[]
}

export interface PlanEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "high" | "medium" | "low"
}

export interface PlanPart {
  type: "plan"
  entries: PlanEntry[]
}

export interface ImagePart {
  type: "image"
  path: string
  mime: string
  name: string
  size: number
}

export interface FilePart {
  type: "file"
  path: string
  name: string
  mime: string
  size: number
}

export interface SubagentPart {
  type: "subagent"
  id: ID
  title: string
  description?: string
  agent_type?: string
  status: "running" | "completed" | "failed" | "cancelled"
  started_at: Instant
  ended_at?: Instant
  tool_count: number
  parts: []
  result?: string
  background?: true
  error?: string
}

export interface CompactionPart {
  type: "compaction"
  id: ID
  status: "running" | "completed" | "failed" | "cancelled"
  trigger?: "manual" | "auto"
  summary?: string
  tokens_before?: number
  tokens_after?: number
  at: Instant
  ended_at?: Instant
}

export type CompactPart = CompactionPart

export type AssistantPart =
  | TextPart
  | ThinkingPart
  | ToolPart
  | PlanPart
  | SubagentPart
  | CompactionPart

export type UserPart = TextPart | ImagePart | FilePart
export type Part = AssistantPart | UserPart

export interface UserMessage {
  id: ID
  seq: number
  done: boolean
  role: "user"
  created_at: Instant
  author?: string
  client_msg_id?: string
  steered?: true
  rewindable?: boolean
  parts: UserPart[]
}

export interface AssistantMessage {
  id: ID
  seq: number
  done: boolean
  role: "assistant"
  turn_id: ID
  created_at: Instant
  subagent_id?: ID
  interrupted?: true
  autonomous?: true
  parts: [AssistantPart]
}

export type Message = UserMessage | AssistantMessage

export interface PermissionOption {
  id: ID
  name: string
  kind: PermissionOptionKind
}

export interface PendingRequest {
  request_id: ID
  message_id: ID
  tool_call_id: ID
  title: string
  options: PermissionOption[]
}

export interface AnsweredRequest {
  request_id: ID
  by: string
  device?: string
  option_id: ID
  at: Instant
}

export interface QueuedMessage {
  client_msg_id: string
  author: string
  content: string
  attachments?: (ImagePart | FilePart)[]
}

export interface BackgroundTask {
  id: ID
  kind: "shell" | "agent" | "other"
  title: string
  status: "running" | "completed" | "failed" | "killed"
  started_at: Instant
  ended_at?: Instant
  exit_code?: number
  output_tail?: string
}

export interface ContextUsage {
  used?: number
  size?: number
  model?: string
  updated_at: Instant
}

export interface Control {
  state: "idle" | "running" | "error" | "disconnected"
  error?: string
  steer: "native" | "interrupt" | "none"
  pending: PendingRequest[]
  answered?: AnsweredRequest[]
  queued: QueuedMessage[]
  background?: BackgroundTask[]
  usage?: ContextUsage
  capabilities?: { compact: boolean; compact_instructions?: boolean }
}

export type WatchEvent =
  | { type: "snapshot"; session: Session; messages: Message[]; has_more: boolean; control: Control }
  | { type: "message"; message: Message }
  | { type: "item"; message: Message }
  | { type: "control"; control: Control }
  | { type: "session"; session: Session }

export interface DeviceStatus {
  device_id: string
  device_name: string
  platform: DevicePlatform
  hostname: string
  cwd: string
  arch: string
  node_version: string
  connector_version: string
  uptime_seconds: number
  mode: DeviceMode
  allow_mcp: boolean
  runtimes: { id: string; name: string }[]
}

export interface DeviceSettings {
  mode: DeviceMode
  allow_mcp: boolean
  require_pairing_confirm: boolean
  max_rpc_file_bytes: number
  device_name: string
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
  is_symlink: boolean
  size: number
  mtime: string | null
}

export interface ListDirsResult {
  path: string
  parent: string | null
  entries: DirEntry[]
  truncated: boolean
}

export interface ReadFileResult {
  path: string
  size: number
  offset: number
  bytes_read: number
  eof: boolean
  encoding: "utf8" | "base64"
  content: string
  mtime: string
}

export interface TerminalInfo {
  id: string
  cwd: string
  shell: string
  cols: number
  rows: number
  created_at: string
  running: boolean
  exit_code: number | null
  exit_signal: string | null
  exited_at: string | null
  pid: number | null
  mode: TerminalMode
  owner: "user" | "agent"
  controller: TerminalController | null
  generation: number
  viewers: number
}

// aa.v3.Terminals attach protocol (contracts/aa-v3/1.0/terminals.schema.json, docs/v3/terminal-proposal.md).
// Terminal bytes travel as standard base64.

export type TerminalMode = "pty" | "pipe" | "script"

export interface TerminalController {
  /** `e2e:<peer_key>` on encrypted devices, the tunnel principal on normal devices. */
  client_id: string
  label: string
  /** false while the controller's attach is gone but its 10 s grace period has not ended. */
  connected: boolean
  since: string
}

export interface TerminalAttachRequest {
  id: string
  mode?: "view" | "control"
  cols?: number
  rows?: number
  resume_seq?: number
  label?: string
}

export type TerminalInputFrame =
  | { type: "input"; data: string; generation: number }
  | { type: "resize"; cols: number; rows: number; generation: number }
  | { type: "claim"; cols?: number; rows?: number; keep_size?: boolean }
  | { type: "release" }

export type TerminalRejectReason = "not_controller" | "stale_generation" | "agent_owned"

export type TerminalOutputFrame =
  | { type: "snapshot"; data: string; seq: number; cols: number; rows: number }
  | { type: "output"; data: string; seq: number }
  | {
      type: "control"
      controller: TerminalController | null
      generation: number
      you: boolean
      cols: number
      rows: number
    }
  | { type: "rejected"; reason: TerminalRejectReason; generation: number }
  | { type: "exit"; exit_code: number | null; exit_signal?: string | null }

export interface McpGrantView {
  id: string
  client_id: string
  client_name: string
  scopes: McpScope[]
  device_ids: string[]
  expires_at: number
  revoked_at: string | null
  created_at: string
}

/** `GET /oauth/authorize` (Bearer) consent preview from `server-v3` `McpService.consent_preview`. */
export interface McpConsentScopeView {
  scope: McpScope
  default_checked: boolean
  high_risk: boolean
}

export interface McpConsentPreview {
  client_id: string
  client_name: string
  redirect_uri: string
  scopes: McpConsentScopeView[]
  eligible_devices: { id: string; name: string; platform: DevicePlatform }[]
  note?: string
}

/** `POST /oauth/authorize` (Bearer) approval result. */
export interface McpAuthorizeApproveResponse {
  code: string
  redirect_url: string
}

// ---------------------------------------------------------------------------
// Cloud Drive (T517)
// ---------------------------------------------------------------------------

export type DrivePurpose = "transfer" | "assistant_vfs"
export type DriveEncryptionMode = "none" | "account_dek" | "ephemeral_key"
/** What an upload does when its target path is taken: "name (1)" (rename), 409 (fail) or supersede (replace). */
export type DriveConflictPolicy = "rename" | "fail" | "replace"
/** The two server-created folders: /Transfers and /Orches (Orches' cloud workspace). */
export type DriveSystemFolder = "transfers" | "orches"

export interface PresignedHttpTarget {
  method: "PUT" | "GET"
  url: string
  headers: Record<string, string>
  expires_at: string
}

export interface DriveFileView {
  id: string
  purpose: DrivePurpose
  status: "pending" | "ready"
  size_bytes: number
  sha256: string
  etag: string | null
  filename: string | null
  mime_type: string | null
  vfs_path: string | null
  /** Normalized absolute drive path, e.g. "/报告/2026/q3.pdf" (for a pending upload: where it will land). */
  path: string
  name: string
  parent_path: string
  /** Canonical text reference, e.g. "drive:/报告/2026/q3.pdf". */
  ref: string
  /** Inside /Orches: only Orches' own sync writes there (list, download, delete only). */
  managed: boolean
  encryption_mode: DriveEncryptionMode
  encryption_nonce: string | null
  encryption_key_version: number | null
  encrypted_meta: string | null
  source_device_id: string | null
  ttl_seconds: number
  created_at: string
  completed_at: string | null
  expires_at: string
}

export interface DriveFolderView {
  id: string
  path: string
  name: string
  parent_path: string
  ref: string
  system: DriveSystemFolder | null
  managed: boolean
  created_at: string
  updated_at: string
}

/** `GET /drive/entries`: one folder's subfolders and live files (each with its expiry). */
export interface DriveEntriesResponse {
  path: string
  ref: string
  /** null for the root folder. */
  folder: DriveFolderView | null
  folders: DriveFolderView[]
  files: DriveFileView[]
  total_files: number
  quota: DriveQuotaView
}

export interface DriveFolderMoveResponse {
  folder: DriveFolderView
  moved_folders: number
  moved_files: number
}

export interface DriveFolderDeleteResponse {
  ok: boolean
  deleted_folders: number
  deleted_files: number
}

/** `GET /drive/resolve?path=…|ref=drive:/…`. */
export interface DriveResolveResponse {
  kind: "file" | "folder"
  path: string
  ref: string
  folder: DriveFolderView | null
  file: DriveFileView | null
}

export interface DriveQuotaView {
  enabled: boolean
  rpc_direct_max_bytes: number
  quota_bytes: number | null
  used_bytes: number
  reserved_bytes: number
  remaining_bytes: number | null
  max_file_bytes: number | null
  default_ttl_seconds: number
  max_ttl_seconds: number
  file_count: number
  policy_source: string
}

export interface AdminDrivePolicyResponse {
  user_id: string
  override: {
    quota_bytes: number | null
    max_file_bytes: number | null
    default_ttl_seconds: number | null
    max_ttl_seconds: number | null
    updated_by: string | null
    updated_at: string | null
  } | null
  effective: DriveQuotaView
}

// ---------------------------------------------------------------------------
// Portable Assistant Sync, KEK/DEK Envelope & Tokens Anywhere (T516 / T518)
// ---------------------------------------------------------------------------

export type AssistantKdf = "pbkdf2-sha256" | "argon2id"

export interface AssistantKeyEnvelopeView {
  kdf: AssistantKdf
  kdf_params: Record<string, number | string>
  salt: string
  wrap_alg: "AES-256-GCM"
  wrap_nonce: string | null
  wrapped_dek: string
  key_version: number
  dek_epoch: number
  created_at: string
  updated_at: string
}

export interface AssistantEncryptionStatusResponse {
  enabled: boolean
  envelope: AssistantKeyEnvelopeView | null
}

export interface AssistantConversationMeta {
  id: string
  encrypted: boolean
  title: string | null
  encrypted_meta: string | null
  meta_nonce: string | null
  key_version: number | null
  dek_epoch: number | null
  updated_at: number
  hash: string
  device: string
  size: number
}

export interface AssistantConversationDetail extends AssistantConversationMeta {
  settings: Record<string, unknown> | null
  messages: Record<string, unknown>[] | null
  nonce: string | null
  ciphertext: string | null
}

export interface ListAssistantConversationsResponse {
  conversations: AssistantConversationMeta[]
  max_conversations: number
  max_conversation_bytes: number
}

export interface AssistantTokensView {
  connected: boolean
  key: string | null
  prefix: string | null
  connected_at: string | null
  refreshed_at: string | null
  kept: boolean | null
  hint: string | null
  tokens_url: string
  client_id: string
}
