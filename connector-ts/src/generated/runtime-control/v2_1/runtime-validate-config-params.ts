/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-validate-config-params. Do not edit; run `yarn contracts:generate`. */

/**
 * Parameters for validating one named runtime instance configuration without starting it.
 */
export interface RuntimeValidateConfigParams {
  config: {
    [k: string]: unknown
  }
  /**
   * Non-negative revision safe to compose and compare in JavaScript.
   */
  configRevision: number
  name: string
  /**
   * Server switch operation this request belongs to. Sent only to Connectors that declare the switchFence feature, always together with switchRevision.
   */
  operationId?: string
  /**
   * Stable provider type; it MUST equal the instance's immutable runtimeType.
   */
  runtime: string
  runtimeId: string
  /**
   * Monotonic switch revision of this runtime instance. The Connector rejects a revision lower than the accepted one, or the accepted revision with another operationId, with code switch_revision_stale.
   */
  switchRevision?: number
}
