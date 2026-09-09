import type { DeviceRuntimeView } from "@/features/dashboard/types"

/**
 * Presentation rules for a configured runtime instance.
 *
 * A runtime type is only "supported by the connector"; real availability and
 * error states belong to the instance and only exist once it is configured and
 * started. Nothing here may turn "the local program is not running" into a
 * fault badge.
 */

export type RuntimeStatusTone = "ok" | "progress" | "warning" | "error" | "neutral"

/** Errors that mean "not running yet", not "something is broken". */
const NOT_RUNNING_ERROR_CODES = new Set([
  "runtime_unavailable",
  "runtime_not_started",
  "runtime_not_configured",
  "connector_offline",
])

export function runtimeErrorCode(runtime: DeviceRuntimeView): string | null {
  const code = runtime.error?.code
  return typeof code === "string" && code ? code : null
}

export function runtimeErrorReason(runtime: DeviceRuntimeView): string | null {
  const message = runtime.error?.message
  if (typeof message === "string" && message.trim()) return message
  return runtimeErrorCode(runtime)
}

export function isRuntimeNotRunningCode(code: string | null | undefined): boolean {
  return typeof code === "string" && NOT_RUNNING_ERROR_CODES.has(code)
}

export function runtimeStatusTone(runtime: DeviceRuntimeView): RuntimeStatusTone {
  if (runtime.status === "running") return "ok"
  if (runtime.status === "starting" || runtime.status === "stopping") return "progress"
  if (runtime.status === "error") {
    return isRuntimeNotRunningCode(runtimeErrorCode(runtime)) ? "warning" : "error"
  }
  return "neutral"
}

/** Configured instance the user has not started yet. */
export function runtimeIsNotStarted(runtime: DeviceRuntimeView): boolean {
  return runtime.configured && !runtime.active
}

/** Instances the user can target: running, or starting and therefore imminent. */
export function runtimeIsSelectable(runtime: DeviceRuntimeView): boolean {
  return runtime.configured
    && runtime.active
    && (runtime.status === "running" || runtime.status === "starting")
}
