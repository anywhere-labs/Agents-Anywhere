// RuntimeSession port (04-connector.md §4): the session engine talks to Runtimes only through it.
//
// Implemented by the ACP adapters under runtime/ (Codex, Claude, Pi, Hermes, generic ACP, the two DSH routes) and
// the runtime/dsh-bridge2 compatibility adapter. ACP types do not cross this port: everything here is AA vocabulary.
//
// Conventions:
// - Adapters translate native updates into RuntimeEvents and compute Timeline item IDs by the identity rules
//   (domain/identity, contracts/identity-vectors); projecting into TimelineItems, persisting, ordering and outbound delivery belong to Conversation.
// - "Never resend an unknown outcome": when prompt / steer cannot get a definite result it returns outcome=unknown, and callers must not retry automatically.
// - Capabilities come only from negotiation and dialect declarations, never hardcoded by provider name (docs/api/capabilities.md).

import type { JsonValue } from '../../domain/identity/index.js'
import type { GoalState } from '../../generated/protocol/v1_2/goal-state.js'
import type { ProtocolModelCatalog } from '../../generated/protocol/v1_2/model-catalog.js'
import type { ProtocolPermissionCatalog } from '../../generated/protocol/v1_2/permission-catalog.js'
import type { PlanDocument } from '../../generated/protocol/v1_2/plan-document.js'

// ---------------------------------------------------------------------------------------------
// Basic vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * Runtime kind. It is an input to session IDs and Timeline IDs, so the values must match the existing `runtime_type` exactly:
 * `codex`, `claude`, `pi`, `hermes`, `dsh`, and official ACP Agents such as `opencode`, `antigravity`, `codebuddy`,
 * `commandcode`, `mimo`, `minimax`.
 */
export type RuntimeType = 'codex' | 'claude' | 'pi' | 'hermes' | 'dsh' | (string & {})

export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * AA capability ID (docs/api/capabilities.md, 04-connector.md §5.1). Kept open as string so dialects can declare new capabilities,
 * but known IDs should use the literals here so they stay searchable.
 */
export type CapabilityId =
  | 'session.send_message'
  | 'session.steer'
  | 'session.interrupt'
  | 'session.queue'
  | 'session.interaction.approval'
  | 'session.interaction.form'
  | 'session.commands'
  | 'session.planning'
  | 'session.plan_document'
  | 'session.plan_review'
  | 'session.goal'
  | 'session.configuration.read'
  | 'session.configuration.update'
  | 'session.fork'
  | 'session.archive'
  | 'session.rename'
  | 'session.list'
  | 'session.history.native'
  | 'runtime.attachment'
  | 'catalog.model'
  | 'catalog.effort'
  | 'catalog.permission'
  | (string & {})

export interface Capability {
  readonly id: CapabilityId
  /** Whether the Runtime has it (negotiation + dialect). */
  readonly supported: boolean
  /** Whether it can be used in the current state (session busy, writer is not us, etc.). Defaults to supported. */
  readonly available?: boolean
  readonly unavailableReason?: string
  /** Capability parameters, e.g. the MIME types allowed for attachments. */
  readonly parameters?: JsonObject
}

export interface RuntimeCapabilities {
  /** Incremented on every capability change; Conversation uses it to decide whether to re-emit the capability event. */
  readonly revision: number
  readonly items: readonly Capability[]
}

export type SessionCapabilities = RuntimeCapabilities

/** Stable error code; values are listed in contracts/runtime-errors. */
export interface RuntimeError {
  readonly code: string
  readonly message: string
  /** Whether a manual retry by the user is worthwhile; adapters never automatically retry writes whose outcome is unknown. */
  readonly retryable?: boolean
  readonly details?: JsonObject
}

// ---------------------------------------------------------------------------------------------
// Providers and instances
// ---------------------------------------------------------------------------------------------

export interface RuntimeProvider {
  readonly type: RuntimeType
  /** Installation, versions, config schema, instance policy; starts no long-lived process. */
  discover(): Promise<ProviderFacts>
  start(instance: RuntimeInstanceConfig): Promise<RuntimeHandle>
  /** Checks an instance's settings (and model gateway) before anything starts; throws a coded error on refusal. */
  validateSettings?(settings: JsonObject, modelGateway?: ModelGatewayConfig): unknown
  /** The whole instance settings form (schema, field layout, defaults), for providers that define one. */
  instanceSchema?(): InstanceConfigSchema
}

