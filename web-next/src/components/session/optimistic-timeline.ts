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

export function preserveOptimisticItems(baseItems: TimelineItem[], previousItems: TimelineItem[]): TimelineItem[] {
  const optimisticItems = previousItems.filter(isOptimisticTimelineItem)
  return optimisticItems.length > 0 ? mergeTimelineItems(optimisticItems, baseItems) : baseItems
}

export function mergeTimelineItems(
  currentItems: TimelineItem[],
  incomingItems: TimelineItem[],
): TimelineItem[] {
  if (incomingItems.length === 0) return currentItems
  const byId = new Map(currentItems.map((item) => [item.id, item]))
  for (const item of incomingItems) {
    let nextItem = item
    const clientMessageId = timelineClientMessageId(item)
    if (!isOptimisticTimelineItem(item)) {
      for (const [id, existing] of byId) {
        if (optimisticUserMessageMatchesServerItem(existing, item, clientMessageId)) {
          nextItem = mergeOptimisticAttachmentMetadata(item, existing)
          byId.delete(id)
        }
      }
    }
    const existing = byId.get(nextItem.id)
    if (!existing || existing.updatedSeq <= nextItem.updatedSeq) byId.set(nextItem.id, nextItem)
  }
  return sortTimelineItems(Array.from(byId.values()))
}

function optimisticUserMessageMatchesServerItem(
  optimisticItem: TimelineItem,
  serverItem: TimelineItem,
  serverClientMessageId: string | null,
): boolean {
  if (!isOptimisticTimelineItem(optimisticItem)) return false
  if (optimisticItem.type !== "message" || optimisticItem.role !== "user") return false
  if (serverItem.type !== "message" || serverItem.role !== "user") return false
  if (optimisticItem.status !== "pending") return false
  const optimisticClientMessageId = timelineClientMessageId(optimisticItem)
  return Boolean(serverClientMessageId && optimisticClientMessageId === serverClientMessageId)
}

function mergeOptimisticAttachmentMetadata(serverItem: TimelineItem, optimisticItem: TimelineItem): TimelineItem {
  const serverAttachments = attachmentsFromContent(serverItem.content)
  const optimisticAttachments = attachmentsFromContent(optimisticItem.content)
  if (serverAttachments.length === 0 && optimisticAttachments.length === 0) return serverItem

  const nextAttachments = (serverAttachments.length > 0 ? serverAttachments : optimisticAttachments).map((attachment, index) => {
    const optimistic = optimisticAttachments[index]
    if (!optimistic || typeof optimistic !== "object") return attachment
    const optimisticPreviewUrl = optimistic.previewUrl
    return {
      ...optimistic,
      ...attachment,
      name: attachment.name ?? optimistic.name,
      size: attachment.size ?? optimistic.size,
      mediaType: attachment.mediaType ?? optimistic.mediaType,
      previewUrl: attachment.previewUrl ?? optimisticPreviewUrl,
      optimistic: attachment.optimistic === true,
    }
  })

  return {
    ...serverItem,
    content: {
      ...serverItem.content,
      attachments: nextAttachments,
    },
  }
}

function attachmentsFromContent(content: TimelineItem["content"]): Array<Record<string, unknown>> {
  const raw = content.attachments
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
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
    previewUrl: attachment.type === "image" ? URL.createObjectURL(attachment.file) : undefined,
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

export function withServerAttachments(
  item: TimelineItem,
  attachments: Array<Record<string, unknown>>,
): TimelineItem {
  if (attachments.length === 0) return item
  const optimisticAttachments = attachmentsFromContent(item.content)
  const nextAttachments = attachments.map((attachment, index) => {
    const optimistic = optimisticAttachments[index]
    if (optimistic) revokeOptimisticAttachmentPreview(optimistic)
    return {
      ...attachment,
      optimistic: false,
    }
  })
  return {
    ...item,
    content: {
      ...item.content,
      attachments: nextAttachments,
    },
  }
}

export function revokeOptimisticItemResources(item: TimelineItem): void {
  for (const attachment of attachmentsFromContent(item.content)) {
    revokeOptimisticAttachmentPreview(attachment)
  }
}

function revokeOptimisticAttachmentPreview(attachment: Record<string, unknown>): void {
  const previewUrl = attachment.previewUrl
  if (typeof previewUrl !== "string" || !previewUrl.startsWith("blob:")) return
  URL.revokeObjectURL(previewUrl)
}

export function markOptimisticItemFailed(item: TimelineItem, message: string): TimelineItem {
  return {
    ...item,
    status: "failed",
    content: { ...item.content, error: message },
    updatedAt: new Date().toISOString(),
  }
}
