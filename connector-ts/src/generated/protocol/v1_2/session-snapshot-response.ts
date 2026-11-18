/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact session-snapshot-response. Do not edit; run `yarn contracts:generate`. */

export type Choices = ("approve" | "approve_for_session" | "reject" | "cancel")[]
export type Createdat = string
export type Description = string | null
export type Id = string
export type Kind = "command" | "file_change" | "permission" | "tool_call" | "input_request" | "unknown"
export type Resolvedat = string | null
export type Sessionid = string
export type Itemid = string | null
export type Method = string | null
export type Requestid = string | number
export type Runtime = string
export type Sessionid1 = string | null
export type Status = "pending" | "approved" | "approved_for_session" | "rejected" | "cancelled" | "expired"
export type Targetitemid = string | null
export type Title = string
export type Updatedseq = number
export type Approvals = Approval[]
export type Deviceoffline = boolean
export type Allowed = boolean
export type Available = boolean
export type Capabilityid = string
export type Runtime1 = string | null
export type Scope = "runtime" | "session"
export type Sessionid2 = string | null
export type Supported = boolean
export type Unavailablereason = string | null
export type Version = string
export type Capabilities = ProtocolCapability[]
export type Revision = number
export type Eventcursor = string
export type Bindinggeneration = number
export type Actions = ("set" | "edit" | "pause" | "resume" | "clear")[]
export type Reason = string | null
export type Supported1 = boolean
export type Externalsessionid = string | null
export type Freshness = "fresh" | "stale" | "unknown"
export type Createdat1 = string
export type Endedat = string | null
export type Id1 = string
export type Iterations = number | null
export type Lastreason = string | null
export type Objective = string
export type Sourceturnid = string | null
export type Status1 =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete" | "failed" | "cleared" | "replaced"
export type Timeusedseconds = number | null
export type Tokenbudget = number | null
export type Tokensused = number | null
export type Updatedat = string
export type Pendingoperationid = string | null
export type Revision1 = number
export type Runtime2 = string
export type Runtimeid = string | null
export type Sessionid3 = string
export type Sourceepoch = string
export type Sourcerevision = number
export type Historysource = "live" | "unavailable"
export type Actionid = string
export type Required = boolean
export type Schema = {
  [k: string]: unknown
} | null
export type Uischema = {
  [k: string]: unknown
} | null
export type Label = string
export type Style = "primary" | "secondary" | "danger"
export type Actions1 = NoticeAction[]
export type Scope1 = "session"
export type Targetid = string
export type Createdat2 = string | null
export type Expiresat = string | null
export type Interactiontype = ("approval" | "execution_error" | "confirmation" | "input_request" | "unknown") | null
export type Message = string | null
export type Noticeid = string
export type Resolvedat1 = string | null
export type Responserequired = boolean
export type Revision2 = number
export type Sessionid4 = string
export type Severity = "info" | "success" | "warning" | "error"
export type Approvalid = string | null
export type Component = string | null
export type Operationid = string | null
export type Runtime3 = string | "platform" | null
export type Timelineitemid = string | null
export type Status2 =
  "open" | "responding" | "response_accepted" | "resolving" | "resolved" | "closed" | "expired" | "cancelled" | "failed"
export type Title1 = string
export type Type = "notification" | "interaction"
export type Notices = NoticeIn[]
export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Size = number | null
export type Attachments = SessionQueueAttachment[]
export type Clientmessageid = string
export type Content = string
export type Createdat3 = string
export type Createdby = string
export type Code = string
export type Message1 = string
export type Interruptrequested = boolean
export type Messageid = string
export type Position = number
export type Sessionid5 = string
export type Status3 = "queued" | "sending" | "failed"
export type Updatedat1 = string
export type Items = SessionQueueItem[]
export type Revision3 = number
export type Sessionid6 = string
export type Servertime = string
export type Archivesource = ("user" | "runtime" | "both") | null
export type Archived = boolean
export type Archivedat = string | null
export type Connectorid = string
export type Connectorstatus = "offline" | "online"
export type Cwd = string | null
export type Keyid = string | null
export type Mode = "plain" | "sealed"
export type Payload1 =
  | {
      [k: string]: unknown
    }
  | string
export type Externalsessionid1 = string | null
export type Goalstate = "none" | "active" | "paused" | "completed"
export type Id2 = string
export type Lastactivityat = string | null
export type Lastitemat = string | null
export type Lastitemorderseq = number | null
export type Lastreadseq = number
export type Lastsyncedat = string | null
export type Latestturnendseq = number
export type Pinned = boolean
export type Pinnedat = string | null
export type Planstate = "none" | "planning" | "awaiting_review"
export type Projectid = string | null
export type Runtime4 = string
export type Sortat = string | null
export type Sourceavailability = "available" | "archived" | "unavailable" | "deleted" | "missing" | "unknown"
export type Sourceavailabilityreason = string | null
export type Sourceavailabilityupdatedat = string | null
export type Sourceobservationorigin = ("event" | "inventory" | "operation") | null
export type Sourceobservedat = string | null
export type Status4 = "idle" | "waiting" | "pending" | "running" | "stopping" | "waiting_approval" | "error" | "blocked"
export type Takeover = boolean
export type Title2 = string | null
export type Unread = boolean
export type Updatedseq1 = number
export type Userarchived = boolean
export type Createdat4 = string
export type Error = {
  [k: string]: unknown
} | null
export type Externalsessionid2 = string | null
export type Runtime5 = string
export type Sessionid7 = string
export type Status5 = "idle" | "waiting" | "pending" | "running" | "stopping" | "waiting_approval" | "error" | "blocked"
export type Statusreason = string | null
export type Updatedat2 = string
export type Updatedseq2 = number
export type Hasmore = boolean
/**
 * present only when fields were moved to the device's blob store
 */