/** An instance settings form: the JSON Schema of the settings, the field layout and the defaults. */
export interface InstanceConfigSchema {
  readonly schema: JsonObject
  readonly uiSchema?: JsonObject
  readonly defaults?: JsonObject
}

export interface ProviderFacts {
  readonly type: RuntimeType
  readonly displayName: string
  readonly installed: boolean
  /** Adapter version, e.g. codex-acp 2.6.0. */
  readonly adapterVersion?: string
  /** Version of the driven Agent, e.g. Codex CLI 0.163.0, Claude Code 2.1.x. */
  readonly agentVersion?: string
  /** Other versions shown in device details, e.g. the Codex App version. */
  readonly extraVersions?: Readonly<Record<string, string>>
  /** User-facing reasons such as not installed, missing credentials or a version that is too old. */
  readonly problems: readonly RuntimeError[]
  /** JSON Schema of the instance config; only fields the Profile defines, never arbitrary command/args/env. */
  readonly configSchema?: JsonObject
  /** How many instances one device can run. */
  readonly instancePolicy: 'single' | 'multiple'
  /** Whether the adapter process is shared by all sessions or one per session. */
  readonly processScope: 'shared' | 'perSession'
}

export interface RuntimeInstanceConfig {
  /** Instance ID (a named instance has its own session namespace, see domain/identity sessionNamespace). */
  readonly instanceId: string
  readonly sessionNamespace: string
  /** Only the fields configSchema allows. */
  readonly settings: JsonObject
  /** Model gateway: injected by the Profile as environment variables or config; instance config never passes through arbitrary env. */
  readonly modelGateway?: ModelGatewayConfig
}

export interface ModelGatewayConfig {
  readonly baseUrl: string
  readonly authToken: string
  readonly protocol: 'anthropic' | 'openai-responses' | 'openai-chat'
  readonly model?: string
}

export interface RuntimeHandle {
  readonly type: RuntimeType
  readonly instanceId: string
  /** Runtime-level capabilities (session-level ones are on RuntimeSession.capabilities). */
  capabilities(): RuntimeCapabilities
  /** `sessionId`: the open session whose current configuration to describe (else the most recently opened). */
  catalogs(sessionId?: string): Promise<Catalogs>
  /** Native session directory (Codex threads, Claude/Pi local sessions...). */
  listNativeSessions(cursor?: string): Promise<NativeSessionPage>
  /** Read-only history: no resume, no write lock, nothing appended to the native record. */
  readNativeHistory(ref: NativeSessionRef, window: HistoryWindow): Promise<NativeHistoryPage>
  /** Opens (creates or attaches to) a session. */
  open(target: OpenTarget, options: OpenOptions): Promise<RuntimeSession>
  /**
   * Workspace preparation (capability `runtime.workspace.prepare`): creates the native session in a directory before
   * the AA session exists, so its real options and catalog can be read; `adopt` hands it to the session engine on
   * the first message. A Runtime without it does not declare the capability and clients create sessions directly.
   */
  prepare?(spec: NewSessionSpec, options: PrepareOptions): Promise<PreparedSession>
  /** Runtime-level events: native session directory changes, runtime status, follow suggestions, etc. */
  readonly events: AsyncIterable<RuntimeHandleEvent>
  /**
   * Releases the external holder of a native session (Codex: quits the Codex App holding the thread). When present, capability `runtime.owner_release` is supported.
   * Two steps: first draft a plan to show the user; execute only after the user explicitly agrees in the AA session that triggered it.
   */
  readonly ownerRelease?: OwnerReleasePort
  /**
   * The Agent processes this instance runs on this computer and the AA sessions each one serves, the session with
   * a turn in progress first. Port preview associates a listening port with a session through them. A Runtime
   * whose Agent runs in another program (DSH) leaves it out.
   */
  agentProcesses?(): readonly AgentProcessInfo[]
  stop(): Promise<void>
}

/** One Agent process of a Runtime instance (`RuntimeHandle.agentProcesses`). */
export interface AgentProcessInfo {
  readonly pid: number
  /** AA session ids (a prepared session's preparation id until it is adopted); empty when no session is open. */
  readonly sessionIds: readonly string[]
}

