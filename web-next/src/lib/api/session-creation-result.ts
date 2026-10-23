import { ApiError } from "./errors"

/** Older servers can return HTTP 200 for a Runtime business refusal. */
export function assertSessionCreationAccepted(response: { session: { id: string }; connectorResult: unknown }) {
  const result = response.connectorResult
  if (!result || typeof result !== "object") return
  const value = result as Record<string, unknown>
  if (value.ok !== false && value.accepted !== false && value.messageAccepted !== false) return
  throw new ApiError({
    status: 409, kind: "http",
    code: typeof value.code === "string" ? value.code : "runtime_operation_failed",
    detail: typeof value.message === "string" ? value.message : "Runtime did not accept the task.",
    payload: { detail: { ...value, sessionId: response.session.id,
      platformSessionCreated: true, resultUnknown: true, retryable: false } },
  })
}
