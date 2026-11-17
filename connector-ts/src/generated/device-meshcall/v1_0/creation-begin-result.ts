/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact creation-begin-result. Do not edit; run `yarn contracts:generate`. */

/**
 * Direct: the first message's delivery; prepared: the creation's workflow state.
 */
export type CreationBeginResult = DirectCreationResult | WorkflowState
export type Clientmessageid = string
export type Delivery = "accepted" | "queued" | "duplicate"
export type Item = {
  [k: string]: unknown
} | null
export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Size = number | null
export type Attachments = SessionQueueAttachment[]
export type Clientmessageid1 = string
export type Content = string
export type Createdat = string
export type Createdby = string
export type Code = string
export type Message = string
export type Interruptrequested = boolean
export type Messageid = string
export type Position = number
export type Sessionid = string
export type Status = "queued" | "sending" | "failed"
export type Updatedat = string
export type Items = SessionQueueItem[]
export type Revision = number
export type Sessionid1 = string
export type Queueposition = number | null
export type Sessionid2 = string
export type State = string | null
export type Default = boolean
export type Description = string | null
export type Displayname = string
export type Displayname1 = string
export type Id = string
export type Itemdisplayname = string | null
export type Id1 = string
export type Default1 = boolean
export type Description1 = string | null
export type Displayname2 = string
export type Fullmodelid = string | null
export type Id2 = string
export type Selectionid = string
export type Reasoningitems = ProtocolReasoningItem[]
export type Selectionid1 = string | null
export type Models = ProtocolModelItem[]
export type Revision1 = number
export type Runtime = string

export interface DirectCreationResult {
  clientMessageId: Clientmessageid
  delivery: Delivery
  item?: Item
  queue?: SessionQueueState | null
  queuePosition?: Queueposition
  sessionId: Sessionid2
  state?: State
  [k: string]: unknown
}
export interface SessionQueueState {
  items?: Items
  revision: Revision
  sessionId: Sessionid1
  [k: string]: unknown
}
export interface SessionQueueItem {
  attachments?: Attachments
  clientMessageId: Clientmessageid1
  content: Content
  createdAt: Createdat
  createdBy: Createdby
  error?: SessionQueueError | null
  interruptRequested?: Interruptrequested
  messageId: Messageid
  position: Position
  sessionId: Sessionid
  status: Status
  updatedAt: Updatedat
  [k: string]: unknown
}
export interface SessionQueueAttachment {
  fileId: Fileid
  mediaType?: Mediatype
  name?: Name
  size?: Size
  [k: string]: unknown
}
export interface SessionQueueError {
  code: Code
  message: Message
  [k: string]: unknown
}
/**
 * Keep runtime extensions while validating the shared model catalog.
 */
export interface WorkflowState {
  catalog?: ProtocolModelCatalog | null
  [k: string]: unknown
}
export interface ProtocolModelCatalog {
  models?: Models
  revision: Revision1
  runtime: Runtime
  [k: string]: unknown
}
export interface ProtocolModelItem {
  default?: Default
  description?: Description
  displayName: Displayname
  group?: ProtocolModelGroup | null
  id: Id1
  metadata?: Metadata
  reasoningItems?: Reasoningitems
  selectionId?: Selectionid1
  [k: string]: unknown
}
/**
 * Where a model is routed from, e.g. a DSH provider or relay.
 */
export interface ProtocolModelGroup {
  displayName: Displayname1
  id: Id
  itemDisplayName?: Itemdisplayname
  [k: string]: unknown
}
export interface Metadata {
  [k: string]: unknown
}
export interface ProtocolReasoningItem {
  default?: Default1
  description?: Description1
  displayName: Displayname2
  fullModelId?: Fullmodelid
  id: Id2
  metadata?: Metadata1
  selectionId: Selectionid
  [k: string]: unknown
}
export interface Metadata1 {
  [k: string]: unknown
}
