"use client"

import { useTranslations } from "next-intl"

import { useAuth } from "@/components/auth/auth-context"
import { PageHeader } from "@/components/pages/page-header"
import { ServiceAnnouncementCard } from "@/components/pages/service-announcement-card"
import { ScrollArea } from "@/components/ui/scroll-area"

export function AnnouncementsPage() {
  const { session } = useAuth()
  const t = useTranslations("admin.announcements")
  const tAnnouncement = useTranslations("announcement.admin")

  return (
    <ScrollArea className="@container/page h-full w-full bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pb-16 pt-14 @min-[68rem]/page:pt-8">
        <PageHeader title={tAnnouncement("title")} description={t("description")} />
        {session?.accessToken ? <ServiceAnnouncementCard token={session.accessToken} /> : null}
      </div>
    </ScrollArea>
  )
}
