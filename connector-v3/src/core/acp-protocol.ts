// Agent Client Protocol (ACP): JSON-RPC 2.0 over the agent's stdio, and the projector that turns an agent's
// `session/update` stream into aa.v3 timeline items in a `SessionStore`.
//
// Only the parts of ACP the Connector uses are typed here (https://agentclientprotocol.com): initialize,
// session/new, session/resume, session/load, session/prompt, session/cancel, session/set_config_option,
// session/set_mode, the `session/update` notification and the agent → client `session/request_permission` / `fs/*`
// requests. Unknown fields and update kinds are tolerated: agents add them faster than the spec moves.
//
// Portable: no Node built-ins. Spawning the agent and framing stdio is `src/runtime/*`'s job.

import { PI_APPROVALS_CONFIG_ID } from "./pi-approvals.js";
import type { AssistantItemInput, SessionStore } from "./session-store.js";
import type {
  AssistantMessage,
  AssistantPart,
  ConfigOption,
  PendingRequest,
  PermissionOptionKind,
  PlanEntry,
  ToolKind,
  ToolPart,
  ToolStatus,
} from "./timeline.js";

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────────────────────────────────────────────

export type JsonRpcId = string | number;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params?: P;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params?: P;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** ACP: the agent needs `authenticate` first. */
  AUTH_REQUIRED: -32000,
  /** ACP: a resource (file) was not found. */
  RESOURCE_NOT_FOUND: -32002,
} as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && "id" in value && value.id !== null;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && !("id" in value);
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isObject(value) && value.jsonrpc === "2.0" && !("method" in value) && ("result" in value || "error" in value);
}

// ── ACP content ─────────────────────────────────────────────────────────────────────────────────────────────────

export const ACP_PROTOCOL_VERSION = 1;

export type AcpAnnotations = { audience?: ("user" | "assistant")[]; priority?: number; lastModified?: string };

export type AcpContentBlock =
  | { type: "text"; text: string; annotations?: AcpAnnotations }
  | { type: "image"; data: string; mimeType: string; uri?: string; annotations?: AcpAnnotations }
  | { type: "audio"; data: string; mimeType: string; annotations?: AcpAnnotations }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string;
      title?: string;
      description?: string;
      size?: number;
      annotations?: AcpAnnotations;
    }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string });
      annotations?: AcpAnnotations;
    };

export type AcpToolKind = ToolKind;
export type AcpToolCallStatus = ToolStatus;

export type AcpToolCallContent =
  | { type: "content"; content: AcpContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
}

/** `tool_call`: a new tool call. */
export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** `tool_call_update` and `session/request_permission`'s `toolCall`: only the fields that changed. */
export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolCallStatus | null;
  /** Replaces the whole content collection. */
  content?: AcpToolCallContent[] | null;
  /** Replaces the whole location collection. */
  locations?: AcpToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface AcpConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpConfigSelectGroup {
  group: string;
  name: string;
  options: AcpConfigSelectOption[];
}

/** ACP session config option (`configOptions`). */
export interface AcpSessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select";
  currentValue: string;
  options: (AcpConfigSelectOption | AcpConfigSelectGroup)[];
}

/** The older ACP modes API, still reported by some agents. */
export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string | null }[];
}

export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCallUpdate)
  | { sessionUpdate: "plan"; entries: AcpPlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AcpAvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: AcpSessionConfigOption[] };

export type AcpSessionUpdateKind = AcpSessionUpdate["sessionUpdate"];

// ── ACP methods ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AcpImplementationInfo {
  name: string;
  title?: string;
  version: string;
}

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AcpAgentCapabilities {
  /** `session/load`: the agent reopens a session and replays it as `session/update`s before it answers. */
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  /** Session methods beyond new / load / prompt; each is supported when present (`{}`), not when absent or null. */
  sessionCapabilities?: {
    /** `session/resume`: reopen a session without replaying it. */
    resume?: Record<string, unknown> | null;
    close?: Record<string, unknown> | null;
  } | null;
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementationInfo;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: { id: string; name: string; description?: string | null }[];
  agentInfo?: AcpImplementationInfo;
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http" | "sse"; name: string; url: string; headers: { name: string; value: string }[] };

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
}

export interface AcpLoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServer[];
}

