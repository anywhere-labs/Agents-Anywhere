import type {
  Delivery,
  DeliveryState,
  Interaction,
  QueueAttachment,
  QueueItem,
  Session,
  SessionQueue,
  SessionStatus,
  SourceAvailability,
  SummaryFacts,
  TimelineDraft,
  TimelineItem,
  ActiveTurn,
} from '../../domain/conversation/index.js'
import type { GoalState } from '../../domain/goals/index.js'
import type { PlanDocument, PlanningState } from '../../domain/planning/index.js'

/**
 * The local store (04-connector.md §6): the authority for session content. Every method is one SQLite
 * transaction, so a use case never sees half of a change (an item without its clock tick, a delivery
 * without its user message, a summary without its outbox row). Implementations run SQLite on a worker
 * thread; the main thread never does synchronous disk I/O.
 */
export interface ConversationStore {
  readonly sessions: SessionRepository
  readonly timeline: TimelineRepository
  readonly deliveries: DeliveryRepository
  readonly queues: QueueRepository
  readonly interactions: InteractionRepository
  readonly planning: PlanningRepository
  readonly goals: GoalRepository
  readonly commands: CommandLog
  readonly outbox: OutboxStore
  readonly blobs: BlobRepository
  readonly kv: RuntimeKv
  close(): Promise<void>
}

export interface NewSession {
  sessionId: string
  runtimeType: string
  runtimeId: string
  externalSessionId: string | null
  cwd: string | null
  nativeTitle: string | null
  status: SessionStatus
  sourceAvailability: SourceAvailability
  takeover: boolean
  at: string
}

export interface SessionPatch {
  externalSessionId?: string | null
  cwd?: string | null
  nativeTitle?: string | null
  status?: SessionStatus
  sourceAvailability?: SourceAvailability
  activeTurn?: ActiveTurn | null
  /** Set to the current head when a turn ended (unread is `latestTurnEndSeq > readSeq`). */
  turnEnded?: boolean
  planState?: Session['planState']
  goalState?: Session['goalState']
  takeover?: boolean
  archived?: boolean
  lastActivityAt?: string
}

/** What a committed change did to the session; the sync layer turns it into ChangeFeed and outbox traffic. */
export interface SessionCommit {
  session: Session
  /** First and last sequence number this commit allocated; equal to the head when nothing ticked. */
  fromSeq: number
  toSeq: number
  /** Items inserted or updated, with their new `updatedSeq`. */
  changed: TimelineItem[]
  /** Ids removed by this commit (deletions tick the clock too). */
  deleted: string[]
  /** The fence moved: clients below `session.clock.resetSeq` must take a snapshot. */
  reset: boolean
  /** Present when the commit queued a `session.summary` in the outbox. */
  summary: SummaryFacts | null
}

export interface SessionRepository {
  create(input: NewSession): Promise<{ session: Session; created: boolean }>
  get(sessionId: string): Promise<Session | null>
  list(): Promise<Session[]>
  update(sessionId: string, patch: SessionPatch): Promise<SessionCommit>
  /** `sessionsHead` for `LinkHello`. */
  heads(): Promise<{ sessionId: string; headSeq: number; resetSeq: number }[]>
  /**
   * Applies `LinkWelcome.seqFloors`; returns the sessions whose clock jumped (their items were restamped
   * past the floor and a reset fence raised).
   */
  applySeqFloors(floors: Readonly<Record<string, number>>): Promise<string[]>
  /** Queues a `session.summary` for every session (after a directory key rotation or on demand). */
  republishSummaries(): Promise<number>
}

export interface TimelineChange {
  upserts: readonly TimelineDraft[]
  deletes?: readonly string[]
  /**
   * Full replacement (history rewrite, rebuild): raise the reset fence, delete every item not in `upserts`.
   * With `range`, only items whose `orderSeq` is in `(afterOrderSeq, throughOrderSeq]` are replaced.
   */
  replace?: { range?: { afterOrderSeq: number | null; throughOrderSeq: number | null } }
  session?: SessionPatch
  at: string
}

export type ReadMode = 'latest' | 'before' | 'after'

export interface TimelinePage {
  items: TimelineItem[]
  headSeq: number
  resetSeq: number
  hasMore: boolean
  oldestOrderSeq: number | null
  /** Bytes of the serialized items returned. */
  bytes: number
}

export interface ChangesPage {
  items: TimelineItem[]
  toSeq: number
  resetSeq: number
  headSeq: number
  /** True when every change up to the head is included. */
  complete: boolean
  /** The cursor is below the fence, ahead of the head, or a deletion fell in the range. */
  snapshotRequired: boolean
}

export interface TimelineRepository {
  apply(sessionId: string, change: TimelineChange): Promise<SessionCommit>
  get(sessionId: string, itemId: string): Promise<TimelineItem | null>
  latest(sessionId: string): Promise<TimelineItem | null>
  /** Paged read by `orderSeq` (`before`/`after` exclusive of the cursor), bounded by count and bytes. */
  read(sessionId: string, mode: ReadMode, cursor: number | null, limit: number, byteBudget: number): Promise<TimelinePage>
  /** Items with `updatedSeq > afterSeq` in clock order, bounded by count and bytes. */
  changesSince(sessionId: string, afterSeq: number, limit: number, byteBudget: number): Promise<ChangesPage>
  /** Finds the user message a Runtime echoed back (acceptance evidence for a delivery). */
  findByClientMessageId(sessionId: string, clientMessageId: string): Promise<TimelineItem | null>
}

