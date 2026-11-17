/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact runtime-notice-updated-event. Do not edit; run `yarn contracts:generate`. */

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
export type Scope = "session"
export type Targetid = string
export type Createdat = string | null
export type Expiresat = string | null
export type Interactiontype = ("approval" | "execution_error" | "confirmation" | "input_request" | "unknown") | null
export type Message = string | null
export type Noticeid = string
export type Resolvedat = string | null
export type Responserequired = boolean
export type Revision = number
export type Sessionid = string
export type Severity = "info" | "success" | "warning" | "error"
export type Approvalid = string | null
export type Component = string | null
export type Operationid = string | null
export type Runtime = string | "platform" | null
export type Timelineitemid = string | null
export type Status =
  "open" | "responding" | "response_accepted" | "resolving" | "resolved" | "closed" | "expired" | "cancelled" | "failed"
export type Title = string
export type Type = "notification" | "interaction"
export type Sessionid1 = string

/**
 * ``runtime.notice.updated``: a session notice opened, changed or closed (protocol 1.2 notice).
 */
export interface RuntimeNoticeUpdatedEvent {
  notice: NoticeIn
  sessionId: Sessionid1
  [k: string]: unknown
}
export interface NoticeIn {
  actions?: Actions
  blocking?: NoticeBlocking | null
  context?: Context
  createdAt?: Createdat
  expiresAt?: Expiresat
  interactionType?: Interactiontype
  message?: Message
  metadata?: Metadata
  noticeId: Noticeid
  resolvedAt?: Resolvedat
  responseRequired?: Responserequired
  revision?: Revision
  sessionId: Sessionid
  severity?: Severity
  source?: NoticeSource
  status?: Status
  title: Title
  type: Type
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
  scope: Scope
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
  approvalId?: Approvalid
  component?: Component
  operationId?: Operationid
  runtime?: Runtime
  timelineItemId?: Timelineitemid
  [k: string]: unknown
}
