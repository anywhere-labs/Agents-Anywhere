/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact creation-begin-command. Do not edit; run `yarn contracts:generate`. */

export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Sha256 = string | null
export type Size = number | null
export type Attachments = CommandAttachmentRef[]
export type Clientmessageid = string
export type Configuration = {
  [k: string]: string | boolean
} | null
export type Content = string
export type Createoperationid = string
export type Mode = "plan"
export type Operationid = string
export type Preparationid = string
export type Runtime = string | null
export type Runtimeid = string
export type Sessionid = string
export type Timelineattachments = CommandAttachmentRef[]
export type Title = string | null

/**
 * ``session.creation.begin``: consumes a reserved workspace preparation (runtime-workflows 1.2).
 */
export interface CreationBeginCommand {
  attachments?: Attachments
  clientMessageId: Clientmessageid
  configuration?: Configuration
  content?: Content
  createOperationId: Createoperationid
  planningIntent?: PlanningCreationIntent | null
  preparationId: Preparationid
  runtime?: Runtime
  runtimeId: Runtimeid
  selections?: Selections
  sessionId: Sessionid
  timelineAttachments?: Timelineattachments
  title?: Title
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
export interface PlanningCreationIntent {
  mode: Mode
  operationId: Operationid
}
export interface Selections {
  [k: string]: string | null
}