export interface AcpLoadSessionResult {
  modes?: AcpSessionModeState | null;
  configOptions?: AcpSessionConfigOption[] | null;
}

/** `session/resume` (agents with `sessionCapabilities.resume`): like `session/load`, without the replay. */
export interface AcpResumeSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers?: AcpMcpServer[];
}

export type AcpResumeSessionResult = AcpLoadSessionResult;

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

export interface AcpCancelParams {
  sessionId: string;
}

export interface AcpSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
}

export interface AcpSetConfigOptionResult {
  configOptions: AcpSessionConfigOption[];
}

export interface AcpSetModeParams {
  sessionId: string;
  modeId: string;
}

export interface AcpSessionNotificationParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

export type AcpRequestPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
}

export interface AcpReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface AcpWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

/** Client → agent requests: params and result per method. */
export interface AcpAgentMethods {
  initialize: { params: AcpInitializeParams; result: AcpInitializeResult };
  "session/new": { params: AcpNewSessionParams; result: AcpNewSessionResult };
  "session/load": { params: AcpLoadSessionParams; result: AcpLoadSessionResult | null };
  "session/resume": { params: AcpResumeSessionParams; result: AcpResumeSessionResult | null };
  "session/prompt": { params: AcpPromptParams; result: AcpPromptResult };
  "session/set_config_option": { params: AcpSetConfigOptionParams; result: AcpSetConfigOptionResult };
  "session/set_mode": { params: AcpSetModeParams; result: Record<string, never> | null };
}

/** Client → agent notifications. */
export interface AcpAgentNotifications {
  "session/cancel": AcpCancelParams;
}

/** Agent → client requests. */
export interface AcpClientMethods {
  "session/request_permission": { params: AcpRequestPermissionParams; result: AcpRequestPermissionResult };
  "fs/read_text_file": { params: AcpReadTextFileParams; result: { content: string } };
  "fs/write_text_file": { params: AcpWriteTextFileParams; result: Record<string, never> | null };
}

/** Agent → client notifications. */
export interface AcpClientNotifications {
  "session/update": AcpSessionNotificationParams;
}

export type AcpAgentMethod = keyof AcpAgentMethods;
export type AcpClientMethod = keyof AcpClientMethods;

// ── Mapping helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const TOOL_KINDS: ReadonlySet<string> = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const TOOL_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "failed"]);

function toolKind(value: unknown): ToolKind | undefined {
  return typeof value === "string" && TOOL_KINDS.has(value) ? (value as ToolKind) : undefined;
}

function toolStatus(value: unknown): ToolStatus | undefined {
  return typeof value === "string" && TOOL_STATUSES.has(value) ? (value as ToolStatus) : undefined;
}

/** Markdown-ish text of a content block (images and audio have none). */
/** The URI a link, image or embedded resource points at. */
function blockUri(block: AcpContentBlock): string | undefined {
  if (block.type === "resource_link") return block.uri;
  if (block.type === "image") return block.uri;
  if (block.type === "resource") return block.resource.uri;
  return undefined;
}