/**
 * Releasing an external holder, confirmed at the session level (in the same AA session that triggered it). When opening an existing session fails
 * with `details.ownerRelease === 'available'`, the session engine calls `prepare` and hands the plan to clients as a confirmation in that session;
 * after the user agrees it calls `execute` and reopens; when the user declines or leaves it calls `discard`.
 */
export interface OwnerReleasePort {
  prepare(ref: NativeSessionRef, context: { readonly sessionId: string }): Promise<OwnerReleasePrepareResult>
  /** Call only after the user explicitly agreed to this plan. `force`: allows a forced kill if the holder has not exited after the grace period (needs separate consent). */
  execute(planId: string, consent: { readonly force: boolean }): Promise<OwnerReleaseOutcome>
  discard(planId: string): void
}

export type OwnerReleasePrepareResult =
  | { readonly status: 'plan'; readonly plan: OwnerReleasePlan }
  /** Can already be opened (can follow, or nobody holds it); no release needed. */
  | { readonly status: 'not_needed' }
  | { readonly status: 'unavailable'; readonly reason: 'owner_not_running' | 'platform_unsupported' | 'process_table_unavailable' }

export interface OwnerReleasePlan {
  readonly planId: string
  /** The AA session that triggered it; the confirmation is shown only in this session. */
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly expiresAt: number
  /** The holder to terminate (for display). */
  readonly owner: { readonly displayName: string; readonly processCount: number }
  /** Other sessions the holder is using are released too (all threads of the Codex App). */
  readonly releasesOtherSessions: boolean
  /** Grace period (ms): a normal exit is requested first; force is needed only after it times out. */
  readonly gracePeriodMs: number
  /** Runtime-specific details (process PIDs, write lock state); clients do not depend on their shape. */
  readonly details?: JsonObject
}

export interface OwnerReleaseOutcome {
  readonly status:
    | 'released' | 'already_released'
    /** Plan expired, already used, or the processes changed: prepare again and ask for consent again. */
    | 'plan_expired' | 'plan_changed'
    /** Still running after the grace period, and force was not agreed. */
    | 'survivors'
    /** The processes exited but the session is still held. */
    | 'still_held'
  readonly details?: JsonObject
}

export interface Catalogs {
  readonly models?: ProtocolModelCatalog
  readonly permissions?: ProtocolPermissionCatalog
  /** Current selections (selection IDs, rules in domain/identity selection). */
  readonly selections?: Readonly<Record<string, string | null>>
}

export type RuntimeHandleEvent =
  | { readonly type: 'status'; readonly status: 'starting' | 'ready' | 'degraded' | 'stopped'; readonly error?: RuntimeError }
  | { readonly type: 'native_sessions.changed'; readonly sessions: readonly NativeSessionSummary[]; readonly removed: readonly string[] }
  /** The companion layer found a native session that should be taken over (e.g. a thread newly opened in the Codex App). The session engine decides whether to open it. */
  | { readonly type: 'native_session.follow_suggested'; readonly ref: NativeSessionRef; readonly reason: string }
  | { readonly type: 'capabilities.changed'; readonly capabilities: RuntimeCapabilities }
  | { readonly type: 'catalogs.changed'; readonly catalogs: Catalogs }

// ---------------------------------------------------------------------------------------------
// Native sessions and history
// ---------------------------------------------------------------------------------------------

export interface NativeSessionRef {
  /** The Runtime's own session ID (Codex threadId, Claude session uuid, ACP sessionId). */
  readonly nativeSessionId: string
  /** Location of the native record, for Runtimes like Pi that tell sessions apart by file. */
  readonly locator?: string
  /** Working directory of the session: where an ACP Agent opens it again (`session/load`, `session/resume`). */
  readonly cwd?: string
}

export interface NativeSessionSummary extends NativeSessionRef {
  readonly title?: string
  readonly cwd?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly archived?: boolean
  /** Another writer (a CLI in a terminal, the Codex App) is using it. */
  readonly inUse?: boolean
  /** Who the writer is: this Connector, external (App/CLI), nobody, unknown. */
  readonly writer?: WriterState
  /** A session AA itself created or used (including earlier Connector versions). */
  readonly ownedByAgentsAnywhere?: boolean
  /**
   * The current permission of a session not yet opened: a permission selection ID, the same value as the permission catalog's `ProtocolPermissionItem.selectionId`.
   * Filled in by the Runtime (the Codex companion layer reads the settings record at the end of the rollout); left out when unreadable or not applicable, never defaulted.
   * For an open session the session configuration is authoritative.
   */
  readonly permission?: string
}

