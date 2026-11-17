/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact creation-begin-command. Do not edit; run `yarn contracts:generate`. */

/**
 * ``session.creation.begin``: direct, or from a workspace preparation (``preparationId``).
 */
export type CreationBeginCommand = DirectCreationCommand | PreparedCreationCommand
export type Fileid = string
export type Mediatype = string | null
export type Name = string | null
export type Sha256 = string | null
export type Size = number | null
export type Attachments = CommandAttachmentRef[]
export type Clientmessageid = string
export type Content = string
export type Cwd = string
export type Mode = "goal"
export type Operationid = string
export type Mode1 = "plan"
export type Operationid1 = string
export type Preparationid = null
export type Projectid = string | null
export type Runtimeid = string
export type Runtimetype = string
export type Selections = {
  [k: string]: string | null
} | null
export type Sessionid = string
export type Takeover = boolean | null
export type Title = string | null
export type Attachments1 = CommandAttachmentRef[]
export type Clientmessageid1 = string
export type Configuration = {
  [k: string]: string | boolean
} | null
export type Content1 = string
export type Createoperationid = string
export type Preparationid1 = string
export type Runtime = string | null
export type Runtimeid1 = string
export type Sessionid1 = string
export type Timelineattachments = CommandAttachmentRef[]
export type Title1 = string | null

/**
 * ``session.creation.begin`` without a workspace preparation: the device opens the session and runs
 * the first turn. ``sessionId`` is the directory row the Server created.
 */
export interface DirectCreationCommand {
  attachments?: Attachments
  clientMessageId: Clientmessageid
  content?: Content
  cwd: Cwd
  goalIntent?: GoalCreationIntent | null
  planningIntent?: PlanningCreationIntent | null
  preparationId?: Preparationid
  projectId?: Projectid
  runtimeId: Runtimeid
  runtimeType: Runtimetype
  selections?: Selections
  sessionId: Sessionid
  takeover?: Takeover
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
export interface GoalCreationIntent {
  mode?: Mode
  operationId: Operationid
}
export interface PlanningCreationIntent {
  mode: Mode1
  operationId: Operationid1
}
/**
 * ``session.creation.begin`` consuming a reserved workspace preparation (runtime-workflows 1.2).
 */
export interface PreparedCreationCommand {
  attachments?: Attachments1
  clientMessageId: Clientmessageid1
  configuration?: Configuration
  content?: Content1
  createOperationId: Createoperationid
  planningIntent?: PlanningCreationIntent | null
  preparationId: Preparationid1
  runtime?: Runtime
  runtimeId: Runtimeid1
  selections?: Selections1
  sessionId: Sessionid1
  timelineAttachments?: Timelineattachments
  title?: Title1
  [k: string]: unknown
}
export interface Selections1 {
  [k: string]: string | null
}
