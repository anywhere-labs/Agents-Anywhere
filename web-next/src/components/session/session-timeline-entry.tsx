"use client"

import { ChevronDown, CircleAlert, Clock, FilePenLine, Sparkles } from "lucide-react"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { JsonBlock, TimelineStatusBadge, ToolCard } from "@/components/session/session-tool-cards"
import { openSessionFilePreview } from "@/components/markdown-text"
import { cn } from "@/lib/utils"
import type { Notice, SessionView, TimelineItem } from "@/features/dashboard/types"
import { firstTextOf, messageText, recordsOf, textOf } from "@/components/session/session-utils"
import { extractAttachments, stripInjectedAttachmentMentions } from "@/features/dashboard/attachments"
import { MessageAttachments } from "@/components/session/message-attachments"
import { CollapsibleUserMessage } from "@/components/session/collapsible-user-message"

const MarkdownText = dynamic(() => import("../markdown-text").then((mod) => ({ default: mod.MarkdownText })), { ssr: false })

export function TimelineEntry({
  token,
  session,
  item,
  interaction,
  resolvingNoticeId,
  resolvingActionId,
  onRespondInteraction,
}: {
  token: string
  session: SessionView
  item: TimelineItem
  interaction?: Notice
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  onRespondInteraction: (noticeId: string, actionId: string) => void
}) {
  if (item.type === "turn.start" || item.type === "turn.end") return null
  if (item.type === "message") return <MessageCard token={token} session={session} item={item} />
  if (item.type === "tool") {
    return (
      <ToolCard
        item={item}
        token={token}
        session={session}
        interaction={interaction}
        resolvingNoticeId={resolvingNoticeId}
        resolvingActionId={resolvingActionId}
        onRespondInteraction={onRespondInteraction}
      />
    )
  }
  if (item.type === "system") return <SystemCard item={item} />
  if (item.type === "artifact") return <ArtifactCard token={token} session={session} item={item} />
  return <UnknownTimelineItem item={item} />
}

function MessageCard({ token, session, item }: { token: string; session: SessionView; item: TimelineItem }) {
  const tSession = useTranslations("dashboard.session")
  const text = stripInjectedAttachmentMentions(messageText(item))
  const attachments = extractAttachments(item.content)
  const isUser = item.role === "user"
  const hasAttachments = attachments.length > 0
  const showUserStatus = isUser && item.status === "failed"
  if (!text && !hasAttachments) {
    return (
      <JsonMarker
        item={item}
        title={tSession("timelineUnknownMessage", { role: item.role || "unknown" })}
        icon={<Clock />}
      />
    )
  }
  const content = text ? (
    <MarkdownText text={text} token={token} session={session} />
  ) : null
  const attachmentList = (
    <MessageAttachments
      token={token}
      sessionId={session.id}
      attachments={attachments}
      align={isUser ? "right" : "left"}
    />
  )

  return (
    <div className={cn("flex min-w-0 max-w-full overflow-hidden", isUser && "justify-end")}>
      <div className={cn("flex min-w-0 max-w-[88%] flex-col gap-2 text-sm leading-relaxed", isUser && "items-end")}>
        {isUser ? attachmentList : null}
        {content ? (
          <div
            className={cn(
              "min-w-0 max-w-full",
              isUser ? "rounded-2xl bg-secondary px-4 py-3 text-secondary-foreground" : "bg-transparent px-0 py-1",
            )}
          >
            {isUser ? <CollapsibleUserMessage>{content}</CollapsibleUserMessage> : content}
          </div>
        ) : null}
        {!isUser ? attachmentList : null}
        {showUserStatus ? <TimelineStatusBadge status={item.status} /> : null}
      </div>
    </div>
  )
}

function SystemCard({ item }: { item: TimelineItem }) {
  const kind = textOf(item.content.kind) || "system"
  if (kind === "reasoning") return <ReasoningEntry item={item} />
  const text = textOf(item.content.text) || textOf(item.content.message) || textOf(item.content.rawText)
  const failed = item.status === "failed" || kind === "error"
  const title = text ? `${kind}: ${text}` : `${kind}: ${item.status}`
  return (
    <JsonMarker
      item={item}
      title={title}
      icon={failed ? <CircleAlert /> : <Clock />}
      destructive={failed}
      detail={systemDetail(item.content)}
    />
  )
}

