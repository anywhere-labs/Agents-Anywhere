/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact timeline-response. Do not edit; run `yarn contracts:generate`. */

export type Deviceoffline = boolean
export type Hasmore = boolean
export type Historysource = "live" | "unavailable"
export type Completedat = string | null
export type Contenthash = string
export type Createdat = string
export type Id = string
export type Orderseq = number
export type Revision = number
export type Role = ("user" | "assistant" | "system" | "tool") | null
export type Sessionid = string
export type Clientmessageid = string | null
export type Derivedkey = string | null
export type Event = string | null
export type Itemid = string | null
export type Itemtype = string | null
export type Runtime = string | "platform"
export type Sessionid1 = string | null
export type Status = "pending" | "running" | "waiting_approval" | "done" | "failed" | "cancelled" | "interrupted"
export type Type = "message" | "tool" | "artifact" | "marker" | "system"
export type Updatedat = string
export type Updatedseq = number
export type Items = TimelineItem[]
export type Nextseq = number
export type Servertime = string
export type Sessionid2 = string

export interface ProtocolTimelineResponseV12 {
  deviceOffline: Deviceoffline
  hasMore: Hasmore
  historySource: Historysource
  items: Items
  nextSeq: Nextseq
  serverTime: Servertime
  sessionId: Sessionid2
  [k: string]: unknown
}
export interface TimelineItem {
  completedAt?: Completedat
  content?: Content
  contentHash: Contenthash
  createdAt: Createdat
  id: Id
  orderSeq: Orderseq
  revision?: Revision
  role?: Role
  sessionId: Sessionid
  source: TimelineSource
  status: Status
  type: Type
  updatedAt: Updatedat
  updatedSeq: Updatedseq
  [k: string]: unknown
}
export interface Content {
  [k: string]: unknown
}
export interface TimelineSource {
  clientMessageId?: Clientmessageid
  derivedKey?: Derivedkey
  event?: Event
  itemId?: Itemid
  itemType?: Itemtype
  runtime: Runtime
  sessionId?: Sessionid1
  [k: string]: unknown
}
