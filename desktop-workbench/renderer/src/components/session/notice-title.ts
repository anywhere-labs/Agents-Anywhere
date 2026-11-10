import type { Notice } from "@/features/dashboard/types"

/**
 * Message key for a runtime approval whose title the Connector sends in English.
 * Keyed on structured fields, not the English text; null keeps the runtime's title.
 */
export function noticeTitleKey(notice: Pick<Notice, "noticeId" | "interactionType" | "context">): string | null {
  if (notice.interactionType !== "approval") return null
  const source = notice.context?.approvalSource
  const kind = notice.context?.kind
  if (source && typeof source === "object" && ["command", "file_change", "permissions"].includes(String(kind))) {
    return `approvalTitle_codex_${String(kind)}`
  }
  if (notice.noticeId.startsWith("notice_claude_approval_")) return "approvalTitle_claude_tool"
  return null
}
