/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact send-message-command. Do not edit; run `yarn contracts:generate`. */

export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Sha256 = string | null
export type Size = number | null
export type Attachments = CommandAttachmentRef[]
export type Clientmessageid = string
export type Content = string
export type Queue = ("auto" | "interrupt" | "never") | null
export type Sessionid = string

export interface SendMessageCommand {
  attachments?: Attachments
  clientMessageId: Clientmessageid
  content?: Content
  queue?: Queue
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
