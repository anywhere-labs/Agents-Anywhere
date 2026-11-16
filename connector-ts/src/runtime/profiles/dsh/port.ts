/**
 * PROVISIONAL copy of the `RuntimeSession` port (docs/v3 04-connector.md §4).
 *
 * B owns the real port in `application/ports/runtime-session.ts`. Until it lands, the DSH
 * profile codes against this copy so it never edits B's files; once B's port is merged,
 * delete this file and import the port from `application/ports` instead. Keep the shapes
 * identical to §4 where §4 defines them; everything marked "DSH needs" is a proposal for B.
 */

export type RuntimeType = 'codex' | 'claude' | 'pi' | 'hermes' | 'dsh' | `acp:${string}`

export type CapabilityState = { supported: boolean, available: boolean, metadata?: Record<string, unknown> }

/** Runtime- or session-level capabilities, keyed by AA capability ID (04 §5.1). */
export type RuntimeCapabilities = Record<string, CapabilityState>
export type SessionCapabilities = RuntimeCapabilities

export interface ProviderFacts {
  installed: boolean
  version?: string
  /** How the runtime would be launched right now; DSH reports its route. */
  detail?: Record<string, unknown>
}

export interface CatalogOption { value: string, name: string, description?: string, group?: string }
export interface CatalogEntry { id: string, category: string, current: string, options: CatalogOption[] }
export interface Catalogs { entries: CatalogEntry[] }

export interface NativeSessionRef { externalSessionId: string, cwd: string }
export interface NativeSessionSummary extends NativeSessionRef {
  title?: string | null
  updatedAt?: string | null
  running?: boolean
}
export interface NativeSessionPage { sessions: NativeSessionSummary[], nextCursor?: string | null }
export interface NativeHistoryPage { events: RuntimeEvent[], complete: boolean }

export interface NewSessionSpec {
  cwd: string
  /** DSH needs: the native ID AA wants (plugin route honours it; direct route cannot). */
  preferredExternalId?: string
  agentPreset?: string
}

export interface OpenOptions {
  /** Replay committed history from this native position (plugin route); the direct route has none. */
  replayFrom?: number
}

export interface DeliveryRef {
  /** AA client message id; the idempotency key of one user input. */
  clientMessageId: string
  /** Native request id derived from it (DSH: `dshPluginUserMessageId`). */
  nativeRequestId: string
}

export interface PromptInput {
  text: string
  images?: { mimeType: string, data: string }[]
  files?: { path: string, name: string, mimeType?: string, size: number }[]
}

export type PromptAcceptance =
  | { status: 'accepted' }
  /** DSH needs: accepted into a queue the runtime or the adapter owns; it runs after the current turn. */
  | { status: 'queued', position: number }
  | { status: 'duplicate' }

export type SteerResult = { outcome: 'injected' | 'promptRequired' | 'failed', message?: string }

export type InteractionAnswer = { kind: 'option', optionId: string } | { kind: 'cancel' }

export type ConfigChange = { configId: string, value: string }
export interface ConfigResult { catalogs: Catalogs }

export interface CommandResult { ok: boolean, message?: string, data?: unknown }

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

/**
 * Internal runtime events (04 §4). Projection into TimelineItems is the Conversation's
 * job; adapters only translate. `seq` is the runtime's own position when it has one.
 */
export type RuntimeEvent =
  | { type: 'turn.started', turnId: string, seq?: number }
  | { type: 'turn.ended', turnId: string, stopReason: StopReason, reason?: { kind: string, message?: string },
    deliveries: string[], continuable?: boolean, seq?: number }
  | { type: 'message.delta', role: 'user' | 'assistant' | 'thought', messageId?: string, text: string,
    transient: boolean, attemptId?: string, nativeRequestId?: string, seq?: number }
  | { type: 'message.committed', role: 'assistant' | 'thought', messageId: string, text: string, replacesAttempt?: string, seq?: number }
  | { type: 'message.abandoned', attemptId: string }
  | { type: 'image', role: 'user' | 'assistant', mimeType: string, data: string, messageId?: string, seq?: number }
  | { type: 'tool.started', toolCallId: string, title: string, kind: string, input: unknown, seq?: number }
  | { type: 'tool.updated', toolCallId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', output: string[], seq?: number }
  | { type: 'interaction.opened', interactionId: string, interactionType: 'approval', title: string,
    options: { optionId: string, name: string, kind: string }[], toolCallId?: string, detail?: string }
  | { type: 'interaction.resolved', interactionId: string, by: 'aa' | 'runtime' | 'timeout' | 'cancelled' }
  | { type: 'usage', used: number, size: number }
  | { type: 'catalogs.changed', catalogs: Catalogs }
  | { type: 'title.changed', title: string }
  | { type: 'writer.changed', writer: 'self' | 'external' | 'none' }
  | { type: 'history.reset' }
  | { type: 'runtime.closed', reason: string }

export interface RuntimeSession {
  readonly capabilities: SessionCapabilities
  /** DSH needs: the native session id (it may only be known after open). */
  readonly externalSessionId: string
  prompt(input: PromptInput, delivery: DeliveryRef): Promise<PromptAcceptance>
  steer?(input: PromptInput, delivery: DeliveryRef): Promise<SteerResult>
  cancel(expectedTurnId?: string): Promise<void>
  respond(interactionId: string, answer: InteractionAnswer): Promise<void>
  configure(change: ConfigChange): Promise<ConfigResult>
  command(name: string, args?: unknown): Promise<CommandResult>
  events: AsyncIterable<RuntimeEvent>
  close(): Promise<void>
}

export interface RuntimeHandle {
  capabilities(): RuntimeCapabilities
  catalogs(): Promise<Catalogs>
  listNativeSessions(cursor?: string): Promise<NativeSessionPage>
  readNativeHistory(ref: NativeSessionRef, window: { fromSeq?: number }): Promise<NativeHistoryPage>
  open(target: NativeSessionRef | NewSessionSpec, opts?: OpenOptions): Promise<RuntimeSession>
  stop(): Promise<void>
}

export interface RuntimeInstanceConfig {
  runtimeId: string
  settings: Record<string, unknown>
}

export interface RuntimeProvider {
  type: RuntimeType
  discover(): Promise<ProviderFacts>
  start(instance: RuntimeInstanceConfig): Promise<RuntimeHandle>
}
