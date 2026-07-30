/* eslint-disable */
/**
 * Generated from protocol 1.0 artifact session-snapshot-response.
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
export type Runtime = "codex" | "claude" | "opencode" | "acp"
export type Sessionid1 = string | null
export type Turnid = string | null
export type Status = "pending" | "approved" | "approved_for_session" | "rejected" | "cancelled" | "expired"
export type Targetitemid = string | null
export type Title = string
export type Turnid1 = string | null
export type Updatedseq = number
export type Approvals = Approval[]
export type Allowed = boolean
export type Available = boolean
export type Capabilityid = string
export type Runtime1 = ("codex" | "claude" | "opencode" | "acp") | null
export type Scope = "adapter" | "runtime" | "session"
export type Sessionid2 = string | null
export type Supported = boolean
export type Unavailablereason = string | null
export type Version = string
export type Capabilities = ProtocolCapability[]
export type Revision = number
export type Eventcursor = string
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
export type Actions = NoticeAction[]
export type Scope1 = "session"
export type Targetid = string
export type Createdat1 = string
export type Expiresat = string | null
export type Interactiontype = ("approval" | "execution_error" | "confirmation" | "input_request" | "unknown") | null
export type Message = string | null
export type Noticeid = string
export type Resolvedat1 = string | null
export type Responserequired = boolean
export type Revision1 = number
export type Sessionid3 = string
export type Severity = "info" | "success" | "warning" | "error"
export type Adapter = string | null
export type Approvalid = string | null
export type Operationid = string | null
export type Runtime2 = ("codex" | "claude" | "opencode" | "acp") | "platform" | null
export type Timelineitemid = string | null
export type Status1 = "open" | "response_accepted" | "resolving" | "resolved" | "expired" | "cancelled" | "failed"
export type Title1 = string
export type Type = "notification" | "interaction"
export type Updatedat = string
export type Updatedseq1 = number
export type Notices = Notice[]
export type Servertime = string
export type Archived = boolean
export type Archivedat = string | null
export type Connectorid = string
export type Connectorstatus = "offline" | "online"
export type Cwd = string | null
export type Externalsessionid = string | null
export type Id1 = string
export type Lastactivityat = string | null
export type Lastitemat = string | null
export type Lastitemorderseq = number | null
export type Lastreadseq = number
export type Lastsyncedat = string | null
export type Modelselectionid = string | null
export type Permissionselectionid = string | null
export type Pinned = boolean
export type Pinnedat = string | null
export type Runtime3 = "codex" | "claude" | "opencode" | "acp"
export type Sortat = string | null
export type Sourceobservedat = string | null
export type Status2 = "idle" | "pending" | "running" | "stopping" | "blocked"
export type Takeover = boolean
export type Title2 = string | null
export type Unread = boolean
export type Updatedseq2 = number
export type Hasmore = boolean
export type Completedat = string | null
export type Contenthash = string
export type Createdat2 = string
export type Id2 = string
export type Orderseq = number
export type Revision2 = number
export type Role = ("user" | "assistant" | "system" | "tool") | null
export type Sessionid4 = string
export type Clientmessageid = string | null
export type Derivedkey = string | null
export type Event = string | null
export type Itemid1 = string | null
export type Itemtype = string | null
export type Runtime4 = ("codex" | "claude" | "opencode" | "acp") | "platform"
export type Sessionid5 = string | null
export type Turnid2 = string | null
export type Status3 = "pending" | "running" | "waiting_approval" | "done" | "failed" | "cancelled" | "interrupted"
export type Turnid3 = string | null
export type Type1 = "turn.start" | "turn.end" | "message" | "tool" | "artifact" | "system"
export type Updatedat1 = string
export type Updatedseq3 = number
export type Items = TimelineItem[]
export type Nextseq = number

export interface ProtocolSessionSnapshotResponse {
  approvals: Approvals
  catalogs: Catalogs
  effectiveCapabilities: ProtocolCapabilitySet
  eventCursor: Eventcursor
  notices: Notices
  runtimeCapabilities: ProtocolCapabilitySet
  serverTime: Servertime
  session: SessionView
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
  turnId?: Turnid1
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
  turnId?: Turnid
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
export interface Notice {
  actions?: Actions
  blocking?: NoticeBlocking | null
  context?: Context
  createdAt: Createdat1
  expiresAt?: Expiresat
  interactionType?: Interactiontype
  message?: Message
  metadata?: Metadata
  noticeId: Noticeid
  resolvedAt?: Resolvedat1
  responseRequired?: Responserequired
  revision?: Revision1
  sessionId: Sessionid3
  severity?: Severity
  source?: NoticeSource
  status?: Status1
  title: Title1
  type: Type
  updatedAt: Updatedat
  updatedSeq: Updatedseq1
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
  adapter?: Adapter
  approvalId?: Approvalid
  operationId?: Operationid
  runtime?: Runtime2
  timelineItemId?: Timelineitemid
  [k: string]: unknown
}
export interface SessionView {
  archived?: Archived
  archivedAt?: Archivedat
  connectorId: Connectorid
  connectorStatus: Connectorstatus
  cwd?: Cwd
  externalSessionId?: Externalsessionid
  id: Id1
  lastActivityAt?: Lastactivityat
  lastItemAt?: Lastitemat
  lastItemOrderSeq?: Lastitemorderseq
  lastReadSeq?: Lastreadseq
  lastSyncedAt?: Lastsyncedat
  modelSelectionId?: Modelselectionid
  permissionSelectionId?: Permissionselectionid
  pinned?: Pinned
  pinnedAt?: Pinnedat
  runtime: Runtime3
  sortAt?: Sortat
  sourceObservedAt?: Sourceobservedat
  status: Status2
  takeover: Takeover
  title?: Title2
  unread?: Unread
  updatedSeq: Updatedseq2
  [k: string]: unknown
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
  createdAt: Createdat2
  id: Id2
  orderSeq: Orderseq
  revision?: Revision2
  role?: Role
  sessionId: Sessionid4
  source: TimelineSource
  status: Status3
  turnId?: Turnid3
  type: Type1
  updatedAt: Updatedat1
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
  runtime: Runtime4
  sessionId?: Sessionid5
  turnId?: Turnid2
  [k: string]: unknown
}
