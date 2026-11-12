/* eslint-disable */
/**
 * Generated from protocol 1.2 artifact prepare-request.
 * Do not edit by hand; run `yarn protocol:generate`.
 */

export type Clientpreparationid = string
export type Connectorid = string
export type Projectid = string
export type Runtimeid = string

export interface PrepareWorkspaceRequest {
  clientPreparationId: Clientpreparationid
  connectorId: Connectorid
  projectId: Projectid
  runtimeId: Runtimeid
}
