/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-scope. Do not edit; run `yarn contracts:generate`. */

/**
 * Runtime Control 2.1 scope. runtime is always the provider type; runtimeId selects one immutable instance of that provider.
 */
export interface RuntimeScope {
  /**
   * Stable provider type such as codex, claude, or dsh.
   */
  runtime: string
  /**
   * Concrete runtime instance identifier. Legacy compatibility instances use runtimeId equal to runtime.
   */
  runtimeId: string
}