function ReasoningEntry({ item }: { item: TimelineItem }) {
  const tSession = useTranslations("dashboard.session")
  const summaries = recordsOf(item.content.summaries)
    .map((summary) => textOf(summary.text))
    .filter((text): text is string => Boolean(text))
  const rawText = textOf(item.content.rawText) || textOf(item.content.text)
  const lines = summaries.length > 0 ? summaries : rawText ? [rawText] : []
  const title = lines.length > 0
    ? tSession("reasoningSummary", { count: lines.length })
    : tSession("reasoning")
  const marker = (
    <Marker className="w-full">
      <MarkerIcon>
        <Sparkles />
      </MarkerIcon>
      <MarkerContent className="code-mono text-sm">{title}</MarkerContent>
    </Marker>
  )

  if (lines.length === 0) return marker

  return (
    <Collapsible className="min-w-0 max-w-full overflow-hidden">
      <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Marker asChild className="w-full">
            <button type="button" className="text-left">
              <ChevronDown className="shrink-0 -rotate-90 transition-transform group-data-[state=open]/marker:rotate-0" />
              <MarkerIcon>
                <Sparkles />
              </MarkerIcon>
              <MarkerContent className="code-mono text-sm">{title}</MarkerContent>
            </button>
          </Marker>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <div className="flex flex-col gap-2 pl-7 text-sm leading-relaxed text-muted-foreground">
            {lines.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ArtifactCard({ token, session, item }: { token: string; session: SessionView; item: TimelineItem }) {
  const kind = textOf(item.content.kind) || "artifact"
  if (kind === "diff") return null
  const path = firstTextOf(item.content.path, item.content.filePath, item.content.file, item.content.uri)
  const title = path ?? kind
  const markerContent = (
    <>
      <MarkerIcon>
        <FilePenLine />
      </MarkerIcon>
      <span
        className={cn(
          "code-mono min-w-0 flex-1 truncate text-sm",
          path && "underline-offset-2 group-hover/marker:underline",
        )}
        onClick={(event) => {
          if (!path) return
          event.preventDefault()
          event.stopPropagation()
          openSessionFilePreview(token, session, path)
        }}
      >
        {title}
      </span>
      <TimelineStatusBadge status={item.status} />
    </>
  )

  if (!hasExpandableDetail(item.content)) {
    return <Marker className="w-full">{markerContent}</Marker>
  }

  return (
    <Collapsible className="min-w-0 max-w-full overflow-hidden">
      <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Marker asChild>
            <button type="button" className="w-full text-left">
              <ChevronDown className="shrink-0 -rotate-90 transition-transform group-data-[state=open]/marker:rotate-0" />
              {markerContent}
            </button>
          </Marker>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <JsonBlock value={item.content} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function JsonMarker({
  item,
  title,
  icon,
  destructive,
  defaultOpen = false,
  detail,
}: {
  item: TimelineItem
  title: string
  icon?: React.ReactNode
  destructive?: boolean
  defaultOpen?: boolean
  detail?: unknown
}) {
  const detailValue = detail === undefined ? item : detail
  const hasDetail = hasExpandableDetail(detailValue)
  const marker = (
    <Marker className={cn("w-full", destructive && "text-destructive hover:text-destructive")}>
      {icon ? <MarkerIcon>{icon}</MarkerIcon> : null}
      <MarkerContent className="code-mono text-sm">{title}</MarkerContent>
      <TimelineStatusBadge status={item.status} />
    </Marker>
  )

  if (!hasDetail) return marker

  return (
    <Collapsible defaultOpen={defaultOpen} className="min-w-0 max-w-full overflow-hidden">
      <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Marker asChild className={cn("w-full", destructive && "text-destructive hover:text-destructive")}>
            <button type="button" className="text-left">
              <ChevronDown className="shrink-0 -rotate-90 transition-transform group-data-[state=open]/marker:rotate-0" />
              {icon ? <MarkerIcon>{icon}</MarkerIcon> : null}
              <MarkerContent className="code-mono text-sm">{title}</MarkerContent>
              <TimelineStatusBadge status={item.status} />
            </button>
          </Marker>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <JsonBlock value={detailValue} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function UnknownTimelineItem({ item }: { item: TimelineItem }) {
  const tSession = useTranslations("dashboard.session")
  const title = tSession("timelineUnknownItem", { type: item.type || "unknown" })
  return <JsonMarker item={item} title={title} icon={<Clock />} />
}

function hasExpandableDetail(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return true
}

function systemDetail(content: TimelineItem["content"]): Record<string, unknown> {
  const detail = { ...content }
  delete detail.kind
  delete detail.text
  delete detail.message
  delete detail.rawText
  return detail
}
