import type { PublicAnnouncement } from "./types"

export const ANNOUNCEMENT_READ_KEY = "aa.announcement.read.v1"
export const ANNOUNCEMENT_READ_EVENT = "aa:announcement-read"
let memoryReadAt: string | null = null

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

export function isAnnouncementUnread(announcement: PublicAnnouncement | null, readAt: string | null): boolean {
  return Boolean(announcement?.markdown.trim() && timestamp(announcement.publishedAt) > timestamp(readAt))
}

export function announcementPageEnabled(page: string | null): boolean {
  return page === "login" || page === "register" || page === "app"
}

export function readAnnouncementTimestamp(): string | null {
  if (typeof window === "undefined") return null
  try {
    const stored = window.localStorage.getItem(ANNOUNCEMENT_READ_KEY)
    if (timestamp(stored) > timestamp(memoryReadAt)) memoryReadAt = stored
  } catch {
    // Private browsing and storage restrictions must not block authentication.
  }
  return memoryReadAt
}

export function markAnnouncementRead(publishedAt: string): void {
  if (typeof window === "undefined" || !timestamp(publishedAt)) return
  if (timestamp(publishedAt) <= timestamp(readAnnouncementTimestamp())) return
  memoryReadAt = publishedAt
  try {
    window.localStorage.setItem(ANNOUNCEMENT_READ_KEY, publishedAt)
  } catch {
    // Retain the read marker for this tab even if persistent storage is unavailable.
  }
  window.dispatchEvent(new Event(ANNOUNCEMENT_READ_EVENT))
}