export interface NativeSessionPage {
  readonly sessions: readonly NativeSessionSummary[]
  readonly nextCursor?: string
}

export interface HistoryWindow {
  /** When absent, start from the newest page. */
  readonly cursor?: string
  readonly limit: number
  readonly direction?: 'older' | 'newer'
}

export interface NativeHistoryPage {
  /** History items with IDs computed by the identity rules, oldest first. */
  readonly items: readonly HistoryItem[]
  readonly olderCursor?: string
  readonly newerCursor?: string
}

/** History items and live events share one item shape and the same ID rules (replaying the same content keeps its ID). */
export type HistoryItem = TimelineItemEvent

// ---------------------------------------------------------------------------------------------
// Opening sessions
// ---------------------------------------------------------------------------------------------

export type OpenTarget =
  | { readonly kind: 'new'; readonly spec: NewSessionSpec }
  | { readonly kind: 'existing'; readonly ref: NativeSessionRef }

export interface NewSessionSpec {
  readonly cwd: string
  readonly title?: string
  /** Initial selections (model, permission, effort, plan mode), as selection IDs. */
  readonly selections?: Readonly<Record<string, string | null>>
  /** Used by Runtimes that accept a given native ID (the DSH plugin route); ignored by the rest. */
  readonly preferredNativeSessionId?: string
  readonly additionalDirectories?: readonly string[]
}

export interface OpenOptions {
  /** AA platform session ID (domain/identity session). */
  readonly sessionId: string
  /**
   * Whether attaching to an existing session replays history into events:
   * - none: just attach; live events are pushed as usual afterwards;
   * - full: push the full history (HistoryItem) first, then live events.
   */
  readonly replay: 'none' | 'full'
  /** The last native item already in the local store, for incremental replay (when supported). */
  readonly replayAfter?: string
}

// ---------------------------------------------------------------------------------------------
// Workspace preparation
// ---------------------------------------------------------------------------------------------

export interface PrepareOptions {
  /** The preparation id: the native session uses it as its AA session id until `adopt` gives it the real one. */
  readonly preparationId: string
}

/**
 * A native session prepared ahead of its AA session. While prepared, its options are read and the Agent's requests
 * answered; after `adopt` it is an ordinary `RuntimeSession` with the same event stream (whoever consumed the
 * events during the preparation stays their only consumer).
 */
export interface PreparedSession {
  readonly nativeSessionId: string
  /** The session's current options as the Agent reported them (model, effort, permission and the rest). */
  readonly configOptions: readonly ConfigOption[]
  /** The option that carries plan mode: kept out of the new-session options, plan mode is set through a planning intent only. */
  readonly planningOptionId: string | null
  /** Whether plan mode can be entered before the first message. */
  readonly canPlan: boolean
  /** The session's model catalog (selection ids by the Runtime's rule). */
  catalogs(): Promise<Catalogs>
  /** Events while prepared: the Agent's requests (authentication, forms), option and command changes, the session going away. */
  readonly events: AsyncIterable<RuntimeEvent>
  respond(interactionId: string, answer: InteractionAnswer): Promise<void>
  /** Why the selections and configuration do not map onto the session options; null when they do. */
  check(frozen: FrozenCreation): RuntimeError | null
  /** Hands the session to the session engine: item ids follow the AA session id from now on, and the frozen choices are applied. Once only. */
  adopt(sessionId: string, frozen: FrozenCreation): Promise<RuntimeSession>
  /** Gives it up (cancel, expiry, Connector stop): closes the native session without deleting its native record. */
  close(): Promise<void>
}

