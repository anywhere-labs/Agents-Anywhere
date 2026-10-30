"use client"

import type { AttachedFile } from "@/components/attachment-input"
import type { TimelineItem } from "@/features/dashboard/types"
import { compareTimelineItems, sortTimelineItems } from "@/components/session/session-utils"
import {
  incomingTimelineItemCanReplace,
  mergeSequencedTimelineSnapshot,
} from "@/components/session/timeline-sequence"

export const OPTIMISTIC_ITEM_PREFIX = "optimistic-message:"

// Timeline arrays/items are immutable. Replacements retain the same ID/order
// index; WeakMap keys let closed sessions and superseded arrays be collected.
const timelineIndexes = new WeakMap<TimelineItem[], Map<string, number>>()

export function timelineClientMessageId(item: TimelineItem): string | null {
  const value = item.source.clientMessageId
  return typeof value === "string" ? value : null
}

export function isOptimisticTimelineItem(item: TimelineItem): boolean {
  return item.id.startsWith(OPTIMISTIC_ITEM_PREFIX) || item.source.optimistic === true
}

export function preserveOptimisticItems(baseItems: TimelineItem[], previousItems: TimelineItem[]): TimelineItem[] {
  const optimisticItems = previousItems.filter(isOptimisticTimelineItem)
  return mergeTimelineItems(optimisticItems, baseItems)
}

export function mergeTimelineSnapshot(
  currentItems: TimelineItem[],
  currentNextSeq: number,
  snapshotItems: TimelineItem[],
  snapshotNextSeq: number,
): { items: TimelineItem[]; nextSeq: number } {
  const merged = mergeSequencedTimelineSnapshot(
    currentItems,
    currentNextSeq,
    snapshotItems,
    snapshotNextSeq,
    isOptimisticTimelineItem,
  )
  return {
    ...merged,
    items: mergeTimelineItems(
      merged.items.filter(isOptimisticTimelineItem),
      merged.items.filter((item) => !isOptimisticTimelineItem(item)),
    ),
  }
}

export function mergeTimelineItems(
  currentItems: TimelineItem[],
  incomingItems: TimelineItem[],
): TimelineItem[] {
  const incoming = incomingItems.length === 1 ? incomingItems[0] : undefined
  const index = incoming ? timelineIndexes.get(currentItems)?.get(incoming.id) : undefined
  if (incoming && index !== undefined) {
    const existing = currentItems[index]!
    if (canReplaceTimelineItemInPlace(existing, incoming)) {
      if (!incomingTimelineItemCanReplace(existing, incoming) || existing === incoming) return currentItems
      if ((index === 0 || compareTimelineItems(currentItems[index - 1]!, incoming) <= 0)
        && (index === currentItems.length - 1 || compareTimelineItems(incoming, currentItems[index + 1]!) <= 0)) {
        const result = currentItems.slice()
        result[index] = incoming
        timelineIndexes.set(result, timelineIndexes.get(currentItems)!)
        return result
      }
    }
  }

  const byId = new Map(currentItems.map((item) => [item.id, item]))
  for (const item of incomingItems) {
    let nextItem = item
    const clientMessageId = timelineClientMessageId(item)
    if (!isOptimisticTimelineItem(item) && item.type === "message" && item.role === "user" && clientMessageId) {
      for (const [id, existing] of byId) {
        if (optimisticUserMessageMatchesServerItem(existing, item, clientMessageId)) {
          nextItem = mergeOptimisticAttachmentMetadata(item, existing)
          byId.delete(id)
        }
      }
    }
    const existing = byId.get(nextItem.id)
    if (!existing || incomingTimelineItemCanReplace(existing, nextItem)) {
      byId.set(nextItem.id, nextItem)
    }
  }
  const result = reconcileDshAssistantActivity(sortTimelineItems(Array.from(byId.values())))
  timelineIndexes.set(result, new Map(result.map((item, index) => [item.id, index])))
  return result
}

