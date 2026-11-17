/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-instance-spec. Do not edit; run `yarn contracts:generate`. */

/**
 * The immutable runtimeId/runtimeType binding and user-editable name for one runtime instance. Implementations MUST reject changes to runtimeId or runtimeType after creation.
 */
export interface RuntimeInstanceSpec {
  name: string
  runtimeId: string
  runtimeType: string
}