/** The first message's choices, frozen at the reservation and applied at the creation (runtime-workflows 1.2 `selections` and `configuration`). */
export interface FrozenCreation {
  readonly selections: Readonly<Record<string, string | null>>
  readonly configuration: Readonly<Record<string, string | boolean>>
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export interface RuntimeSession {
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly capabilities: SessionCapabilities
  /** Sends a message and starts a turn. Returns once the Runtime accepts it (or definitely rejects it, or the outcome is unknown), without waiting for the turn to end. */
  prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance>
  /** Adds input while a turn runs. Absent without the session.steer capability. */
  steer?(input: PromptInput, delivery: DeliveryRef): Promise<SteerResult>
  /** Interrupts the current turn; a mismatched expectedTurnId leaves later turns alone. */
  cancel(expectedTurnId?: string): Promise<void>
  /** Answers approvals, forms, plan reviews and questions. */
  respond(interactionId: string, answer: InteractionAnswer): Promise<void>
  /** Changes config options such as model, permission, mode and effort. */
  configure(change: ConfigChange): Promise<ConfigResult>
  /** Slash command, e.g. /compact. */
  command(name: string, args?: string): Promise<CommandResult>
  readonly goal?: GoalPort
  readonly planning?: PlanningPort
  /** Stream already translated into internal events; ends after the session closes. */
  readonly events: AsyncIterable<RuntimeEvent>
  /** Releases the session (does not delete the native record). */
  close(): Promise<void>
}

export interface PromptInput {
  readonly text: string
  readonly attachments?: readonly PromptAttachment[]
}

export type PromptAttachment = (
  /** Local file the Connector already downloaded; Runtimes that accept local paths (Codex etc.) use the path directly so data URLs do not bloat the native record. */
  | { readonly kind: 'file'; readonly path: string; readonly mimeType: string; readonly name?: string }
  | { readonly kind: 'inline'; readonly data: string; readonly mimeType: string; readonly name?: string }
  | { readonly kind: 'link'; readonly uri: string; readonly name?: string; readonly mimeType?: string }
) & {
  /**
   * The attachment's platform identity (from the client's upload record). Runtimes that can write it into the native record (Pi writes it into the user message's
   * `aaAttachments`) do so, so reading or replaying history restores the attachment on the Timeline.
   */
  readonly info?: AttachmentInfo
}

/** Platform attachment: the shape of a Timeline user message's `content.attachments[]` (no local paths). */
export interface AttachmentInfo {
  readonly fileId: string
  readonly name: string
  readonly mediaType: string
  readonly size?: number
  readonly sha256?: string
}

/** Delivery record: used for idempotency, acceptance decisions and the user message's Timeline ID. */
export interface DeliveryRef {
  readonly deliveryId: string
  /** Client-generated message ID (`client_message_id`). */
  readonly clientMessageId: string
}

export type PromptAcceptance =
  | { readonly outcome: 'accepted'; readonly turnId?: string; readonly userItemId?: string }
  | { readonly outcome: 'rejected'; readonly error: RuntimeError }
  /** Sent, but acceptance cannot be confirmed (timeout, process exit). Callers must not resend automatically. */
  | { readonly outcome: 'unknown'; readonly error: RuntimeError }

export type SteerResult =
  | { readonly outcome: 'injected'; readonly turnId?: string; readonly userItemId?: string }
  /** The Runtime was idle and started this input as a new turn. */
  | { readonly outcome: 'started_new_turn'; readonly turnId?: string; readonly userItemId?: string }
  /** The Runtime is idle and will not start a turn by itself: callers should use prompt instead (or requeue). */
  | { readonly outcome: 'prompt_required' }
  | { readonly outcome: 'rejected'; readonly error: RuntimeError }
  | { readonly outcome: 'unknown'; readonly error: RuntimeError }

export type InteractionAnswer =
  /** Approval: picks one of the options the Runtime offered. */
  | { readonly kind: 'option'; readonly optionId: string }
  /** Form / question. */
  | { readonly kind: 'form'; readonly action: 'accept' | 'decline' | 'cancel'; readonly values?: JsonObject }
  /** Plan review: approve and execute, revise the plan (with feedback), or not now. */
  | { readonly kind: 'plan_review'; readonly action: 'approve' | 'revise' | 'dismiss'; readonly feedback?: string; readonly planContentHash?: string }
  /** Cancelled (the user closed the dialog or the session was interrupted). */
  | { readonly kind: 'cancelled' }

export interface ConfigChange {
  /** Config option ID (the Runtime's native ID, from the config.updated event). */
  readonly optionId: string
  readonly value: string | boolean
}

export interface ConfigResult {
  readonly options: readonly ConfigOption[]
  /** When changed mid-turn, some Runtimes apply it from the next turn. */
  readonly appliesFrom: 'now' | 'next_turn'
}

export interface ConfigOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Mapping to the AA catalog: model / effort / permission / mode / collaboration_mode / other. */
  readonly category: 'model' | 'effort' | 'permission' | 'mode' | 'collaboration_mode' | 'other'
  readonly type: 'select' | 'boolean'
  readonly currentValue: string | boolean
  readonly values?: readonly { readonly value: string; readonly name: string; readonly description?: string; readonly group?: string }[]
}