export interface ReceiveMessageInput {
  sessionId: string
  clientMessageId: string
  inputDigest: string
  /** The pending user message item shown at once (status `pending`). */
  userItem: TimelineDraft
  /** When the admission decided to queue: the queue entry and its position mode. */
  enqueue: { item: Omit<QueueItem, 'status' | 'interruptRequested' | 'error'>; mode: 'auto' | 'interrupt' } | null
  commandId: string | null
  at: string
}

export interface ReceiveMessageResult {
  delivery: Delivery
  duplicate: boolean
  queue: SessionQueue | null
  queueItem: QueueItem | null
  commit: SessionCommit | null
}

export interface DeliveryRepository {
  /** Delivery, user message item, queue entry and command record in one transaction ("落盘才确认"). */
  receive(input: ReceiveMessageInput): Promise<ReceiveMessageResult>
  get(sessionId: string, clientMessageId: string): Promise<Delivery | null>
  transition(sessionId: string, clientMessageId: string, to: DeliveryState, details: { nativeRef?: string | null; errorCode?: string | null; at: string }): Promise<Delivery>
  /** Deliveries left in `sending` by a previous process. */
  inFlight(): Promise<Delivery[]>
}

export type QueueOp =
  | { kind: 'update'; messageId: string; content?: string; attachments?: readonly QueueAttachment[] }
  | { kind: 'remove'; messageId: string }
  | { kind: 'retry'; messageId: string }
  | { kind: 'sendNow'; messageId: string }
  | { kind: 'resume' }
  | { kind: 'reorder'; messageIds: readonly string[] }
  | { kind: 'clear' }
  | { kind: 'markSending'; messageId: string }
  | { kind: 'markSent'; messageId: string }
  | { kind: 'markFailed'; messageId: string; error: { code: string; message: string } }
  | { kind: 'turnEnded'; outcome: 'idle' | 'error' }
  | { kind: 'dropForArchive' }

export interface QueueRepository {
  get(sessionId: string): Promise<SessionQueue>
  /** Applies a domain queue operation atomically; also settles the matching delivery when one exists. */
  apply(sessionId: string, op: QueueOp, at: string): Promise<SessionQueue>
  /** Every non-empty queue (dispatch checks after a restart). */
  nonEmpty(): Promise<SessionQueue[]>
}

export interface InteractionRepository {
  save(interaction: Interaction): Promise<void>
  get(sessionId: string, noticeId: string): Promise<Interaction | null>
  list(sessionId: string, activeOnly: boolean): Promise<Interaction[]>
  /** First answer wins, decided inside one transaction. */
  respond(sessionId: string, noticeId: string, responseId: string): Promise<{ kind: 'accepted' | 'duplicate'; interaction: Interaction }>
  /** Closes every active blocking interaction of the session (turn end, Runtime restart). */
  expireBlocking(sessionId: string, reason: string, at: string): Promise<Interaction[]>
  /** Every active interaction on the device (restart: shown as expired, never silently dropped). */
  allActive(): Promise<Interaction[]>
}

export interface PlanningRepository {
  load(sessionId: string): Promise<PlanningState | null>
  /** Saves the state and, when given, an immutable new document revision, with the session's `planState`. */
  save(state: PlanningState, document: PlanDocument | null): Promise<SessionCommit>
  document(sessionId: string, planId: string, revision: number): Promise<PlanDocument | null>
}

export interface GoalRepository {
  load(sessionId: string): Promise<GoalState | null>
  save(state: GoalState): Promise<SessionCommit>
}

export type CommandOutcome = 'accepted' | 'rejected' | 'unknown'

export interface CommandRecord {
  commandId: string
  method: string
  sessionId: string | null
  inputDigest: string | null
  outcome: CommandOutcome
  result: Record<string, unknown> | null
  error: { code: string; message?: string; retryable?: boolean } | null
  createdAt: string
  updatedAt: string
}

/** Durable receipts by `commandId` (Server's `Commands/status`; `command.result` in the outbox). */
export interface CommandLog {
  get(commandId: string): Promise<CommandRecord | null>
  /** Records the outcome and queues `command.result` in the outbox in the same transaction. */
  settle(record: CommandRecord): Promise<void>
}

export interface OutboxRecord {
  oid: number
  kind: string
  sessionId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

/** The persistent outbox to the Server (04-connector.md §7). */
export interface OutboxStore {
  append(kind: string, sessionId: string | null, payload: Record<string, unknown>, at: string): Promise<number>
  /** Unacknowledged records with `oid > afterOid`, oldest first. */
  pending(afterOid: number, limit: number): Promise<OutboxRecord[]>
  /** Cumulative: deletes every record with `oid <= oid`. */
  ack(oid: number): Promise<number>
  /** Lowest unacknowledged oid, or null when empty. */
  lowest(): Promise<number | null>
}

export interface BlobRecord {
  blobId: string
  sha256: string
  size: number
  mediaType: string | null
  origin: string
  createdAt: string
}

export interface BlobRepository {
  put(bytes: Uint8Array, meta: { mediaType: string | null; origin: string; at: string }): Promise<BlobRecord>
  get(blobId: string): Promise<BlobRecord | null>
  read(blobId: string, range?: { offset: number; length: number }): Promise<Uint8Array | null>
  /** Absolute path of the blob file, for zero-copy uploads. */
  path(blobId: string): Promise<string | null>
}

/** Runtime bookkeeping (replaces v2 sync-state.json / kv.json). */
export interface RuntimeKv {
  get(runtimeId: string, key: string): Promise<unknown>
  set(runtimeId: string, key: string, value: unknown): Promise<void>
  delete(runtimeId: string, key: string): Promise<void>
}
