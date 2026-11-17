/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact workspace-call-request. Do not edit; run `yarn contracts:generate`. */

export type Method =
  | "fs.readDir"
  | "fs.readText"
  | "fs.writeFile"
  | "fs.prepareDownload"
  | "fs.uploadPreparedDownload"
  | "terminal.create"
  | "terminal.list"
  | "terminal.rename"
  | "terminal.setPersistent"
  | "terminal.close"
  | "terminal.write"
  | "terminal.resize"
  | "terminal.snapshot"
  | "shell.exec"

/**
 * ``Workspace/call``: one v2 workspace method; ``params`` is its v2 params object.
 */
export interface WorkspaceCallRequest {
  method: Method
  params?: Params
  [k: string]: unknown
}
export interface Params {
  [k: string]: unknown
}