export interface CommandResult {
  readonly ok: boolean
  readonly message?: string
  readonly error?: RuntimeError
}

export interface GoalPort {
  get(): Promise<GoalState | null>
  set(objective: string, options?: { readonly tokenBudget?: number }): Promise<GoalState>
  pause(): Promise<GoalState>
  resume(): Promise<GoalState>
  clear(): Promise<void>
}

export interface PlanningPort {
  /** Enters or leaves plan mode. */
  setMode(mode: 'plan' | 'normal'): Promise<void>
  /** Current plan mode and the latest plan document. */
  current(): Promise<{ readonly mode: 'plan' | 'normal' | 'unknown'; readonly document?: PlanDocument }>
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

interface EventBase {
  /** The owning turn (the Runtime's native turn ID, or a stable ID the adapter generates). */
  readonly turnId?: string
  /** true for events from history replay; unset for live events. */
  readonly replay?: boolean
}

export type MessageRole = 'user' | 'assistant' | 'reasoning'

export type ToolKind =
  | 'command' | 'file_change' | 'read' | 'search' | 'fetch' | 'web_search' | 'mcp' | 'agent_call' | 'think' | 'other'

export type ToolStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ToolLocation {
  readonly path: string
  readonly line?: number
}

export type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'diff'; readonly path: string; readonly oldText?: string; readonly newText: string }
  | { readonly type: 'terminal'; readonly terminalId: string; readonly output?: string; readonly exitCode?: number | null }
  | { readonly type: 'image'; readonly mimeType: string; readonly data?: string; readonly uri?: string }

/** Events that land on Timeline items: they carry item IDs computed by the identity rules. */
export type TimelineItemEvent =
  | (EventBase & {
      readonly type: 'message.delta'
      readonly itemId: string
      readonly role: MessageRole
      /** Appended text; deltas for the same itemId are concatenated in arrival order. */
      readonly text: string
      readonly clientMessageId?: string
    })
  | (EventBase & {
      /** The whole message (history replay, or Runtimes that only give final text). Replaces existing content of the same itemId. */
      readonly type: 'message.completed'
      readonly itemId: string
      readonly role: MessageRole
      readonly text: string
      readonly clientMessageId?: string
      readonly attachments?: readonly PromptAttachment[]
      /**
       * Attachments already in Timeline shape (`content.attachments`). When given, Conversation fills content.attachments from it,
       * not from attachments (which may carry local paths). Attachments in native history only have this shape.
       */
      readonly timelineAttachments?: readonly AttachmentInfo[]
      /**
       * How this message ended (Pi: a model error is failed, an interruption is cancelled). Defaults to done.
       * History replay carries it like live events: the same native message has the same status whichever path it came from.
       */
      readonly status?: 'done' | 'failed' | 'cancelled'
    })
  | (EventBase & {
      readonly type: 'tool.started'
      readonly itemId: string
      readonly toolCallId: string
      readonly kind: ToolKind
      readonly title: string
      readonly status: ToolStatus
      readonly input?: JsonValue
      readonly content?: readonly ToolContent[]
      readonly locations?: readonly ToolLocation[]
    })
  | (EventBase & {
      /** Only the changed fields; content, when given, replaces the whole list. */
      readonly type: 'tool.updated'
      readonly itemId: string
      readonly toolCallId: string
      readonly title?: string
      readonly kind?: ToolKind
      readonly status?: ToolStatus
      readonly input?: JsonValue
      readonly output?: JsonValue
      readonly content?: readonly ToolContent[]
      readonly locations?: readonly ToolLocation[]
    })
  | (EventBase & {
      /** System notices: compaction, model reroute, retrying, warnings, etc. */
      readonly type: 'notice'
      readonly itemId: string
      readonly level: 'info' | 'warning' | 'error'
      readonly kind: 'compact' | 'model_request_retry' | 'model_rerouted' | 'warning' | 'error' | 'other'
      readonly text: string
      readonly data?: JsonObject
    })

