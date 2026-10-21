"use client"

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { MarkdownText } from "@/components/markdown-text"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { announcementsApi } from "@/features/announcements/api"
import {
  ANNOUNCEMENT_READ_EVENT, ANNOUNCEMENT_READ_KEY, announcementPageEnabled,
  isAnnouncementUnread, markAnnouncementRead, readAnnouncementTimestamp,
} from "@/features/announcements/read-state"
import type { PublicAnnouncement } from "@/features/announcements/types"

export function AnnouncementGate({ page }: { page: string | null }) {
  const t = useTranslations("announcement")
  const format = useFormatter()
  const [announcement, setAnnouncement] = useState<PublicAnnouncement | null>(null)

  useEffect(() => {
    setAnnouncement(null)
    if (!announcementPageEnabled(page)) return
    let controller: AbortController | null = null
    let lastCheck = 0
    const check = async (force = false) => {
      if (document.visibilityState === "hidden" || (!force && Date.now() - lastCheck < 60_000)) return
      lastCheck = Date.now()
      controller?.abort()
      const request = new AbortController()
      controller = request
      try {
        const result = await announcementsApi.current(request.signal)
        if (!request.signal.aborted) {
          setAnnouncement(isAnnouncementUnread(result.announcement, readAnnouncementTimestamp()) ? result.announcement : null)
        }
      } catch {
        // Announcements are optional; a failed check must not interrupt the page.
      }
    }
    const onFocus = () => { void check() }
    const onRead = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== ANNOUNCEMENT_READ_KEY) return
      setAnnouncement(current => isAnnouncementUnread(current, readAnnouncementTimestamp()) ? current : null)
    }
    void check(true)
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    window.addEventListener("storage", onRead)
    window.addEventListener(ANNOUNCEMENT_READ_EVENT, onRead)
    return () => {
      controller?.abort()
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
      window.removeEventListener("storage", onRead)
      window.removeEventListener(ANNOUNCEMENT_READ_EVENT, onRead)
    }
  }, [page])

  const dismiss = () => {
    if (announcement) markAnnouncementRead(announcement.publishedAt)
    setAnnouncement(null)
  }
  if (!announcement || !announcementPageEnabled(page)) return null

  return (
    <Dialog open onOpenChange={open => { if (!open) dismiss() }}>
      <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("publishedAt", { time: format.dateTime(new Date(announcement.publishedAt), { dateStyle: "medium", timeStyle: "short" }) })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto [overflow-wrap:anywhere]">
          <MarkdownText text={announcement.markdown} />
        </div>
        <DialogFooter><Button onClick={dismiss}>{t("acknowledge")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
