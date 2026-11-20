import type { OutboxMethod, OutboxPayloads } from '../../generated/device-meshcall/v1_0/payloads.js'
import type {
  Delivery,
  DeliveryState,
  Interaction,
  QueueItem,
  QueueOp,
  Session,
  SessionQueue,
  SessionStatus,
  SourceAvailability,
  SummaryFacts,
  TimelineDraft,
  TimelineItem,
  ActiveTurn,
} from '../../domain/conversation/index.js'
import type { AgentAction, AgentGrant, Supervision } from '../../domain/collab/index.js'
import type { MessageAuthor, SessionOrigin } from '../../domain/conversation/index.js'
import type { Preparation } from '../../domain/creation/index.js'
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
  readonly preparations: PreparationRepository
  readonly collab: CollabRepository
  close(): Promise<void>
}

export interface NewSession {
  sessionId: string
  runtimeType: string
  runtimeId: string
  externalSessionId: string | null
  cwd: string | null
  /** See `Session.projectId`. */
  projectId?: string | null
  /** See `Session.origin`. */
  origin?: SessionOrigin | null
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
   * past the floor and a reset fence raised). The floor of a session the store does not have yet is kept:
   * `create` starts that session's clock above it (a native rescan recreating it after a reinstall).
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

export type ReadMode = 'latest' | 'before' | 'after' | 'changes'

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
  /**
   * The pending user message item shown at once (status `pending`); null when the message is queued, because
   * a queued message enters the timeline only when it is dispatched, which clients expect.
   */
  userItem: TimelineDraft | null
  /** When the admission decided to queue: the queue entry and its position mode. */
  enqueue: { item: Omit<QueueItem, 'status' | 'interruptRequested' | 'error'>; mode: 'auto' | 'interrupt' } | null
  /**
   * What the Runtime hand-off needs when it happens after the ack (not queued): stored with the delivery and
   * dropped once it leaves `accepted`, so a restart in between still sends the message.
   */
  pending?: PendingDelivery | null
  commandId: string | null
  /** The command's receipt, committed with the delivery (a queued message gets the queue filled in). */
  receipt?: CommandReceipt | null
  at: string
}

/** The message of an accepted delivery that has not reached the Runtime yet. */
export interface PendingDelivery {
  readonly content: string
  readonly attachments: readonly Record<string, unknown>[]
  /** A new session's first message: how to open the new Runtime session. */
  readonly open?: {
    readonly cwd: string
    readonly title?: string
    readonly selections?: Record<string, string | null>
    /** Agent options (runtime-workflows 1.2 `configuration`), applied before the first message. */
    readonly configuration?: Record<string, string | boolean>
  }
}

export interface ReceiveMessageResult {
  delivery: Delivery
  duplicate: boolean
  queue: SessionQueue | null
  queueItem: QueueItem | null
  commit: SessionCommit | null
}

export interface DeliveryRepository {
  /** Delivery, user message item, queue entry and command record in one transaction (acknowledged only once persisted). */
  receive(input: ReceiveMessageInput): Promise<ReceiveMessageResult>
  get(sessionId: string, clientMessageId: string): Promise<Delivery | null>
  transition(sessionId: string, clientMessageId: string, to: DeliveryState, details: { nativeRef?: string | null; errorCode?: string | null; at: string }): Promise<Delivery>
  /** Deliveries left in `sending` by a previous process. */
  inFlight(): Promise<Delivery[]>
  /** Deliveries left in `accepted` by a previous process, with what they still have to send (null: none kept). */
  acceptedPending(): Promise<Array<{ delivery: Delivery; pending: PendingDelivery | null }>>
}

export type { QueueOp } from '../../domain/conversation/index.js'

export interface QueueRepository {
  get(sessionId: string): Promise<SessionQueue>
  /**
   * Applies a domain queue operation atomically; also settles the matching delivery when one exists. With a
   * receipt, the command's receipt (its result the resulting queue state) commits in the same transaction.
   */
  apply(sessionId: string, op: QueueOp, at: string, receipt?: CommandReceipt | null): Promise<SessionQueue>
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
  /** Saves the state and, when given, an immutable new document revision, with the session's `planState` (and the receipt). */
  save(state: PlanningState, document: PlanDocument | null, receipt?: CommandReceipt | null): Promise<SessionCommit>
  document(sessionId: string, planId: string, revision: number): Promise<PlanDocument | null>
}

