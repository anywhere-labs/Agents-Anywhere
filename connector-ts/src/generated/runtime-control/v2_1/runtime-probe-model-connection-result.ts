/* eslint-disable */
/** Generated from contracts/runtime-control/2.1 artifact runtime-probe-model-connection-result. Do not edit; run `yarn contracts:generate`. */

/**
 * Reply to runtime.probeModelConnection: the outcome of one minimal model request sent with the connection the running instance loaded, and the digest of that connection. It never contains the API key.
 */
export interface RuntimeProbeModelConnectionResult {
  /**
   * SHA-256 (lowercase hex) of the probed connection, computed like configDigest in runtime-start-result; null when the instance has no model connection.
   */
  configDigest: string | null
  /**
   * Identity of the Connector process that answered.
   */
  instanceId?: string
  probe: {
    /**
     * Stable reason for failed or skipped, such as probe_unauthorized, probe_not_found, probe_rate_limited, probe_rejected, probe_upstream_error, probe_unreachable, probe_timeout, probe_invalid_response, not_configured, model_connection_unsupported or model_unknown.
     */
    code?: string | null
    latencyMs?: number | null
    message?: string | null
    model?: string | null
    protocol?: ("openai_responses" | "openai_chat" | "anthropic") | null
    /**
     * passed: a valid model reply came back. failed: the request failed or the reply was not a model reply. skipped: there was nothing to call (no connection, no capability, or no model AA can name).
     */
    state: "passed" | "failed" | "skipped"
  }
  runtime?: string
  runtimeId: string
  [k: string]: unknown
}
