"use client"

import * as React from "react"
import { CircleAlert, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { TimelineEntry } from "@/components/session/session-timeline-entry"
import { Badge } from "@/components/ui/badge"
import { dashboardApi } from "@/features/dashboard/api"
import type { PublicSessionShareResponse, SessionView } from "@/features/dashboard/types"
import { apiPath } from "@/lib/api"
import { isVisibleTimelineItem, runtimeLabel } from "@/components/session/session-utils"

export function PublicSessionShare({ shareId }: { shareId: string }) {
  const t = useTranslations("dashboard.session")
  const [share, setShare] = React.useState<PublicSessionShareResponse | null>(null)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setError(false)
    dashboardApi.getPublicSessionShare(shareId).then((result) => {
      if (!cancelled) setShare(result)
    }).catch(() => {
      if (!cancelled) setError(true)
    })
    return () => {
      cancelled = true
    }
  }, [shareId])

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center text-muted-foreground">
          <CircleAlert className="size-6" />
          <p className="text-sm">{t("publicShareUnavailable")}</p>
        </div>
      </main>
    )
  }

  if (!share) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-label={t("publicShareLoading")} />
      </main>
    )
  }

  const session = publicSessionView(share)
  const items = share.items.filter(isVisibleTimelineItem)
  const attachmentUrl = (fileId: string) => apiPath(
    `/public/shares/${encodeURIComponent(share.shareId)}/attachments/${encodeURIComponent(fileId)}`,
  )

  return (
    <main className="h-dvh overflow-x-hidden overflow-y-auto overscroll-y-contain bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[calc(48rem+2rem)] items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Agents Anywhere</p>
            <h1 className="truncate text-base font-semibold">{share.session.title || t("untitled")}</h1>
          </div>
          <Badge variant="secondary" className="shrink-0 font-normal">
            {share.scope === "message" ? t("publicSharedReply") : t("publicSharedSession")}
          </Badge>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[calc(48rem+2rem)] flex-col gap-3 overflow-hidden px-4 py-8">
        <p className="text-xs text-muted-foreground">
          {share.session.runtimeName?.trim() || runtimeLabel(share.session.runtime)}
        </p>
        {items.map((item) => (
          <TimelineEntry
            key={item.id}
            token=""
            session={session}
            item={item}
            resolvingNoticeId={null}
            resolvingActionId={null}
            onRespondInteraction={() => undefined}
            readOnly
            attachmentUrl={attachmentUrl}
          />
        ))}
      </div>
    </main>
  )
}

function publicSessionView(share: PublicSessionShareResponse): SessionView {
  return {
    id: share.session.id,
    connectorId: "",
    connectorStatus: "offline",
    runtime: share.session.runtime,
    runtimeName: share.session.runtimeName,
    externalSessionId: null,
    title: share.session.title,
    cwd: share.session.cwd,
    status: "idle",
    takeover: false,
    pinned: false,
    pinnedAt: null,
    archived: false,
    archivedAt: null,
    unread: false,
    lastReadSeq: 0,
    latestTurnEndSeq: 0,
    lastSyncedAt: null,
    sourceObservedAt: null,
    lastActivityAt: null,
    lastItemAt: null,
    lastItemOrderSeq: null,
    sortAt: null,
    updatedSeq: 0,
  }
}
