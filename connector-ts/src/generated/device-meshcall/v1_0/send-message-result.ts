/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact send-message-result. Do not edit; run `yarn contracts:generate`. */

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
export type State = string | null

/**
 * ``accepted``: the turn started; ``queued``: it waits in the session's queue; ``duplicate``: seen before.
 */
export interface SendMessageResult {
  clientMessageId: Clientmessageid
  delivery: Delivery
  item?: Item
  queue?: SessionQueueState | null
  queuePosition?: Queueposition
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
