/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact queue-item-command. Do not edit; run `yarn contracts:generate`. */

export type Attachments = CommandAttachmentRef[] | null
export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Sha256 = string | null
export type Size = number | null
export type Content = string | null
export type Messageid = string
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

/**
 * ``session.queue.update`` (``content``/``attachments``), ``delete``, ``retry``, ``sendNow``.
 */
export interface QueueItemCommand {
  attachments?: Attachments
  content?: Content
  messageId: Messageid
  runtime?: Runtime
  runtimeId?: Runtimeid
  sessionId: Sessionid
  [k: string]: unknown
}
/**
 * An attachment in a command: the Server's record; facts it does not have are left out.
 */
export interface CommandAttachmentRef {
  fileId: Fileid
  mediaType?: Mediatype
  name?: Name
  sha256?: Sha256
  size?: Size
  [k: string]: unknown
}
