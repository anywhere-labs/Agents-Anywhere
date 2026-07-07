"use client"

import type { AttachedFile } from "@/components/attachment-input"
import type { TimelineItem } from "@/features/dashboard/types"
import { sortTimelineItems } from "@/components/session/session-utils"

export const OPTIMISTIC_ITEM_PREFIX = "optimistic-message:"

export function timelineClientMessageId(item: TimelineItem): string | null {
  const value = item.source.clientMessageId
  return typeof value === "string" ? value : null
}

export function isOptimisticTimelineItem(item: TimelineItem): boolean {
  return item.id.startsWith(OPTIMISTIC_ITEM_PREFIX) || item.source.optimistic === true
}

function hasTimelineItemForClientMessage(items: TimelineItem[], clientMessageId: string): boolean {
  return items.some((item) => !isOptimisticTimelineItem(item) && timelineClientMessageId(item) === clientMessageId)
}

export function preserveOptimisticItems(baseItems: TimelineItem[], previousItems: TimelineItem[]): TimelineItem[] {
  const preserved = previousItems.filter((item) => {
    if (!isOptimisticTimelineItem(item)) return false
    const clientMessageId = timelineClientMessageId(item)
    return !clientMessageId || !hasTimelineItemForClientMessage(baseItems, clientMessageId)
  })
  return preserved.length > 0 ? mergeTimelineItems(baseItems, preserved) : baseItems
}

export function mergeTimelineItems(
  currentItems: TimelineItem[],
  incomingItems: TimelineItem[],
): TimelineItem[] {
  if (incomingItems.length === 0) return currentItems
  const byId = new Map(currentItems.map((item) => [item.id, item]))
  for (const item of incomingItems) {
    const clientMessageId = timelineClientMessageId(item)
    if (clientMessageId && !isOptimisticTimelineItem(item)) {
      for (const [id, existing] of byId) {
        if (isOptimisticTimelineItem(existing) && timelineClientMessageId(existing) === clientMessageId) {
          byId.delete(id)
        }
      }
    }
    const existing = byId.get(item.id)
    if (!existing || existing.updatedSeq <= item.updatedSeq) byId.set(item.id, item)
  }
  return sortTimelineItems(Array.from(byId.values()))
}

export function buildOptimisticUserMessage({
  sessionId,
  clientMessageId,
  text,
  attachments,
  items,
  nextSeq,
}: {
  sessionId: string
  clientMessageId: string
  text: string
  attachments: AttachedFile[]
  items: TimelineItem[]
  nextSeq: number
}): TimelineItem {
  const now = new Date().toISOString()
  const lastOrderSeq = items.reduce((max, item) => Math.max(max, item.orderSeq), 0)
  const orderSeq = Math.max(lastOrderSeq + 1, nextSeq + 1)
  const optimisticAttachments = attachments.map((attachment) => ({
    fileId: `optimistic:${attachment.id}`,
    name: attachment.name,
    size: attachment.size,
    mediaType: attachment.file.type,
    optimistic: true,
  }))
  return {
    id: `${OPTIMISTIC_ITEM_PREFIX}${clientMessageId}`,
    sessionId,
    turnId: null,
    type: "message",
    status: "pending",
    role: "user",
    content: optimisticAttachments.length > 0 ? { text, attachments: optimisticAttachments } : { text },
    source: { clientMessageId, optimistic: true },
    orderSeq,
    revision: 0,
    contentHash: clientMessageId,
    updatedSeq: orderSeq,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
}

export function markOptimisticItemFailed(item: TimelineItem, message: string): TimelineItem {
  return {
    ...item,
    status: "failed",
    content: { ...item.content, error: message },
    updatedAt: new Date().toISOString(),
  }
}
