// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/dialect.py @98dd0e6e5 (dialect hooks)
//
// Runtime dialects: the generic ACP engine leaves hooks here, and each Profile (Codex, Claude, Pi, Hermes, generic
// ACP, DSH) implements what it needs (capabilities, steering, configuration adaptation, update translation,
// acceptance evidence, interactions, error classification, guarantees, user prompt echoes...).

import type {
  Capability,
  ConfigOption,
  DeliveryRef,
  InteractionAnswer,
  InteractionKind,
  HistoryWindow,
  NativeHistoryPage,
  NativeSessionRef,
  NewSessionSpec,
  PromptInput,
  RuntimeError,
  RuntimeEvent,
  RuntimeType,
} from '../../application/ports/runtime-session.js'
import type { AcpClient, AgentInfo, JsonRecord } from './client.js'
import type { LegacyModesSpec } from './config.js'

/** Item identity within a session: computes Timeline IDs that match the IDs existing timelines already use. */
export interface ItemIdentity {
  /** Which item an ACP update lands on; null when it lands on none (non-text blocks, etc.). */
  itemFor(update: JsonRecord): string | null
  /** Item ID of a user message sent by AA. */
  userItemId(clientMessageId: string): string
  /** Clears position-counted state before the history is replaced wholesale (Codex: replays from the start afterwards, so positions restart). */
  reset?(): void
  /** Turn end: the next message no longer continues the last message of the previous turn. */
  finish?(): void
}

export interface SessionContext {
  readonly sessionId: string
  readonly nativeSessionId: string
  readonly epoch: string
  readonly info: AgentInfo
}

export interface PlanModeSpec {
  /** ID of the config option that carries plan mode (Codex `collaboration_mode`, Claude `mode`). */
  readonly optionId: string
  readonly planValue: string
  /** Value used when leaving plan mode; undefined means the value from before entering it. */
  readonly normalValue?: string
}

export interface PlanReviewDecision {
  /** The option to answer request_permission with; undefined means answer cancelled. */
  readonly optionId?: string
  /**
   * What to do after answering: when revising the plan, steer the feedback into the current turn, or send it as a
   * new message after the current turn ends (Claude: rejecting a plan ends the turn, and feedback steered into it is
   * cancelled with the turn, S2); when not proceeding, interrupt the turn.
   */
  readonly then?:
    | { readonly action: 'steer'; readonly text: string }
    | { readonly action: 'prompt'; readonly text: string }
    | { readonly action: 'cancel' }
}

/** Turn state visible to the dialect while translating. */
export interface TurnState {
  readonly turnId?: string
  readonly origin?: 'user' | 'autonomous' | 'external'
}

/**
 * Conversion between AA selection IDs and Agent config values (runtimes use different selection rules: Claude uses
 * `claudeModelSelectionId`, generic ACP uses `acpSelectionId`). Decoding compares against the current config's enum.
 */
export interface SelectionCodec {
  modelSelectionId(model: string, effort: string | null): string
  permissionSelectionId(value: string): string
  /** Values not listed in the reasoning effort catalog (Claude's `default` means unspecified). */
  readonly hiddenEfforts?: readonly string[]
}

