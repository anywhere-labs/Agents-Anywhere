/* eslint-disable */
/** Generated from contracts/protocol/1.2 artifact timeline-response. Do not edit; run `yarn contracts:generate`. */

export type Deviceoffline = boolean
export type Hasmore = boolean
export type Historysource = "live" | "unavailable"
/**
 * present only when fields were moved to the device's blob store
 */
export type Blobrefs = TimelineBlobRef[] | null
export type Blobid = string
export type Bytes = number
export type Mediatype = string | null
/**
 * RFC 6901 JSON pointer into the item's content
 */
export type Path = string
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
export type Items = TimelineItemV12[]
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
export interface TimelineItemV12 {
  blobRefs?: Blobrefs
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
/**
 * A field of a timeline item the device moved to its local blob store; the item keeps a preview at ``path``.
 *
 * A ``text/*`` blob is the full UTF-8 text of the string previewed at ``path``. Any other blob is media whose
 * ``data`` (or ``blob``) key was removed from the block at ``path``'s parent, or a ``data:`` URL string replaced
 * by a short description.
 */
export interface TimelineBlobRef {
  blobId: Blobid
  bytes: Bytes
  mediaType: Mediatype
  path: Path
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
