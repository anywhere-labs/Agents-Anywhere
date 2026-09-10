import type { AuthMe, StoredSession } from "./types"

export function normalizeAuthMe(
  value: unknown,
  fallback: Pick<StoredSession, "userId" | "role">,
): AuthMe {
  const envelope = isRecord(value) ? value : {}
  const candidate = isRecord(envelope.user) ? envelope.user : envelope
  const role = candidate.role === "admin" || candidate.role === "member"
    ? candidate.role
    : fallback.role

  return {
    userId: typeof candidate.userId === "string" && candidate.userId.trim()
      ? candidate.userId
      : fallback.userId,
    email: typeof candidate.email === "string" ? candidate.email : null,
    displayName: typeof candidate.displayName === "string" ? candidate.displayName : "",
    emailVerified: candidate.emailVerified === true,
    role,
    disabled: candidate.disabled === true,
    avatar: typeof candidate.avatar === "string" ? candidate.avatar : null,
    serverTime: typeof envelope.serverTime === "string"
      ? envelope.serverTime
      : typeof candidate.serverTime === "string"
        ? candidate.serverTime
        : "",
  }
}

export function normalizeDesktopOAuthMe(value: unknown): AuthMe {
  const envelope = isRecord(value) ? value : {}
  const candidate = isRecord(envelope.user) ? envelope.user : envelope
  if (
    typeof candidate.userId !== "string" ||
    !candidate.userId.trim() ||
    (candidate.role !== "admin" && candidate.role !== "member")
  ) {
    throw new Error("Desktop OAuth returned an invalid account.")
  }
  return normalizeAuthMe(value, { userId: candidate.userId, role: candidate.role })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}
