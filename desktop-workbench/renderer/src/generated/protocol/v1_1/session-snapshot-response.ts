/* eslint-disable */
/**
 * Generated from protocol 1.1 artifact session-snapshot-response.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

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
export type Servertime = string
export type Archivesource = ("user" | "runtime" | "both") | null
export type Archived = boolean
export type Archivedat = string | null
export type Connectorid = string
export type Connectorstatus = "offline" | "online"
export type Cwd = string | null
export type Externalsessionid1 = string | null
export type Id2 = string
export type Lastactivityat = string | null
export type Lastitemat = string | null
export type Lastitemorderseq = number | null
export type Lastreadseq = number
export type Lastsyncedat = string | null
export type Latestturnendseq = number
export type Pinned = boolean
export type Pinnedat = string | null
export type Projectid = string | null
export type Runtime4 = string
export type Sortat = string | null
export type Sourceavailability = "available" | "archived" | "unavailable" | "deleted" | "missing" | "unknown"
export type Sourceavailabilityreason = string | null
export type Sourceavailabilityupdatedat = string | null
export type Sourceobservationorigin = ("event" | "inventory" | "operation") | null
export type Sourceobservedat = string | null
export type Status3 = "idle" | "waiting" | "pending" | "running" | "stopping" | "waiting_approval" | "error" | "blocked"
export type Takeover = boolean
export type Title2 = string | null
export type Unread = boolean
export type Updatedseq1 = number
export type Userarchived = boolean
export type Createdat3 = string
export type Error = {
  [k: string]: unknown
} | null
export type Externalsessionid2 = string | null
export type Runtime5 = string
export type Sessionid5 = string
export type Status4 = "idle" | "waiting" | "pending" | "running" | "stopping" | "waiting_approval" | "error" | "blocked"
export type Statusreason = string | null
export type Updatedat1 = string
export type Updatedseq2 = number
export type Hasmore = boolean
export type Completedat = string | null
export type Contenthash = string
export type Createdat4 = string
export type Id3 = string
export type Orderseq = number
export type Revision3 = number
export type Role = ("user" | "assistant" | "system" | "tool") | null
export type Sessionid6 = string
export type Clientmessageid = string | null
export type Derivedkey = string | null
export type Event = string | null
export type Itemid1 = string | null
export type Itemtype = string | null
export type Runtime6 = string | "platform"
export type Sessionid7 = string | null
export type Status5 = "pending" | "running" | "waiting_approval" | "done" | "failed" | "cancelled" | "interrupted"
export type Type1 = "message" | "tool" | "artifact" | "marker" | "system"
export type Updatedat2 = string
export type Updatedseq3 = number
export type Items = TimelineItem[]
export type Nextseq = number

export interface ProtocolSessionSnapshotResponse {
  approvals: Approvals
  catalogs: Catalogs
  effectiveCapabilities: ProtocolCapabilitySet
  eventCursor: Eventcursor
  goalState: GoalState | null
  notices: Notices
  runtimeCapabilities: ProtocolCapabilitySet
  serverTime: Servertime
  session: SessionView
  state: SessionRuntimeState | null
  timeline: ProtocolTimelineSnapshot
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
export interface SessionView {
  archiveSource?: Archivesource
  archived?: Archived
  archivedAt?: Archivedat
  connectorId: Connectorid
  connectorStatus: Connectorstatus
  cwd?: Cwd
  externalSessionId?: Externalsessionid1
  id: Id2
  lastActivityAt?: Lastactivityat
  lastItemAt?: Lastitemat
  lastItemOrderSeq?: Lastitemorderseq
  lastReadSeq?: Lastreadseq
  lastSyncedAt?: Lastsyncedat
  latestTurnEndSeq?: Latestturnendseq
  pinned?: Pinned
  pinnedAt?: Pinnedat
  projectId?: Projectid
  runtime: Runtime4
  sortAt?: Sortat
  sourceAvailability?: Sourceavailability
  sourceAvailabilityReason?: Sourceavailabilityreason
  sourceAvailabilityUpdatedAt?: Sourceavailabilityupdatedat
  sourceObservationOrigin?: Sourceobservationorigin
  sourceObservedAt?: Sourceobservedat
  status: Status3
  takeover: Takeover
  title?: Title2
  unread?: Unread
  updatedSeq: Updatedseq1
  userArchived?: Userarchived
  [k: string]: unknown
}
export interface SessionRuntimeState {
  createdAt: Createdat3
  error?: Error
  externalSessionId?: Externalsessionid2
  metadata?: Metadata1
  runtime: Runtime5
  selections?: Selections
  sessionId: Sessionid5
  status?: Status4
  statusReason?: Statusreason
  updatedAt: Updatedat1
  updatedSeq: Updatedseq2
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
export interface Selections {
  [k: string]: string | null
}
export interface ProtocolTimelineSnapshot {
  hasMore: Hasmore
  items: Items
  nextSeq: Nextseq
  [k: string]: unknown
}
export interface TimelineItem {
  completedAt?: Completedat
  content?: Content
  contentHash: Contenthash
  createdAt: Createdat4
  id: Id3
  orderSeq: Orderseq
  revision?: Revision3
  role?: Role
  sessionId: Sessionid6
  source: TimelineSource
  status: Status5
  type: Type1
  updatedAt: Updatedat2
  updatedSeq: Updatedseq3
  [k: string]: unknown
}
export interface Content {
  [k: string]: unknown
}
export interface TimelineSource {
  clientMessageId?: Clientmessageid
  derivedKey?: Derivedkey
  event?: Event
  itemId?: Itemid1
  itemType?: Itemtype
  runtime: Runtime6
  sessionId?: Sessionid7
  [k: string]: unknown
}
