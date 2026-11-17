/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-stop-params. Do not edit; run `yarn contracts:generate`. */

/**
 * Parameters for stopping one named runtime instance.
 */
export interface RuntimeStopParams {
  /**
   * Stable provider type; it MUST equal the instance's immutable runtimeType.
   */
  runtime: string
  runtimeId: string
  /**
   * Server switch operation this request belongs to. Sent only to Connectors that declare the switchFence feature, always together with switchRevision.
   */
  operationId?: string
  /**
   * Monotonic switch revision of this runtime instance. The Connector rejects a revision lower than the accepted one, or the accepted revision with another operationId, with code switch_revision_stale.
   */
  switchRevision?: number
}
