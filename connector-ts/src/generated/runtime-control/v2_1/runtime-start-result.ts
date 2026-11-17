/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-start-result. Do not edit; run `yarn contracts:generate`. */

/**
 * Reply to runtime.start. Status, error and phase follow RuntimeInstanceStatus; modelConnection reports what the adapter did with the saved model connection; configDigest and instanceId identify the loaded connection and the Connector process.
 */
export interface RuntimeStartResult {
  /**
   * SHA-256 (lowercase hex) of the model connection the running instance loaded, computed like the Server's connection digest; null when the runtime takes no model connection, has none configured, or is not running a configuration.
   */
  configDigest?: string | null
  error?: {
    [k: string]: unknown
  } | null
  /**
   * Identity of the Connector process that answered; a restarted Connector reports a new value.
   */
  instanceId?: string
  modelConnection?: ModelConnectionStatus | null
  phase?: {
    [k: string]: unknown
  } | null
  runtime?: string
  runtimeId: string
  status: "starting" | "running" | "error"
  [k: string]: unknown
}
/**
 * What the runtime actually did with the saved model connection. It never contains the API key.
 */
export interface ModelConnectionStatus {
  externalOwner?: string | null
  mode?: string | null
  protocol?: ("openai_responses" | "openai_chat" | "anthropic") | null
  reason?: string | null
  scope?: ("instance" | "session" | "native_global") | null
  state: "applied" | "failed" | "managed_externally" | "not_configured"
}
