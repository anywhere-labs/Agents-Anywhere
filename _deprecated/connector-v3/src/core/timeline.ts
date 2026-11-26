// aa.v3 conversation model, mirrored from `v3poc/protocol/timeline.ts` (itself modelled on Effi Cloud's
// `cloud.v1.Conversations`). Same snake_case field names and shapes; every type has a matching Zod schema so the
// MeshCall services in `src/services/*` can use them directly as typed request / response / stream-item schemas.
//
// A session is three kinds of state, each pushed whole:
//   Session  – the conversation itself: title, agent, device, cwd, config options.
//   Message  – one item: a user message, or ONE step of an agent's reply. Items of one reply share `turn_id`.
//   Control  – what is happening now: running or idle, waiting approvals, queued messages, usage.
// `watch` sends a snapshot, then whole replacements by id. No revisions, no deltas, no client-side merging.
//
// Portable: no Node built-ins.

import { z } from "meshcall";

export type ID = string;
/** RFC 3339. */
export type Instant = string;

export const IDSchema = z.string().min(1);
export const TimelineInstantSchema = z.string().min(1);

// ── Session ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type AgentKind = "codex" | "claude" | "dsh" | (string & {});

/** A runtime setting the agent reports (ACP session config): model, permission mode, reasoning effort… */
export interface ConfigOption {
  /** `set_config` id. */
  id: string;
  name: string;
  description?: string;
  /** For placement and icon only. */
  category?: "mode" | "model" | "thought_level" | "model_config" | (string & {});
  current: string;
  options: { value: string; name: string; description?: string; group?: string }[];
}

export const ConfigOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  current: z.string(),
  options: z.array(
    z.object({
      value: z.string(),
      name: z.string(),
      description: z.string().optional(),
      group: z.string().optional(),
    }),
  ),
});

export interface Session {
  id: ID;
  title: string;
  agent: AgentKind;
  /** The Connector (device) the agent runs on. */
  device: { id: ID; name: string };
  cwd: string;
  branch?: string;
  created_at: Instant;
  updated_at: Instant;
  message_count: number;
  /** Empty until the agent has reported its settings. Clients render whatever is here. */
  config: ConfigOption[];
  forked_from?: { session_id: ID; message_id: ID };
}

export const SessionSchema = z.object({
  id: IDSchema,
  title: z.string(),
  agent: z.string().min(1),
  device: z.object({ id: IDSchema, name: z.string() }),
  cwd: z.string(),
  branch: z.string().optional(),
  created_at: TimelineInstantSchema,
  updated_at: TimelineInstantSchema,
  message_count: z.number().int().nonnegative(),
  config: z.array(ConfigOptionSchema),
  forked_from: z.object({ session_id: IDSchema, message_id: IDSchema }).optional(),
});

// ── Messages (items) ────────────────────────────────────────────────────────────────────────────────────────────

/** ACP tool kinds. */
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export const ToolKindSchema = z.enum(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
export const ToolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);

export interface TextPart {
  type: "text";
  /** Markdown. */
  text: string;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
}

export interface ToolPart {
  type: "tool";
  /** ACP toolCallId; `control.pending[].tool_call_id` points here. */
  id: ID;
  /** Worded for people by the adapter: the command, "Read file.py (1–80)", the query. */
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  /** ACP rawInput. */
  input?: unknown;
  /** ACP rawOutput; a string of the text content when there is none; terminal output for execute tools. */
  output?: unknown;
  diffs?: { path: string; old_text?: string; new_text: string }[];
  locations?: { path: string; line?: number }[];
}

export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" };

export interface PlanPart {
  type: "plan";
  entries: PlanEntry[];
}

export interface SubagentPart {
  type: "subagent";
  id: ID;
  title: string;
  description?: string;
  agent_type?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: Instant;
  ended_at?: Instant;
  tool_count: number;
  /** Always empty in item storage: the subagent's steps are items with `subagent_id` = this part's id. */
  parts: [];
  result?: string;
  background?: true;
  error?: string;
}

