/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact client-call-request. Do not edit; run `yarn contracts:generate`. */

export type Bytebudget = number | null
export type Deviceid = string
export type Grantid = string
export type Sessionid = string
export type Clientid = string | null
export type Platform = string | null
export type Userid = string
export type Commandid = string
export type Deadline = string
export type Inputdigest = string
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type Path = string
export type Route =
  | "session.createAndStart"
  | "session.snapshot"
  | "session.timeline"
  | "session.events"
  | "session.runtime.state"
  | "session.runtime.capabilities"
  | "session.runtime.notices"
  | "session.runtime.queue"
  | "session.runtime.commands"
  | "session.runtime.catalogs.model"
  | "session.runtime.catalogs.permission"
  | "session.planning.get"
  | "session.goal.get"
  | "session.plans.list"
  | "session.plans.get"
  | "session.plans.markdown"
  | "session.runtime.messages"
  | "session.runtime.steer"
  | "session.runtime.interrupt"
  | "session.runtime.notices.respond"
  | "session.runtime.selections"
  | "session.runtime.commands.execute"
  | "session.sync"
  | "session.planning.execute"
  | "session.goal.execute"
  | "session.runtime.queue.clear"
  | "session.runtime.queue.reorder"
  | "session.runtime.queue.resume"
  | "session.runtime.queue.update"
  | "session.runtime.queue.delete"
  | "session.runtime.queue.retry"
  | "session.runtime.queue.sendNow"
  | "session.blobs.read"
  | "session.terminals.create"
  | "session.terminals.list"
  | "session.terminals.close"
  | "session.terminals.rename"
  | "session.terminals.resize"
  | "connector.fs.list"
  | "connector.fs.readText"
  | "connector.fs.write"
  | "connector.fs.read"
  | "connector.terminals.create"
  | "connector.terminals.list"
  | "connector.terminals.close"
  | "connector.terminals.rename"
  | "connector.terminals.persistence"
  | "connector.terminals.resize"
  | "connector.terminals.write"
  | "connector.terminals.snapshot"
  | "connector.terminalsV1.create"
  | "connector.terminalsV1.list"
  | "connector.terminalsV1.close"
  | "connector.terminalsV1.rename"
  | "connector.terminalsV1.resize"
  | "connector.shell.exec"
  | "connector.shell.tasks.start"
  | "connector.shell.tasks.wait"
  | "connector.shell.tasks.cancel"
  | "connector.runtime.catalogs.model"
  | "connector.runtime.catalogs.permission"
  | "connector.runtime.commands"
  | "workflow.session.tree"
  | "workflow.session.position"
  | "workflow.session.close"
  | "workflow.session.configuration.get"
  | "workflow.session.configuration.update"
  | "workflow.session.operations"
  | "workflow.session.recover"
/**
 * whether the session is archived in the directory
 */
export type Archived = boolean | null
/**
 * the Server's records of the attachments the body references
 */
export type Attachments = AttachmentRef[] | null
export type Encrypted = boolean
export type Fileid = string
export type Mediatype = string
export type Name = string
export type Sha256 = string | null
export type Size = number
export type Path1 = string
export type Root = string
/**
 * create-and-start: the directory row the Server created
 */
export type Sessionid1 = string | null
export type Takeover = boolean | null
/**
 * the URL the client downloads from (a preview download carries its previewAccessToken); default the device's own fs/transfers route
 */
export type Downloadurl = string | null
export type Path2 = string
export type Token = string
export type Transferid = string

/**
 * ``Client/call``: one client API request. ``path`` is what the client called (``/api/v2/...``) with the
 * query left out; ``route`` names its table entry so the device checks it and picks the lane first.
 */
export interface ClientCallRequest {
  body?: Body
  byteBudget?: Bytebudget
  caller: ClientCaller
  command?: ClientCommand | null
  method: Method
  path: Path
  query?: Query
  route: Route
  server?: ClientServerFacts | null
  [k: string]: unknown
}
export interface Body {
  [k: string]: unknown
}
/**
 * Who sent the request, as the Server authenticated it.
 */
export interface ClientCaller {
  agent?: AgentCaller | null
  clientId?: Clientid
  platform?: Platform
  userId: Userid
  [k: string]: unknown
}
/**
 * The supervisor session a delegated request acts for (``ClientCaller.agent``).
 */
export interface AgentCaller {
  deviceId: Deviceid
  grantId: Grantid
  sessionId: Sessionid
  [k: string]: unknown
}
/**
 * A command route's receipt identity: the device's inbox replays by ``commandId``.
 */
export interface ClientCommand {
  commandId: Commandid
  deadline: Deadline
  inputDigest: Inputdigest
  [k: string]: unknown
}
export interface Query {
  [k: string]: string
}
/**
 * Facts the Server owns. The device takes them over whatever the body says, on ``Client/call`` only.
 */
export interface ClientServerFacts {
  archived?: Archived
  attachments?: Attachments
  /**
   * a preview read: the file its token opened
   */
  preview?: ClientPreview | null
  sessionId?: Sessionid1
  takeover?: Takeover
  /**
   * fs/read: where the device PUTs the bytes
   */
  transfer?: ClientTransfer | null
  [k: string]: unknown
}
/**
 * An attachment the Server holds (staged upload): the device fetches it by ``fileId``.
 */
export interface AttachmentRef {
  encrypted?: Encrypted
  fileId: Fileid
  mediaType: Mediatype
  name: Name
  sha256?: Sha256
  size: Size
  [k: string]: unknown
}
/**
 * The file a preview token opened, as the Server verified it.
 */
export interface ClientPreview {
  path: Path1
  root: Root
  [k: string]: unknown
}
/**
 * The relay a ``fs/read`` download goes through: where the device ``PUT``s the bytes, and where the client
 * fetches them.
 */
export interface ClientTransfer {
  downloadUrl?: Downloadurl
  path: Path2
  token: Token
  transferId: Transferid
  [k: string]: unknown
}
