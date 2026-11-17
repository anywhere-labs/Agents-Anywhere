import type { AuthConfig } from "./types"

/**
 * The deployment requires end-to-end encryption and turned the Web client off:
 * a browser cannot keep session content encrypted end to end, so it must not
 * show the workspace. Desktop and the phone apps carry the encrypted channel.
 */
export function webDeniedByE2ee(config: Pick<AuthConfig, "e2ee"> | null | undefined): boolean {
  return config?.e2ee?.mode === "required" && config.e2ee.web === "deny"
}
