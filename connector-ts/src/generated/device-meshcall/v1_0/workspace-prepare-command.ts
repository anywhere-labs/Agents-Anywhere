/* eslint-disable */
/** Generated from contracts/device-meshcall/1.0 artifact workspace-prepare-command. Do not edit; run `yarn contracts:generate`. */

export type Clientpreparationid = string | null
export type Cwd = string | null
export type Preparationid = string
export type Projectid = string | null
export type Runtime = string | null
export type Runtimeid = string

/**
 * ``workspace.prepare``: open the Agent session of a workspace before the first message.
 */
export interface WorkspacePrepareCommand {
  clientPreparationId?: Clientpreparationid
  cwd?: Cwd
  preparationId: Preparationid
  projectId?: Projectid
  runtime?: Runtime
  runtimeId: Runtimeid
  [k: string]: unknown
}