export function contentBlockText(block: AcpContentBlock | undefined): string {
  if (block === undefined) return "";
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.title ?? block.name}](${block.uri})`;
    case "resource":
      return "text" in block.resource ? block.resource.text : "";
    default:
      return "";
  }
}

/** ACP config options → aa.v3 `ConfigOption`s; grouped choices are flattened with their group name. */
export function configOptionsFromAcp(options: readonly AcpSessionConfigOption[]): ConfigOption[] {
  return options.map((option) => {
    const out: ConfigOption = { id: option.id, name: option.name, current: option.currentValue, options: [] };
    if (option.description) out.description = option.description;
    if (option.category) out.category = option.category;
    for (const choice of option.options) {
      if ("group" in choice) {
        for (const inner of choice.options) out.options.push(selectOption(inner, choice.name));
      } else {
        out.options.push(selectOption(choice));
      }
    }
    return out;
  });
}

function selectOption(choice: AcpConfigSelectOption, group?: string): ConfigOption["options"][number] {
  const out: ConfigOption["options"][number] = { value: choice.value, name: choice.name };
  if (choice.description) out.description = choice.description;
  if (group !== undefined) out.group = group;
  return out;
}

export const MODE_CONFIG_ID = "mode";

/** The older modes API as a `mode` config option, so clients render one kind of setting. */
export function configOptionFromModes(modes: AcpSessionModeState): ConfigOption {
  return {
    id: MODE_CONFIG_ID,
    name: "Mode",
    category: "mode",
    current: modes.currentModeId,
    options: modes.availableModes.map((mode) => {
      const option: ConfigOption["options"][number] = { value: mode.id, name: mode.name };
      if (mode.description) option.description = mode.description;
      return option;
    }),
  };
}

/** Config options of a `session/new` / `session/resume` / `session/load` result. */
export function configFromSessionResult(result: AcpNewSessionResult | AcpLoadSessionResult | null | undefined): ConfigOption[] {
  if (result == null) return [];
  if (result.configOptions) return configOptionsFromAcp(result.configOptions);
  if (result.modes) return [configOptionFromModes(result.modes)];
  return [];
}

/** `current_mode_update`: the mode setting (the `mode` option, or any option of the `mode` category) now reads `modeId`. */
export function configWithMode(config: readonly ConfigOption[], modeId: string): ConfigOption[] {
  // The agent's mode, never the Connector's own approvals setting (also shown as a mode).
  return config.map((option) =>
    option.id !== PI_APPROVALS_CONFIG_ID && (option.id === MODE_CONFIG_ID || option.category === "mode") ? { ...option, current: modeId } : option,
  );
}

function planEntries(entries: readonly AcpPlanEntry[]): PlanEntry[] {
  return entries.map((entry) => {
    const out: PlanEntry = { content: entry.content, status: entry.status };
    if (entry.priority) out.priority = entry.priority;
    return out;
  });
}

/**
 * Apply an ACP tool call (or update) to a tool part. `output` is the agent's rawOutput once it gave one; until
 * then the text (or terminal) content stands for it. Returns whether the output is now a rawOutput.
 */
function applyToolFields(part: ToolPart, fields: AcpToolCallUpdate, hasRawOutput: boolean): boolean {
  if (fields.title != null) part.title = fields.title;
  const kind = toolKind(fields.kind);
  if (kind !== undefined) part.kind = kind;
  const status = toolStatus(fields.status);
  if (status !== undefined) part.status = status;
  if (fields.rawInput !== undefined) part.input = fields.rawInput;
  if (fields.locations != null) {
    part.locations = fields.locations.map((location) => {
      const out: { path: string; line?: number } = { path: location.path };
      if (typeof location.line === "number") out.line = location.line;
      return out;
    });
  }
  if (fields.content != null) {
    const diffs: NonNullable<ToolPart["diffs"]> = [];
    const texts: string[] = [];
    const terminals: string[] = [];
    for (const item of fields.content) {
      if (item.type === "diff") {
        const diff: { path: string; old_text?: string; new_text: string } = { path: item.path, new_text: item.newText };
        if (typeof item.oldText === "string") diff.old_text = item.oldText;
        diffs.push(diff);
      } else if (item.type === "content") {
        const text = contentBlockText(item.content);
        if (text) texts.push(text);
      } else if (item.type === "terminal") {
        terminals.push(item.terminalId);
      }
    }
    if (diffs.length > 0) part.diffs = diffs;
    else delete part.diffs;
    if (!hasRawOutput) {
      if (texts.length > 0) part.output = texts.join("\n");
      else if (terminals.length > 0) part.output = { terminal_id: terminals[0] };
      else delete part.output;
    }
  }
  if (fields.rawOutput !== undefined) {
    part.output = fields.rawOutput;
    return true;
  }
  return hasRawOutput;
}

// ── Projector ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface AcpTimelineProjectorOptions {
  store: SessionStore;
  /** The aa.v3 session id (not the agent's ACP session id). */
  sessionId: string;
  /** Id factory for items and requests, for tests. */
  newId?: () => string;
  /** Told of `available_commands_update` (slash commands are not part of the timeline). */
  onAvailableCommands?: (commands: AcpAvailableCommand[]) => void;
  /** Applied to the settings the agent reports before they are stored (the Connector adds its own: approvals). */
  decorateConfig?: (config: ConfigOption[]) => ConfigOption[];
}

interface OpenStretch {
  kind: "text" | "thinking";
  id: string;
  text: string;
}

interface ToolEntry {
  messageId: string;
  part: ToolPart;
  done: boolean;
  rawOutput: boolean;
}

interface PendingPermission {
  requestId: string;
  options: AcpPermissionOption[];
  resolve: (result: AcpRequestPermissionResult) => void;
}

/**
 * Projects one session's ACP stream into a `SessionStore`:
 *
 * - consecutive `agent_message_chunk`s grow one `TextPart` item, `agent_thought_chunk`s one `ThinkingPart`; any
 *   other step (a tool call, the plan, the other kind of text) closes the stretch (`done: true`);
 * - `tool_call` / `tool_call_update` keep one `ToolPart` item per `toolCallId`, done once completed or failed;
 * - `plan` keeps one `PlanPart` item per turn, replaced whole;
 * - `config_option_update` / `current_mode_update` replace `session.config`;
 * - `session/request_permission` becomes a `PendingRequest`; the first answer in the store resolves the agent's
 *   request, `endTurn` cancels whatever is still waiting.
 *
 * Every item of a turn carries the turn's `turn_id` (the user message that started it). Output arriving outside a
 * turn opens an autonomous one whose `turn_id` is its first item's id.
 */
const CONTENT_UPDATES = new Set<string>(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

export class AcpTimelineProjector {
  readonly sessionId: string;
  availableCommands: AcpAvailableCommand[] = [];

  private readonly store: SessionStore;
  private readonly newId: () => string;
  private readonly onAvailableCommands: AcpTimelineProjectorOptions["onAvailableCommands"];
  private readonly decorate: (config: ConfigOption[]) => ConfigOption[];
  private readonly unsubscribe: () => void;

  private turnId: string | undefined;
  private autonomous = false;
  /**
   * The turn's latest item (highest seq). A cancelled turn marks it interrupted even when the agent already closed
   * every item itself (Pi fails its running tool call on cancel), so the thread still shows the turn was stopped.
   */
  private turnLast: AssistantMessage | undefined;
  private stretch: OpenStretch | undefined;
  private planId: string | undefined;
  private plan: PlanEntry[] = [];
  private readonly tools = new Map<string, ToolEntry>();
  private readonly permissions = new Map<string, PendingPermission>();
  private replayUser: { text: string } | undefined;
  private replayCount = 0;
  /** What is left of this turn's prompt that the agent may still echo back as `user_message_chunk`s. */
  private echo: { text: string; uris: Set<string> } | undefined;

  constructor(options: AcpTimelineProjectorOptions) {
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.onAvailableCommands = options.onAvailableCommands;
    this.decorate = options.decorateConfig ?? ((config) => config);
    this.unsubscribe = this.store.addAnswerListener((sessionId, result) => {
      if (sessionId !== this.sessionId) return;
      const pending = this.permissions.get(result.request.request_id);
      if (pending === undefined) return;
      this.permissions.delete(result.request.request_id);
      pending.resolve({ outcome: { outcome: "selected", optionId: result.answered.option_id } });
    });
  }

  /** The turn now running, if any. */
  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  /**
   * Start a turn for the user message `turnId` (call before `session/prompt`). Pass the prompt so that agents which
   * echo it back as `user_message_chunk` (Antigravity does) don't get it recorded as a second user message.
   */
  beginTurn(turnId: string, prompt?: readonly AcpContentBlock[]): void {
    this.flushReplayUser();
    if (this.turnId !== undefined) this.closeTurnItems(false);
    this.turnId = turnId;
    this.turnLast = undefined;
    this.autonomous = false;
    // Text is matched by prefix; links and images by URI (agents echo them with their own names).
    const text = prompt?.filter((block) => block.type === "text").map((block) => contentBlockText(block)).join("") ?? "";
    const uris = new Set((prompt ?? []).map(blockUri).filter((uri): uri is string => uri !== undefined));
    this.echo = text.trim().length > 0 || uris.size > 0 ? { text, uris } : undefined;
    this.store.updateControl(this.sessionId, { state: "running", error: undefined });
  }

  /** The `session/prompt` result (or a failure): close the turn's items and cancel waiting permissions. */
  endTurn(stopReason: AcpStopReason | "error" = "end_turn", error?: string): void {
    this.echo = undefined;
    this.flushReplayUser();
    const interrupted = stopReason === "cancelled" || stopReason === "error";
    this.closeTurnItems(interrupted);
    const last = this.turnLast;
    this.turnLast = undefined;
    if (interrupted && last !== undefined) {
      const current = this.store.getMessage(this.sessionId, last.id);
      if (current?.role === "assistant" && !current.interrupted) this.markInterrupted(current);
    }
    this.cancelPermissions();
    this.turnId = undefined;
    this.autonomous = false;
    if (stopReason === "error") this.store.updateControl(this.sessionId, { state: "error", error: error ?? "the agent failed" });
    else this.store.updateControl(this.sessionId, { state: "idle", error: undefined });
  }

  /** A `session/update` notification's `update`. */
  handleUpdate(update: AcpSessionUpdate): void {
    // Only real output ends the window in which a prompt echo is expected; metadata updates may come first.
    if (CONTENT_UPDATES.has(update.sessionUpdate)) this.echo = undefined;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.userChunk(update.content);
        return;
      case "agent_message_chunk":
        this.appendStretch("text", contentBlockText(update.content));
        return;
      case "agent_thought_chunk":
        this.appendStretch("thinking", contentBlockText(update.content));
        return;
      case "tool_call":
        this.toolCall(update, true);
        return;
      case "tool_call_update":
        this.toolCall(update, false);
        return;
      case "plan":
        this.setPlan(planEntries(update.entries));
        return;
      case "config_option_update":
        this.store.updateSession(this.sessionId, { config: this.decorate(configOptionsFromAcp(update.configOptions)) });
        return;
      case "current_mode_update":
        this.setMode(update.currentModeId);
        return;
      case "available_commands_update":
        this.availableCommands = [...update.availableCommands];
        this.onAvailableCommands?.(this.availableCommands);
        return;
      default:
        return; // unknown kinds are ignored
    }
  }

  /** A `session/update` notification's params (ignored when it is for another ACP session). */
  handleNotification(params: AcpSessionNotificationParams, acpSessionId?: string): void {
    if (acpSessionId !== undefined && params.sessionId !== acpSessionId) return;
    this.handleUpdate(params.update);
  }

  /** Whether the agent has reported this tool call in the turn now running. */
  hasToolCall(toolCallId: string): boolean {
    return this.tools.has(toolCallId);
  }

  /**
   * An agent → client `session/request_permission`. Resolves with the first answer the store accepts, or
   * `cancelled` when the turn ends first.
   */
  requestPermission(params: AcpRequestPermissionParams): { request: PendingRequest; outcome: Promise<AcpRequestPermissionResult> } {
    this.flushReplayUser();
    const entry = this.toolCall({ ...params.toolCall }, !this.tools.has(params.toolCall.toolCallId));
    const request: PendingRequest = {
      request_id: this.newId(),
      message_id: entry.messageId,
      tool_call_id: entry.part.id,
      title: params.toolCall.title ?? entry.part.title,
      options: params.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
    };
    const outcome = new Promise<AcpRequestPermissionResult>((resolve) => {
      this.permissions.set(request.request_id, { requestId: request.request_id, options: params.options, resolve });
    });
    this.store.addPendingRequest(this.sessionId, request);
    return { request, outcome };
  }

  /** Stop listening to the store; waiting permissions are cancelled. */
  dispose(): void {
    this.cancelPermissions();
    this.unsubscribe();
  }

  // ── Internals ──

  private ensureTurn(firstItemId: string): string {
    if (this.turnId === undefined) {
      this.turnId = firstItemId;
      this.autonomous = true;
    }
    return this.turnId;
  }

  private write(id: string, part: AssistantPart, done: boolean): AssistantMessage {
    const turnId = this.ensureTurn(id);
    const item: AssistantItemInput = { id, turn_id: turnId, done, parts: [part] };
    if (this.autonomous) item.autonomous = true;
    const message = this.store.upsertAssistantItem(this.sessionId, item);
    if (this.turnLast === undefined || message.seq >= this.turnLast.seq) this.turnLast = message;
    return message;
  }

  private appendStretch(kind: OpenStretch["kind"], text: string): void {
    this.flushReplayUser();
    if (this.stretch !== undefined && this.stretch.kind !== kind) this.closeStretch();
    if (this.stretch === undefined) {
      if (text.length === 0) return;
      this.stretch = { kind, id: this.newId(), text: "" };
    }
    this.stretch.text += text;
    this.write(this.stretch.id, { type: kind, text: this.stretch.text }, false);
  }

  private closeStretch(interrupted = false): void {
    const stretch = this.stretch;
    if (stretch === undefined) return;
    this.stretch = undefined;
    const message = this.write(stretch.id, { type: stretch.kind, text: stretch.text }, true);
    if (interrupted) this.markInterrupted(message);
  }

  private toolCall(fields: AcpToolCallUpdate, isNew: boolean): ToolEntry {
    this.flushReplayUser();
    let entry = this.tools.get(fields.toolCallId);
    if (entry === undefined || (isNew && entry.done)) {
      this.closeStretch();
      entry = {
        messageId: this.newId(),
        part: { type: "tool", id: fields.toolCallId, title: "", kind: "other", status: "pending" },
        done: false,
        rawOutput: false,
      };
      this.tools.set(fields.toolCallId, entry);
    }
    entry.rawOutput = applyToolFields(entry.part, fields, entry.rawOutput);
    if (!entry.part.title) entry.part.title = fields.toolCallId;
    entry.done = entry.part.status === "completed" || entry.part.status === "failed";
    this.write(entry.messageId, structuredClone(entry.part), entry.done);
    return entry;
  }

  private setPlan(entries: PlanEntry[]): void {
    this.flushReplayUser();
    this.closeStretch();
    if (this.planId === undefined) this.planId = this.newId();
    this.plan = entries;
    this.write(this.planId, { type: "plan", entries: structuredClone(entries) }, false);
  }

  private setMode(modeId: string): void {
    const session = this.store.get(this.sessionId);
    if (session === undefined) return;
    this.store.updateSession(this.sessionId, { config: configWithMode(session.config, modeId) });
  }

  /** `session/load` replays history: user chunks become one user message that opens the next turn. */
  private userChunk(block: AcpContentBlock): void {
    if (this.echo !== undefined && this.replayUser === undefined && this.turnId !== undefined && !this.autonomous) {
      // The agent echoing the prompt of the turn we started: already recorded.
      const echo = this.echo;
      const uri = blockUri(block);
      if (block.type !== "text" && uri !== undefined && echo.uris.delete(uri)) {
        if (echo.text.trim().length === 0 && echo.uris.size === 0) this.echo = undefined;
        return;
      }
      if (block.type === "text") {
        const rest = echo.text.trimStart();
        const chunk = block.text.trimStart();
        if (chunk.length === 0 || rest.startsWith(chunk)) {
          echo.text = rest.slice(chunk.length);
          if (echo.text.trim().length === 0 && echo.uris.size === 0) this.echo = undefined;
          return;
        }
      }
      this.echo = undefined;
    }
    if (this.replayUser === undefined) {
      if (this.turnId !== undefined) this.closeTurnItems(false);
      this.turnId = undefined;
      this.replayUser = { text: "" };
    }
    this.replayUser.text += contentBlockText(block);
  }

  private flushReplayUser(): void {
    const replay = this.replayUser;
    if (replay === undefined) return;
    this.replayUser = undefined;
    const { message } = this.store.appendUserMessage(this.sessionId, {
      client_msg_id: `acp-replay:${this.newId()}:${this.replayCount++}`,
      content: replay.text || " ",
    });
    this.turnId = message.id;
    this.autonomous = false;
  }

  private closeTurnItems(interrupted: boolean): void {
    this.closeStretch(interrupted);
    if (this.planId !== undefined) {
      const message = this.write(this.planId, { type: "plan", entries: structuredClone(this.plan) }, true);
      if (interrupted) this.markInterrupted(message);
    }
    this.planId = undefined;
    this.plan = [];
    for (const entry of this.tools.values()) {
      if (entry.done) continue;
      entry.done = true;
      const message = this.write(entry.messageId, structuredClone(entry.part), true);
      if (interrupted) this.markInterrupted(message);
    }
    this.tools.clear();
  }

  private markInterrupted(message: AssistantMessage): void {
    const { seq: _seq, role: _role, ...rest } = message;
    this.store.upsertAssistantItem(this.sessionId, { ...rest, interrupted: true });
  }

  private cancelPermissions(): void {
    for (const pending of this.permissions.values()) {
      this.store.removePendingRequest(this.sessionId, pending.requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissions.clear();
  }
}
