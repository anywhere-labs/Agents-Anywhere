import type { TimelineItem, UploadedAttachment } from "./api";

export const ATTACHMENT_ONLY_PROMPT = "(No text content.)";

export function createClientMessageId(prefix = "opt"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function turnIdFromSendResult(result: unknown): string | null {
  if (
    result &&
    typeof result === "object" &&
    "turnId" in result &&
    typeof result.turnId === "string"
  ) {
    return result.turnId;
  }
  return null;
}

export function createOptimisticUserMessage({
  sessionId,
  clientMessageId,
  content,
  visibleContent = content.trim(),
  attachments = [],
  status = "pending",
  turnId = null,
  now = new Date().toISOString(),
}: {
  sessionId: string;
  clientMessageId: string;
  content: string;
  visibleContent?: string;
  attachments?: UploadedAttachment[];
  status?: TimelineItem["status"];
  turnId?: string | null;
  now?: string;
}): TimelineItem {
  return {
    id: clientMessageId,
    sessionId,
    turnId,
    type: "message",
    status,
    role: "user",
    content:
      attachments.length > 0
        ? { text: visibleContent, attachments }
        : { text: content },
    source: {},
    orderSeq: Number.MAX_SAFE_INTEGER,
    revision: 0,
    contentHash: "",
    updatedSeq: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