/** Attachments: only in user messages, after the text. */
export interface ImagePart {
  type: "image";
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface FilePart {
  type: "file";
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface CompactionPart {
  type: "compaction";
  id: ID;
  status: "running" | "completed" | "failed" | "cancelled";
  trigger?: "manual" | "auto";
  summary?: string;
  tokens_before?: number;
  tokens_after?: number;
  at: Instant;
  ended_at?: Instant;
}

export type AssistantPart = TextPart | ThinkingPart | ToolPart | PlanPart | SubagentPart | CompactionPart;
export type UserPart = TextPart | ImagePart | FilePart;
export type Part = AssistantPart | UserPart;

export const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() });
export const ThinkingPartSchema = z.object({ type: z.literal("thinking"), text: z.string() });
export const ToolPartSchema = z.object({
  type: z.literal("tool"),
  id: IDSchema,
  title: z.string(),
  kind: ToolKindSchema,
  status: ToolStatusSchema,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  diffs: z.array(z.object({ path: z.string(), old_text: z.string().optional(), new_text: z.string() })).optional(),
  locations: z.array(z.object({ path: z.string(), line: z.number().int().optional() })).optional(),
});
export const PlanEntrySchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});
export const PlanPartSchema = z.object({ type: z.literal("plan"), entries: z.array(PlanEntrySchema) });
const RunStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
export const SubagentPartSchema = z.object({
  type: z.literal("subagent"),
  id: IDSchema,
  title: z.string(),
  description: z.string().optional(),
  agent_type: z.string().optional(),
  status: RunStatusSchema,
  started_at: TimelineInstantSchema,
  ended_at: TimelineInstantSchema.optional(),
  tool_count: z.number().int().nonnegative(),
  parts: z.tuple([]),
  result: z.string().optional(),
  background: z.literal(true).optional(),
  error: z.string().optional(),
});
const AttachmentFields = { path: z.string(), name: z.string(), mime: z.string(), size: z.number().int().nonnegative() };
export const ImagePartSchema = z.object({ type: z.literal("image"), ...AttachmentFields });
export const FilePartSchema = z.object({ type: z.literal("file"), ...AttachmentFields });
export const CompactionPartSchema = z.object({
  type: z.literal("compaction"),
  id: IDSchema,
  status: RunStatusSchema,
  trigger: z.enum(["manual", "auto"]).optional(),
  summary: z.string().optional(),
  tokens_before: z.number().int().nonnegative().optional(),
  tokens_after: z.number().int().nonnegative().optional(),
  at: TimelineInstantSchema,
  ended_at: TimelineInstantSchema.optional(),
});

export const AssistantPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ThinkingPartSchema,
  ToolPartSchema,
  PlanPartSchema,
  SubagentPartSchema,
  CompactionPartSchema,
]);
export const UserPartSchema = z.discriminatedUnion("type", [TextPartSchema, ImagePartSchema, FilePartSchema]);
export const AttachmentPartSchema = z.discriminatedUnion("type", [ImagePartSchema, FilePartSchema]);
export const PartSchema = z.union([AssistantPartSchema, UserPartSchema]);

interface MessageBase {
  id: ID;
  created_at: Instant;
  /** Position in the session from 0. A position, not a version: only rewind removes items, always from the end. */
  seq: number;
  /** Finished; the item will not change again. */
  done: boolean;
}

export interface UserMessage extends MessageBase {
  role: "user";
  /** The sender's idempotency key; an optimistic local copy is replaced when the item with this key arrives. */
  client_msg_id?: string;
  /** Someone else in a shared session. */
  author?: string;
  /** Sent while the agent was working and inserted into that turn. */
  steered?: true;
  rewindable?: boolean;
  parts: UserPart[];
}

export interface AssistantMessage extends MessageBase {
  role: "assistant";
  /** The turn: the id of the user message that started it (its own id for autonomous output and compaction). */
  turn_id: ID;
  /** A step of a subagent: the id of that subagent part. */
  subagent_id?: ID;
  interrupted?: true;
  autonomous?: true;
  /** Exactly one part per assistant item. */
  parts: [AssistantPart];
}

export type Message = UserMessage | AssistantMessage;

const MessageBaseFields = {
  id: IDSchema,
  created_at: TimelineInstantSchema,
  seq: z.number().int().nonnegative(),
  done: z.boolean(),
};
export const UserMessageSchema = z.object({
  ...MessageBaseFields,
  role: z.literal("user"),
  client_msg_id: z.string().optional(),
  author: z.string().optional(),
  steered: z.literal(true).optional(),
  rewindable: z.boolean().optional(),
  parts: z.array(UserPartSchema),
});
export const AssistantMessageSchema = z.object({
  ...MessageBaseFields,
  role: z.literal("assistant"),
  turn_id: IDSchema,
  subagent_id: IDSchema.optional(),
  interrupted: z.literal(true).optional(),
  autonomous: z.literal(true).optional(),
  parts: z.tuple([AssistantPartSchema]),
});
export const MessageSchema = z.discriminatedUnion("role", [UserMessageSchema, AssistantMessageSchema]);