export interface AcpDialect {
  readonly runtime: RuntimeType
  /** Highest protocol version the client declares; defaults to 1. */
  readonly protocolVersion?: 1 | 2
  /** clientCapabilities for initialize. */
  clientCapabilities(): JsonRecord
  /** Top-level initialize `_meta` (extension negotiation). */
  initializeMeta?(): JsonRecord | undefined
  /** Runtime-level capabilities (derived from the negotiation). */
  capabilities(info: AgentInfo): Capability[]
  /** Session-level capabilities; defaults to the runtime-level ones. */
  sessionCapabilities?(info: AgentInfo, config: readonly ConfigOption[]): Capability[]
  /** Item identity; defaults to the generic ACP rules (AcpProjectionIdentity). */
  identity?(context: SessionContext): ItemIdentity
  /** Extra params for session/new (`_meta`, etc.). */
  newSessionParams?(spec: NewSessionSpec): JsonRecord
  /** Extra params for session/load / session/resume (Codex's `codexIpc.mode: auto`). */
  openParams?(ref: NativeSessionRef): JsonRecord
  /** Extra params for session/prompt (Codex's `codexIpc.clientMessageId`). */
  promptParams?(delivery: DeliveryRef): JsonRecord
  /** Converts AA input into ACP content blocks; defaults to text + attachments (images inline, files as resource_link). */
  promptBlocks?(input: PromptInput): JsonRecord[]
  /** How to steer: the ACP extension `_session/steering`, a text command (Hermes `/steer`), or not supported. */
  readonly steer: 'extension' | 'text-command' | 'none'
  readonly steerCommand?: string
  /** Whether text-command steering can carry attachments; defaults to no. */
  readonly steerAttachments?: boolean
  /** The Agent echoes user messages sent by AA as user_message_chunk: such echoes no longer create items. */
  readonly echoesUserPrompt?: boolean
  /** Translates one ACP update into internal events; undefined falls back to the generic translation. */
  translateUpdate?(update: JsonRecord, context: SessionContext, turn: TurnState): RuntimeEvent[] | undefined
  /** Which update ends an autonomous turn (scheduled wakeup, background task) that has no end marker (Claude: a usage_update with cost). */
  endsAutonomousTurn?(update: JsonRecord): boolean
  /** Selection ID rules; defaults to the generic ACP rules. */
  readonly selections?: SelectionCodec
  /** Interaction category of a reverse request; undefined falls back to the generic classification. */
  interactionKind?(method: string, params: JsonRecord): InteractionKind | undefined
  /** Lets the dialect see a reverse request when it arrives (Hermes records the approval card's toolCallId). Does not change handling. */
  observeRequest?(method: string, params: JsonRecord, context: SessionContext): void
  /**
   * Checks after opening a session whether the Agent meets requirements (e.g. must provide a model option); an
   * error fails the open. `response` is the raw session/new|load|resume response (Pi checks `_meta.pi` to confirm
   * the approval guard is loaded).
   */
  verifySession?(config: readonly ConfigOption[], response: JsonRecord, nativeSessionId: string): RuntimeError | undefined
  /** The dialect's own acceptance evidence (the Pi guard reports the turn started before model output); counted in addition to the generic evidence. */
  acceptanceEvidence?(update: JsonRecord): boolean
  /** How plan review answers map to ACP options. */
  planReview?(answer: Extract<InteractionAnswer, { kind: 'plan_review' }>, options: readonly JsonRecord[], context: { readonly modeBeforePlan?: string }): PlanReviewDecision
  /** Which config option carries plan mode. */
  planMode?(config: readonly ConfigOption[]): PlanModeSpec | undefined
  /** Goal extension method name (`_session/goal`); undefined means not supported. */
  goalMethod?(info: AgentInfo): string | undefined
  /** Reverse requests the dialect handles itself (`_codex/session/history_reset`, etc.). Returns undefined when unrecognized. */
  handleRequest?(method: string, params: JsonRecord, session: DialectSessionHooks): Promise<unknown> | undefined
  /** Session-level notification methods the dialect receives (routed to the session by params.sessionId). */
  readonly notificationMethods?: readonly string[]
  onNotification?(method: string, params: JsonRecord, session: DialectSessionHooks): void
  /** Error classification. */
  classifyError?(error: unknown): RuntimeError | undefined
  /** Which config option legacy session modes appear as (Command Code's permission modes); default in config.ts `LegacyModesSpec`. */
  readonly legacyModes?: LegacyModesSpec
  /** Adjusts config options (category fixes, hiding unsupported options). */
  adaptConfig?(options: ConfigOption[]): ConfigOption[]
  /** Read-only history: no resume, no lock, no native writes. undefined falls back to the generic implementation (load + capture + close). */
  readNativeHistory?(ref: NativeSessionRef, window: HistoryWindow, connection: () => Promise<{ readonly client: AcpClient; readonly info: AgentInfo }>): Promise<NativeHistoryPage> | undefined
}

/** Session abilities the dialect can use in reverse requests and notifications. */
export interface DialectSessionHooks {
  emit(event: RuntimeEvent): void
  /** Following updates are history replay (no turn opened, translated as replay) until endReplay. Used for Codex history replacement. */
  beginReplay(): void
  endReplay(): void
}