export type Blobrefs = TimelineBlobRef[] | null
export type Blobid = string
export type Bytes = number
export type Mediatype1 = string | null
/**
 * RFC 6901 JSON pointer into the item's content
 */
export type Path = string
export type Completedat = string | null
export type Contenthash = string
export type Createdat5 = string
export type Id3 = string
export type Orderseq = number
export type Revision4 = number
export type Role = ("user" | "assistant" | "system" | "tool") | null
export type Sessionid8 = string
export type Clientmessageid1 = string | null
export type Derivedkey = string | null
export type Event = string | null
export type Itemid1 = string | null
export type Itemtype = string | null
export type Runtime6 = string | "platform"
export type Sessionid9 = string | null
export type Status6 = "pending" | "running" | "waiting_approval" | "done" | "failed" | "cancelled" | "interrupted"
export type Type1 = "message" | "tool" | "artifact" | "marker" | "system"
export type Updatedat3 = string
export type Updatedseq3 = number
export type Items1 = TimelineItemV12[]
export type Nextseq = number

export interface ProtocolSessionSnapshotResponseV12 {
  approvals: Approvals
  catalogs: Catalogs
  deviceOffline: Deviceoffline
  effectiveCapabilities: ProtocolCapabilitySet
  eventCursor: Eventcursor
  goalState: GoalState | null
  historySource: Historysource
  notices: Notices
  queue: SessionQueueState | null
  runtimeCapabilities: ProtocolCapabilitySet
  serverTime: Servertime
  session: SessionViewV12
  state: SessionRuntimeState | null
  timeline: ProtocolTimelineSnapshotV12
  [k: string]: unknown
}
export interface Approval {
  choices: Choices
  createdAt: Createdat
  description?: Description
  id: Id
  kind?: Kind
  payload?: Payload
  resolvedAt?: Resolvedat
  sessionId: Sessionid
  source: ApprovalSource
  status?: Status
  targetItemId?: Targetitemid
  title: Title
  updatedSeq: Updatedseq
  [k: string]: unknown
}
export interface Payload {
  [k: string]: unknown
}
export interface ApprovalSource {
  itemId?: Itemid
  method?: Method
  requestId: Requestid
  runtime: Runtime
  sessionId?: Sessionid1
  [k: string]: unknown
}
export interface Catalogs {
  [k: string]: unknown
}
export interface ProtocolCapabilitySet {
  capabilities: Capabilities
  revision: Revision
  [k: string]: unknown
}
export interface ProtocolCapability {
  allowed: Allowed
  available: Available
  capabilityId: Capabilityid
  parameters: Parameters
  runtime: Runtime1
  scope: Scope
  sessionId: Sessionid2
  supported: Supported
  unavailableReason: Unavailablereason
  version: Version
  [k: string]: unknown
}
export interface Parameters {
  [k: string]: unknown
}
export interface GoalState {
  bindingGeneration?: Bindinggeneration
  capabilities?: GoalCapabilities
  externalSessionId?: Externalsessionid
  freshness?: Freshness
  goal?: Goal | null
  lastOutcome?: Goal | null
  pendingOperationId?: Pendingoperationid
  revision?: Revision1
  runtime: Runtime2
  runtimeId?: Runtimeid
  sessionId: Sessionid3
  sourceEpoch?: Sourceepoch
  sourceRevision?: Sourcerevision
}
export interface GoalCapabilities {
  actions?: Actions
  reason?: Reason
  supported?: Supported1
  [k: string]: unknown
}
export interface Goal {
  createdAt: Createdat1
  endedAt?: Endedat
  id: Id1
  iterations?: Iterations
  lastReason?: Lastreason
  objective: Objective
  sourceTurnId?: Sourceturnid
  status: Status1
  timeUsedSeconds?: Timeusedseconds
  tokenBudget?: Tokenbudget
  tokensUsed?: Tokensused
  updatedAt: Updatedat
}
export interface NoticeIn {
  actions?: Actions1
  blocking?: NoticeBlocking | null
  context?: Context
  createdAt?: Createdat2
  expiresAt?: Expiresat
  interactionType?: Interactiontype
  message?: Message
  metadata?: Metadata
  noticeId: Noticeid
  resolvedAt?: Resolvedat1
  responseRequired?: Responserequired
  revision?: Revision2
  sessionId: Sessionid4
  severity?: Severity
  source?: NoticeSource
  status?: Status2
  title: Title1
  type: Type
  [k: string]: unknown
}
export interface NoticeAction {
  actionId: Actionid
  input?: NoticeActionInput
  label: Label
  style?: Style
  [k: string]: unknown
}
export interface NoticeActionInput {
  required?: Required
  schema?: Schema
  uiSchema?: Uischema
  [k: string]: unknown
}
export interface NoticeBlocking {
  scope: Scope1
  targetId: Targetid
  [k: string]: unknown
}
export interface Context {
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface NoticeSource {
  approvalId?: Approvalid
  component?: Component
  operationId?: Operationid
  runtime?: Runtime3
  timelineItemId?: Timelineitemid
  [k: string]: unknown
}
export interface SessionQueueState {
  items: Items
  revision: Revision3
  sessionId: Sessionid6
  [k: string]: unknown
}
export interface SessionQueueItem {
  attachments: Attachments
  clientMessageId: Clientmessageid
  content: Content
  createdAt: Createdat3
  createdBy: Createdby
  error: SessionQueueError | null
  interruptRequested: Interruptrequested
  messageId: Messageid
  position: Position
  sessionId: Sessionid5
  status: Status3
  updatedAt: Updatedat1
  [k: string]: unknown
}
export interface SessionQueueAttachment {
  fileId: Fileid
  mediaType: Mediatype
  name: Name
  size: Size
  [k: string]: unknown
}
export interface SessionQueueError {
  code: Code
  message: Message1
  [k: string]: unknown
}
export interface SessionViewV12 {
  archiveSource?: Archivesource
  archived?: Archived
  archivedAt?: Archivedat
  connectorId: Connectorid
  connectorStatus: Connectorstatus
  cwd?: Cwd
  displayDevice?: DisplayEnvelope | null
  displayUser?: DisplayEnvelope | null
  externalSessionId?: Externalsessionid1
  goalState?: Goalstate
  id: Id2
  lastActivityAt?: Lastactivityat
  lastItemAt?: Lastitemat
  lastItemOrderSeq?: Lastitemorderseq
  lastReadSeq?: Lastreadseq
  lastSyncedAt?: Lastsyncedat
  latestTurnEndSeq?: Latestturnendseq
  pinned?: Pinned
  pinnedAt?: Pinnedat
  planState?: Planstate
  projectId?: Projectid
  runtime: Runtime4
  sortAt?: Sortat
  sourceAvailability?: Sourceavailability
  sourceAvailabilityReason?: Sourceavailabilityreason
  sourceAvailabilityUpdatedAt?: Sourceavailabilityupdatedat
  sourceObservationOrigin?: Sourceobservationorigin
  sourceObservedAt?: Sourceobservedat
  status: Status4
  takeover: Takeover
  title?: Title2
  unread?: Unread
  updatedSeq: Updatedseq1
  userArchived?: Userarchived
  [k: string]: unknown
}
/**
 * Human-facing content the Server stores but never reads.
 *
 * ``plain``: ``payload`` is a JSON object (normal mode).
 * ``sealed``: ``payload`` is base64 ciphertext encrypted with the device's
 * directory key identified by ``keyId`` (E2EE mode).
 */
export interface DisplayEnvelope {
  keyId: Keyid
  mode: Mode
  payload: Payload1
  [k: string]: unknown
}
export interface SessionRuntimeState {
  createdAt: Createdat4
  error?: Error
  externalSessionId?: Externalsessionid2
  metadata?: Metadata1
  runtime: Runtime5
  selections?: Selections
  sessionId: Sessionid7
  status?: Status5
  statusReason?: Statusreason
  updatedAt: Updatedat2
  updatedSeq: Updatedseq2
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
export interface Selections {
  [k: string]: string | null
}
export interface ProtocolTimelineSnapshotV12 {
  hasMore: Hasmore
  items: Items1
  nextSeq: Nextseq
  [k: string]: unknown
}
export interface TimelineItemV12 {
  blobRefs?: Blobrefs
  completedAt?: Completedat
  content?: Content1
  contentHash: Contenthash
  createdAt: Createdat5
  id: Id3
  orderSeq: Orderseq
  revision?: Revision4
  role?: Role
  sessionId: Sessionid8
  source: TimelineSource
  status: Status6
  type: Type1
  updatedAt: Updatedat3
  updatedSeq: Updatedseq3
  [k: string]: unknown
}
/**
 * A field of a timeline item the device moved to its local blob store; the item keeps a preview at ``path``.
 *
 * A ``text/*`` blob is the full UTF-8 text of the string previewed at ``path``. Any other blob is media whose
 * ``data`` (or ``blob``) key was removed from the block at ``path``'s parent, or a ``data:`` URL string replaced
 * by a short description.
 */
export interface TimelineBlobRef {
  blobId: Blobid
  bytes: Bytes
  mediaType: Mediatype1
  path: Path
  [k: string]: unknown
}
export interface Content1 {
  [k: string]: unknown
}
export interface TimelineSource {
  clientMessageId?: Clientmessageid1
  derivedKey?: Derivedkey
  event?: Event
  itemId?: Itemid1
  itemType?: Itemtype
  runtime: Runtime6
  sessionId?: Sessionid9
  [k: string]: unknown
}