function canReplaceTimelineItemInPlace(existing: TimelineItem, incoming: TimelineItem): boolean {
  if (isOptimisticTimelineItem(existing) || isOptimisticTimelineItem(incoming)) return false
  if (incoming.role === "user" || incoming.type !== existing.type || incoming.role !== existing.role) return false
  if (incoming.orderSeq !== existing.orderSeq) return false
  if (sourceString(incoming, "runtime") !== sourceString(existing, "runtime")
    || sourceString(incoming, "itemType") !== sourceString(existing, "itemType")
    || sourceString(incoming, "replacedBy") !== sourceString(existing, "replacedBy")) return false
  if (!isDshAssistantMessage(incoming)) return true
  // Completed DSH items participate in deduplication. A changed hash, lifecycle
  // or legacy revision category must take the reconciliation path.
  return incoming.status === existing.status && (incoming.status !== "done"
    || (incoming.contentHash === existing.contentHash && (incoming.revision > 1) === (existing.revision > 1)))
}

function reconcileDshAssistantActivity(items: TimelineItem[]): TimelineItem[] {
  const itemIds = new Set(items.map((item) => item.id))
  const supersededIds = new Set<string>()

  for (const item of items) {
    const replacedBy = sourceString(item, "replacedBy")
    if (replacedBy && itemIds.has(replacedBy)) supersededIds.add(item.id)
  }

  const nativeByHash = new Map<string, string>()
  const legacyByHash = new Map<string, string>()
  for (const item of items) {
    if (item.type === "message" && item.role === "user") {
      nativeByHash.clear()
      legacyByHash.clear()
      continue
    }
    if (!isDshAssistantMessage(item) || item.status !== "done") continue
    const itemType = sourceString(item, "itemType")
    const candidate = itemType === "message" ? nativeByHash.get(item.contentHash)
      : itemType === null && item.revision === 1 ? legacyByHash.get(item.contentHash) : undefined
    if (candidate !== undefined) supersededIds.add(candidate)
    // Keep the nearest eligible candidate, including already superseded ones,
    // matching the old backwards scan without rescanning a whole turn.
    if (itemType === "assistant_activity") nativeByHash.set(item.contentHash, item.id)
    if (itemType === null && item.revision > 1) legacyByHash.set(item.contentHash, item.id)
  }

  return supersededIds.size > 0 ? items.filter((item) => !supersededIds.has(item.id)) : items
}

function isDshAssistantMessage(item: TimelineItem): boolean {
  return item.type === "message" && item.role === "assistant" && sourceString(item, "runtime") === "dsh"
}

function sourceString(item: TimelineItem, key: string): string | null {
  const value = item.source[key]
  return typeof value === "string" && value.length > 0 ? value : null
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

  const optimisticByFileId = new Map(
    optimisticAttachments.flatMap((attachment) =>
      typeof attachment.fileId === "string" ? [[attachment.fileId, attachment] as const] : [],
    ),
  )
  const nextAttachments = (serverAttachments.length > 0 ? serverAttachments : optimisticAttachments).map((attachment, index) => {
    const optimistic = typeof attachment.fileId === "string"
      ? optimisticByFileId.get(attachment.fileId) ?? optimisticAttachments[index]
      : optimisticAttachments[index]
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
    fileId: attachment.uploaded?.fileId ?? `optimistic:${attachment.id}`,
    name: attachment.uploaded?.name ?? attachment.name,
    size: attachment.uploaded?.size ?? attachment.size,
    mediaType: attachment.uploaded?.mediaType ?? attachment.mediaType,
    openUrl: attachment.uploaded?.openUrl,
    downloadUrl: attachment.uploaded?.downloadUrl,
    previewUrl: attachment.type === "image" ? attachment.preview : undefined,
    optimistic: true,
  }))
  return {
    id: `${OPTIMISTIC_ITEM_PREFIX}${clientMessageId}`,
    sessionId,
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
  const optimisticByFileId = new Map(
    optimisticAttachments.flatMap((attachment) =>
      typeof attachment.fileId === "string" ? [[attachment.fileId, attachment] as const] : [],
    ),
  )
  const nextAttachments = attachments.map((attachment, index) => {
    const optimistic = typeof attachment.fileId === "string"
      ? optimisticByFileId.get(attachment.fileId) ?? optimisticAttachments[index]
      : optimisticAttachments[index]
    return {
      ...optimistic,
      ...attachment,
      previewUrl: attachment.previewUrl ?? optimistic?.previewUrl,
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