// ── Control ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PendingRequest {
  request_id: ID;
  /** The tool item waiting on it. */
  message_id: ID;
  tool_call_id: ID;
  title: string;
  /** ACP permission option kinds. */
  options: { id: ID; name: string; kind: PermissionOptionKind }[];
}

export interface QueuedMessage {
  client_msg_id: string;
  author: string;
  content: string;
  attachments?: (ImagePart | FilePart)[];
}

export interface AnsweredRequest {
  request_id: ID;
  by: string;
  device?: string;
  option_id: ID;
  at: Instant;
}

export interface BackgroundTask {
  id: ID;
  kind: "shell" | "agent" | "other";
  title: string;
  status: "running" | "completed" | "failed" | "killed";
  started_at: Instant;
  ended_at?: Instant;
  exit_code?: number;
  output_tail?: string;
}

export interface Control {
  state: "idle" | "running" | "error" | "disconnected";
  /** How a message sent while running is delivered. */
  steer: "native" | "interrupt" | "none";
  error?: string;
  pending: PendingRequest[];
  queued: QueuedMessage[];
  /** Recently answered requests, so other devices can show "已由某某在某设备上处理". */
  answered?: AnsweredRequest[];
  background?: BackgroundTask[];
  usage?: { used?: number; size?: number; model?: string; updated_at: Instant };
  capabilities?: { compact: boolean; compact_instructions?: boolean };
}

export const PermissionOptionKindSchema = z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]);
export const PendingRequestSchema = z.object({
  request_id: IDSchema,
  message_id: IDSchema,
  tool_call_id: IDSchema,
  title: z.string(),
  options: z.array(z.object({ id: IDSchema, name: z.string(), kind: PermissionOptionKindSchema })),
});
export const QueuedMessageSchema = z.object({
  client_msg_id: z.string().min(1),
  author: z.string(),
  content: z.string(),
  attachments: z.array(AttachmentPartSchema).optional(),
});
export const AnsweredRequestSchema = z.object({
  request_id: IDSchema,
  by: z.string(),
  device: z.string().optional(),
  option_id: IDSchema,
  at: TimelineInstantSchema,
});
export const BackgroundTaskSchema = z.object({
  id: IDSchema,
  kind: z.enum(["shell", "agent", "other"]),
  title: z.string(),
  status: z.enum(["running", "completed", "failed", "killed"]),
  started_at: TimelineInstantSchema,
  ended_at: TimelineInstantSchema.optional(),
  exit_code: z.number().int().optional(),
  output_tail: z.string().optional(),
});
export const ControlStateSchema = z.enum(["idle", "running", "error", "disconnected"]);
export const ControlSchema = z.object({
  state: ControlStateSchema,
  steer: z.enum(["native", "interrupt", "none"]),
  error: z.string().optional(),
  pending: z.array(PendingRequestSchema),
  queued: z.array(QueuedMessageSchema),
  answered: z.array(AnsweredRequestSchema).optional(),
  background: z.array(BackgroundTaskSchema).optional(),
  usage: z
    .object({
      used: z.number().optional(),
      size: z.number().optional(),
      model: z.string().optional(),
      updated_at: TimelineInstantSchema,
    })
    .optional(),
  capabilities: z.object({ compact: z.boolean(), compact_instructions: z.boolean().optional() }).optional(),
});

// ── watch ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `watch({id})` server stream. Every event is the whole current value of what changed; the client replaces by
 * id. Each watcher's queue keeps only the newest value per item, so a slow device skips frames instead of falling
 * behind. A dropped stream is simply watched again. A later `snapshot` (after a rewind) replaces everything.
 */
export type WatchEvent =
  | { type: "snapshot"; session: Session; messages: Message[]; has_more: boolean; control: Control }
  | { type: "message"; message: Message }
  | { type: "session"; session: Session }
  | { type: "control"; control: Control };

export const WatchEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    session: SessionSchema,
    messages: z.array(MessageSchema),
    has_more: z.boolean(),
    control: ControlSchema,
  }),
  z.object({ type: z.literal("message"), message: MessageSchema }),
  z.object({ type: z.literal("session"), session: SessionSchema }),
  z.object({ type: z.literal("control"), control: ControlSchema }),
]);

// ── Sidebar (watch_list) ────────────────────────────────────────────────────────────────────────────────────────

