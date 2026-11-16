/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact session-queue-state. Do not edit; run `yarn contracts:generate`. */

export type Deviceoffline = boolean
export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Size = number | null
export type Attachments = SessionQueueAttachment[]
export type Clientmessageid = string
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

/**
 * ``GET /sessions/{id}/runtime/queue``: the device's queue; empty with ``deviceOffline`` when it is offline.
 */
export interface SessionQueueStateV12 {
  deviceOffline: Deviceoffline
  items: Items
  revision: Revision
  sessionId: Sessionid1
  [k: string]: unknown
}
export interface SessionQueueItem {
  attachments: Attachments
  clientMessageId: Clientmessageid
  content: Content
  createdAt: Createdat
  createdBy: Createdby
  error: SessionQueueError | null
  interruptRequested: Interruptrequested
  messageId: Messageid
  position: Position
  sessionId: Sessionid
  status: Status
  updatedAt: Updatedat
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
  message: Message
  [k: string]: unknown
}
