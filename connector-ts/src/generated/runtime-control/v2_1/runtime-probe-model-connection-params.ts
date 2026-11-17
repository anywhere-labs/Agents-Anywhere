/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-probe-model-connection-params. Do not edit; run `yarn contracts:generate`. */

/**
 * Parameters for probing the model connection of one running runtime instance. Only sent to Connectors that list modelProbe in features.
 */
export interface RuntimeProbeModelConnectionParams {
  /**
   * Stable provider type; it MUST equal the instance's immutable runtimeType.
   */
  runtime: string
  runtimeId: string
}