export type InteractionKind = 'approval' | 'form' | 'plan_review' | 'question'

export interface InteractionOption {
  readonly id: string
  readonly label: string
  /** Mapped from ACP PermissionOptionKind. */
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other'
}

export type RuntimeEvent =
  | TimelineItemEvent
  | (EventBase & {
      readonly type: 'turn.started'
      readonly turnId: string
      /** User-initiated, or started autonomously by the Runtime (scheduled wake-up, background task finished, a message sent in the Codex App). */
      readonly origin: 'user' | 'autonomous' | 'external'
      readonly clientMessageId?: string
    })
  | (EventBase & {
      readonly type: 'turn.ended'
      readonly turnId: string
      readonly reason: 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'failed' | 'unknown'
      readonly error?: RuntimeError
    })
  | (EventBase & {
      readonly type: 'interaction.opened'
      readonly interactionId: string
      readonly kind: InteractionKind
      readonly title: string
      readonly body?: string
      /** The related tool item (for approvals). */
      readonly itemId?: string
      readonly options?: readonly InteractionOption[]
      /** Form JSON Schema (form / question). */
      readonly schema?: JsonObject
      /** The plan document for plan reviews. */
      readonly plan?: PlanDocument
    })
  | (EventBase & {
      /** The interaction was handled (answered on any side, withdrawn by the Runtime, turn ended). */
      readonly type: 'interaction.resolved'
      readonly interactionId: string
      readonly resolution: 'answered' | 'withdrawn' | 'expired'
      readonly answeredBy?: 'self' | 'external'
    })
  | (EventBase & {
      /** Checklist plan (the checklist of ACP plan / plan_update). */
      readonly type: 'plan.updated'
      readonly planId: string
      readonly entries: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed'; readonly priority?: 'high' | 'medium' | 'low' }[]
      /** Markdown plan document (produced in plan mode). */
      readonly document?: PlanDocument
    })
  | (EventBase & { readonly type: 'planning.mode_changed'; readonly mode: 'plan' | 'normal' })
  | (EventBase & { readonly type: 'goal.updated'; readonly goal: GoalState | null })
  | (EventBase & { readonly type: 'config.updated'; readonly options: readonly ConfigOption[] })
  | (EventBase & {
      readonly type: 'commands.updated'
      readonly commands: readonly { readonly name: string; readonly description?: string; readonly inputHint?: string }[]
    })
  | (EventBase & { readonly type: 'session.info'; readonly title?: string; readonly updatedAt?: string })
  | (EventBase & {
      readonly type: 'usage.updated'
      readonly usedTokens?: number
      readonly contextWindow?: number
      readonly cost?: { readonly amount: number; readonly currency: string }
    })
  | (EventBase & { readonly type: 'capabilities.changed'; readonly capabilities: SessionCapabilities })
  /**
   * Whole-history replacement (Codex editing the last turn, rollback, owner reorder): item events between begin and commit are
   * the new complete history; discarded on abort. Maps to Conversation's full replacement + resetSeq.
   */
  | (EventBase & { readonly type: 'history.reset'; readonly phase: 'begin' | 'commit' | 'abort'; readonly revision: string })
  /** Writer change: held by AA, held externally (Codex App / DSH Desktop / terminal), nobody, unknown. */
  | (EventBase & { readonly type: 'writer.changed'; readonly writer: WriterState })
  /** Status of background tasks (Claude background commands, Codex background terminals, sub-Agents). */
  | (EventBase & {
      readonly type: 'background.updated'
      readonly taskId: string
      readonly kind: 'command' | 'subagent' | 'other'
      readonly title: string
      readonly state: 'running' | 'requires_action' | 'idle' | 'completed' | 'failed' | 'stopped'
    })
  /** The adapter process exited or the connection dropped; the session must be reopened to continue. */
  | (EventBase & { readonly type: 'session.lost'; readonly error: RuntimeError })

export interface WriterState {
  readonly holder: 'self' | 'external' | 'none' | 'unknown'
  /** Who, when external, e.g. `codex-app`, `dsh-desktop`, `terminal`. */
  readonly by?: string
  /** Whether it is executing now (running while an external writer runs a turn). */
  readonly execution?: 'idle' | 'running' | 'waiting_for_input' | 'unknown'
}