export interface GoalRepository {
  load(sessionId: string): Promise<GoalState | null>
  save(state: GoalState, receipt?: CommandReceipt | null): Promise<SessionCommit>
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

/**
 * An accepted command's receipt handed to the write that is its effect: the store commits the receipt (and queues
 * `command.result`) in that write's transaction, so a crash never leaves an effect without its receipt and a retry
 * with the same `commandId` replays the receipt instead of running the command again.
 */
export interface CommandReceipt {
  commandId: string
  method: string
  sessionId: string | null
  inputDigest: string | null
  createdAt: string
  /** The ack body; queue operations and queued messages get the resulting queue state merged in by the store. */
  result: Record<string, unknown> | null
}

/** Durable receipts by `commandId` (Server's `Commands/status`; `command.result` in the outbox). */
export interface CommandLog {
  get(commandId: string): Promise<CommandRecord | null>
  /**
   * Records the outcome and queues `command.result` in the outbox in the same transaction, and returns the record
   * that stands: a final receipt already committed with the effect is kept as it is (nothing is queued again).
   */
  settle(record: CommandRecord): Promise<CommandRecord>
}

export interface OutboxRecord {
  oid: number
  kind: string
  sessionId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

/** The persistent outbox to the Server (04-connector.md §7). */
/**
 * An outbox record's payload as stored: `OutboxItem.p`, except that summaries keep their display fields in the clear
 * (`SummaryFacts`) and are sealed into `displayDevice` when sent.
 */
export type StoredOutboxPayloads = {
  readonly [K in OutboxMethod]: K extends 'session.summary'
    ? { readonly summary: SummaryFacts }
    : K extends 'session.inventory'
      ? Omit<OutboxPayloads[K], 'sessions'> & { readonly runtimeId: string; readonly scanId: string; readonly complete: boolean; readonly sessions?: readonly SummaryFacts[] }
      : OutboxPayloads[K]
}

export interface OutboxStore {
  /** Appends a must-deliver message. */
  append<K extends OutboxMethod>(kind: K, sessionId: string | null, payload: StoredOutboxPayloads[K], at: string): Promise<number>
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
  /** Whether an item of this session points at the blob (`Store/readBlob` serves a session only its own blobs). */
  referencedBy(sessionId: string, blobId: string): Promise<boolean>
}

/** Per-Runtime key/value bookkeeping. */
export interface RuntimeKv {
  get(runtimeId: string, key: string): Promise<unknown>
  set(runtimeId: string, key: string, value: unknown): Promise<void>
  delete(runtimeId: string, key: string): Promise<void>
}

/**
 * Workspace preparations (domain/creation), one row per preparation with the creation that consumed it. Lookups by
 * `createOperationId` find the preparation whose reservation or creation carries it.
 */
export interface PreparationRepository {
  get(preparationId: string): Promise<Preparation | null>
  byCreation(createOperationId: string): Promise<Preparation | null>
  save(preparation: Preparation): Promise<void>
  /** Preparations still open (not cancelled or expired, or consumed by a creation without an outcome), for restart recovery. */
  unsettled(): Promise<Preparation[]>
  /** Deletes settled preparations last changed before `before` (ISO time); returns how many. */
  prune(before: string): Promise<number>
}

/** A session an Agent created through `aa_spawn` (on this device or another). */
export interface SpawnedChild {
  readonly childSessionId: string
  readonly childDeviceId: string
  readonly grantId: string
  readonly supervisorSessionId: string
  readonly depth: number
  readonly closed: boolean
  readonly createdAt: string
}

/**
 * Agent collaboration state on this device (docs/agent-collaboration.md): grants, supervisions, the audit of agent
 * actions, the children Agents spawned, and message authors. A supervision change and its outbox record commit in
 * one transaction.
 */
export interface CollabRepository {
  putGrant(grant: AgentGrant, outbox: StoredOutboxPayloads['collab.grant.changed'] | null, at: string): Promise<void>
  grant(grantId: string): Promise<AgentGrant | null>
  grantBySecret(secretDigest: string): Promise<AgentGrant | null>
  /** The active grant of a supervisor session, if any. */
  activeGrantOf(supervisorSessionId: string): Promise<AgentGrant | null>
  activeGrants(): Promise<AgentGrant[]>
  putSupervision(supervision: Supervision, outbox: StoredOutboxPayloads['collab.supervision.changed'] | null, at: string): Promise<void>
  supervision(supervisionId: string): Promise<Supervision | null>
  /** Supervisions of a supervisor session, ended ones included when `all`. */
  supervisionsOf(supervisorSessionId: string, all?: boolean): Promise<Supervision[]>
  supervisionsOfTarget(targetSessionId: string): Promise<Supervision[]>
  /** Every supervision that is not ended. */
  liveSupervisions(): Promise<Supervision[]>
  putAction(action: AgentAction): Promise<void>
  action(actionId: string): Promise<AgentAction | null>
  recentActions(supervisorSessionId: string, limit: number): Promise<AgentAction[]>
  putChild(child: SpawnedChild): Promise<void>
  child(childSessionId: string): Promise<SpawnedChild | null>
  closeChild(childSessionId: string): Promise<void>
  /** Sessions a supervisor session created that are not closed (across its grants). */
  openChildren(supervisorSessionId: string): Promise<number>
  childrenOf(supervisorSessionId: string): Promise<SpawnedChild[]>
  putAuthor(sessionId: string, clientMessageId: string, author: MessageAuthor): Promise<void>
  author(sessionId: string, clientMessageId: string): Promise<MessageAuthor | null>
}
