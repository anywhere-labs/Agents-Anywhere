// aa.v3 conversation model (PoC draft), modelled on Effi Cloud's `cloud.v1.Conversations`
// (effi-evo/docs/cloud/CONTRACTS.md §五). Field names and shapes follow Effi Cloud on purpose (snake_case, ACP-shaped
// tool calls and config options), so the AI Elements rendering can be shared between the two products.
//
// A session is three kinds of state, each pushed whole:
//   Session  – the conversation itself: title, agent, device, cwd, config options.
//   Message  – one item: a user message, or ONE step of an agent's reply (a stretch of text, a stretch of thinking,
//              one tool call, the plan, a subagent, a compaction). Items of one reply share `turn_id`.
//   Control  – what is happening now: running or idle, waiting approvals, queued messages, usage. Small, separate,
//              so streaming never touches it.
// `watch` sends a snapshot, then whole replacements by id. No revisions, no deltas, no client-side merging.

export type ID = string
/** RFC 3339. */
export type Instant = string

// ── Session ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type AgentKind = 'codex' | 'claude' | 'dsh' | (string & {})

/** A runtime setting the agent reports (ACP session config): model, permission mode, reasoning effort… */
export interface ConfigOption {
  /** `set_config` id. */
  id: string
  name: string
  description?: string
  /** For placement and icon only. */
  category?: 'mode' | 'model' | 'thought_level' | 'model_config' | (string & {})
  current: string
  options: { value: string; name: string; description?: string; group?: string }[]
}

export interface Session {
  id: ID
  title: string
  agent: AgentKind
  /** AA: the Connector (device) the agent runs on. Effi Cloud has one instance per tunnel instead. */
  device: { id: ID; name: string }
  cwd: string
  branch?: string
  created_at: Instant
  updated_at: Instant
  message_count: number
  /** Empty until the agent has reported its settings. Clients render whatever is here; nothing is keyed on agent name. */
  config: ConfigOption[]
  forked_from?: { session_id: ID; message_id: ID }
}

// ── Messages (items) ────────────────────────────────────────────────────────────────────────────────────────────

/** ACP tool kinds. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface TextPart {
  type: 'text'
  /** Markdown. */
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
}

export interface ToolPart {
  type: 'tool'
  /** ACP toolCallId; `control.pending[].tool_call_id` points here. */
  id: ID
  /** Worded for people by the adapter: the command, "Read file.py (1–80)", the query. */
  title: string
  kind: ToolKind
  status: ToolStatus
  /** ACP rawInput. */
  input?: unknown
  /** ACP rawOutput; a string of the text content when there is none; terminal output for execute tools. */
  output?: unknown
  diffs?: { path: string; old_text?: string; new_text: string }[]
  locations?: { path: string; line?: number }[]
}

export interface PlanPart {
  type: 'plan'
  entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: 'high' | 'medium' | 'low' }[]
}

export interface SubagentPart {
  type: 'subagent'
  id: ID
  title: string
  description?: string
  agent_type?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: Instant
  ended_at?: Instant
  tool_count: number
  /** Always empty in item storage: the subagent's steps are items with `subagent_id` = this part's id. */
  parts: []
  result?: string
  background?: true
  error?: string
}

/** Attachments: only in user messages, after the text. Loaded through the host, never with credentials in the page. */
export interface ImagePart {
  type: 'image'
  path: string
  name: string
  mime: string
  size: number
}

export interface FilePart {
  type: 'file'
  path: string
  name: string
  mime: string
  size: number
}

export interface CompactionPart {
  type: 'compaction'
  id: ID
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  trigger?: 'manual' | 'auto'
  summary?: string
  tokens_before?: number
  tokens_after?: number
  at: Instant
  ended_at?: Instant
}

export type AssistantPart = TextPart | ThinkingPart | ToolPart | PlanPart | SubagentPart | CompactionPart
export type UserPart = TextPart | ImagePart | FilePart
export type Part = AssistantPart | UserPart

interface MessageBase {
  id: ID
  created_at: Instant
  /** Position in the session from 0. A position, not a version: only rewind removes items, always from the end. */
  seq: number
  /** Finished; the item will not change again. */
  done: boolean
}

export interface UserMessage extends MessageBase {
  role: 'user'
  /** The sender's idempotency key; an optimistic local copy is replaced when the item with this key arrives. */
  client_msg_id?: string
  /** Localized by the host when the device records a failed delivery. */
  delivery_error?: string
  /** Someone else in a shared session. */
  author?: string
  /** Sent while the agent was working and inserted into that turn. */
  steered?: true
  rewindable?: boolean
  parts: UserPart[]
}

export interface AssistantMessage extends MessageBase {
  role: 'assistant'
  /** The turn: the id of the user message that started it (its own id for autonomous output and compaction). */
  turn_id: ID
  /** A step of a subagent: the id of that subagent part. */
  subagent_id?: ID
  interrupted?: true
  autonomous?: true
  /** Exactly one part per assistant item. */
  parts: [AssistantPart]
}

export type Message = UserMessage | AssistantMessage

// ── Control ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingRequest {
  request_id: ID
  /** The tool item waiting on it. */
  message_id: ID
  tool_call_id: ID
  title: string
  /** ACP permission option kinds. */
  options: { id: ID; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[]
}

export interface Control {
  state: 'idle' | 'running' | 'error' | 'disconnected'
  /** How a message sent while running is delivered. */
  steer: 'native' | 'interrupt' | 'none'
  error?: string
  pending: PendingRequest[]
  queued: { client_msg_id: string; author: string; content: string; attachments?: (ImagePart | FilePart)[] }[]
  /** Recently answered requests, so other devices can show "已由某某在某设备上处理". */
  answered?: { request_id: ID; by: string; device?: string; option_id: ID; at: Instant }[]
  background?: { id: ID; kind: 'shell' | 'agent' | 'other'; title: string; status: 'running' | 'completed' | 'failed' | 'killed'; started_at: Instant; ended_at?: Instant; exit_code?: number; output_tail?: string }[]
  usage?: { used?: number; size?: number; model?: string; updated_at: Instant }
  capabilities?: { compact: boolean; compact_instructions?: boolean }
}

// ── watch ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `watch({id})` server stream. Every event is the whole current value of what changed; the client replaces by
 * id. While an item streams, the server pushes it whole every ~333 ms; each watcher's queue keeps only the newest
 * value per item, so a slow device skips frames instead of falling behind. A dropped stream is simply watched again.
 */
export type WatchEvent =
  | { type: 'snapshot'; session: Session; messages: Message[]; has_more: boolean; control: Control }
  | { type: 'message'; message: Message }
  | { type: 'session'; session: Session }
  | { type: 'control'; control: Control }

// ── Sidebar (watch_list) ────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceSummary {
  id: ID
  name: string
  presence: 'online' | 'offline'
  platform: 'macos' | 'linux' | 'windows'
}

export interface SessionSummary {
  id: ID
  title: string
  agent: AgentKind
  device_id: ID
  /** The project is the working folder (as in Effi Cloud); sessions are listed under it. */
  cwd: string
  state: Control['state'] | 'waiting'
  unread: boolean
  pinned: boolean
  updated_at: Instant
}

export interface Workspace {
  account: { name: string; email: string }
  devices: DeviceSummary[]
  /** Project folders per device, in the user's order. */
  projects: { device_id: ID; cwd: string; name: string }[]
  sessions: SessionSummary[]
}
