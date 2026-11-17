/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact steer-command. Do not edit; run `yarn contracts:generate`. */

export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Sha256 = string | null
export type Size = number | null
export type Attachments = CommandAttachmentRef[]
export type Clientmessageid = string
export type Content = string
export type Cwd = string | null
export type Externalsessionid = string | null
export type Runtime = string | null
export type Runtimeid = string | null
export type Sessionid = string

export interface SteerCommand {
  attachments?: Attachments
  clientMessageId: Clientmessageid
  content?: Content
  cwd?: Cwd
  externalSessionId?: Externalsessionid
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
