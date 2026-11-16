/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact send-message-command. Do not edit; run `yarn contracts:generate`. */

export type Encrypted = boolean
export type Fileid = string
export type Mediatype = string
export type Name = string
export type Sha256 = string | null
export type Size = number
export type Attachments = AttachmentRef[]
export type Clientmessageid = string
export type Content = string
export type Queue = ("auto" | "interrupt" | "never") | null
export type Sessionid = string

export interface SendMessageCommand {
  attachments?: Attachments
  clientMessageId: Clientmessageid
  content: Content
  queue?: Queue
  sessionId: Sessionid
  [k: string]: unknown
}
export interface AttachmentRef {
  encrypted?: Encrypted
  fileId: Fileid
  mediaType: Mediatype
  name: Name
  sha256?: Sha256
  size: Size
  [k: string]: unknown
}