export interface DeviceSummary {
  id: ID;
  name: string;
  presence: "online" | "offline";
  platform: "macos" | "linux" | "windows";
}

export const DeviceSummarySchema = z.object({
  id: IDSchema,
  name: z.string(),
  presence: z.enum(["online", "offline"]),
  platform: z.enum(["macos", "linux", "windows"]),
});

export type SessionState = Control["state"] | "waiting";

export interface SessionSummary {
  id: ID;
  title: string;
  agent: AgentKind;
  device_id: ID;
  /** The project is the working folder; sessions are listed under it. */
  cwd: string;
  state: SessionState;
  unread: boolean;
  pinned: boolean;
  updated_at: Instant;
}

export const SessionSummarySchema = z.object({
  id: IDSchema,
  title: z.string(),
  agent: z.string().min(1),
  device_id: IDSchema,
  cwd: z.string(),
  state: z.enum(["idle", "running", "error", "disconnected", "waiting"]),
  unread: z.boolean(),
  pinned: z.boolean(),
  updated_at: TimelineInstantSchema,
});

/** `aa.v3.Sessions/list` response; also `SessionListPayload` in `control.schema.json`. */
export interface SessionList {
  sessions: SessionSummary[];
  projects: string[];
}

export const SessionListSchema = z.object({ sessions: z.array(SessionSummarySchema), projects: z.array(z.string()) });

export interface SessionListEvent extends SessionList {
  type: "snapshot" | "update";
}

export const SessionListEventSchema = SessionListSchema.extend({ type: z.enum(["snapshot", "update"]) });

export interface Workspace {
  account: { name: string; email: string };
  devices: DeviceSummary[];
  /** Project folders per device, in the user's order. */
  projects: { device_id: ID; cwd: string; name: string }[];
  sessions: SessionSummary[];
}

export const WorkspaceSchema = z.object({
  account: z.object({ name: z.string(), email: z.string() }),
  devices: z.array(DeviceSummarySchema),
  projects: z.array(z.object({ device_id: IDSchema, cwd: z.string(), name: z.string() })),
  sessions: z.array(SessionSummarySchema),
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The sidebar row of a session: a waiting approval shows as `waiting`, whatever the run state. */
export function sessionToSummary(session: Session, control: Control, unread: boolean, pinned: boolean): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    agent: session.agent,
    device_id: session.device.id,
    cwd: session.cwd,
    state: control.pending.length > 0 ? "waiting" : control.state,
    unread,
    pinned,
    updated_at: session.updated_at,
  };
}

export function emptyControl(steer: Control["steer"] = "none"): Control {
  return { state: "idle", steer, pending: [], queued: [] };
}

// ── Compile-time agreement between the schemas and the interfaces above ─────────────────────────────────────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _TimelineSchemaChecks = [
  Assert<Same<z.infer<typeof ConfigOptionSchema>, ConfigOption>>,
  Assert<Same<z.infer<typeof SessionSchema>, Session>>,
  Assert<Same<z.infer<typeof TextPartSchema>, TextPart>>,
  Assert<Same<z.infer<typeof ThinkingPartSchema>, ThinkingPart>>,
  Assert<Same<z.infer<typeof ToolPartSchema>, ToolPart>>,
  Assert<Same<z.infer<typeof PlanPartSchema>, PlanPart>>,
  Assert<Same<z.infer<typeof SubagentPartSchema>, SubagentPart>>,
  Assert<Same<z.infer<typeof CompactionPartSchema>, CompactionPart>>,
  Assert<Same<z.infer<typeof AssistantPartSchema>, AssistantPart>>,
  Assert<Same<z.infer<typeof UserPartSchema>, UserPart>>,
  Assert<Same<z.infer<typeof UserMessageSchema>, UserMessage>>,
  Assert<Same<z.infer<typeof AssistantMessageSchema>, AssistantMessage>>,
  Assert<Same<z.infer<typeof MessageSchema>, Message>>,
  Assert<Same<z.infer<typeof PendingRequestSchema>, PendingRequest>>,
  Assert<Same<z.infer<typeof ControlSchema>, Control>>,
  Assert<Same<z.infer<typeof WatchEventSchema>, WatchEvent>>,
  Assert<Same<z.infer<typeof SessionSummarySchema>, SessionSummary>>,
  Assert<Same<z.infer<typeof SessionListEventSchema>, SessionListEvent>>,
  Assert<Same<z.infer<typeof WorkspaceSchema>, Workspace>>,
];
