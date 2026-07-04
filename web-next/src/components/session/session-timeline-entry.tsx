"use client"

import { ChevronDown, CircleAlert, Clock, FilePenLine, Sparkles } from "lucide-react"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { JsonBlock, TimelineStatusBadge, ToolCard } from "@/components/session/session-tool-cards"
import { openSessionFilePreview } from "@/components/markdown-text"
import { cn } from "@/lib/utils"
import type { Approval, ApprovalResolveStatus, SessionView, TimelineItem } from "@/features/dashboard/types"
import { firstTextOf, messageText, recordsOf, textOf } from "@/components/session/session-utils"
import { extractAttachments, stripInjectedAttachmentMentions } from "@/features/dashboard/attachments"
import { MessageAttachments } from "@/components/session/message-attachments"
import { CollapsibleUserMessage } from "@/components/session/collapsible-user-message"

const MarkdownText = dynamic(() => import("../markdown-text").then((mod) => ({ default: mod.MarkdownText })), { ssr: false })

export function TimelineEntry({
  token,
  session,
  item,
  approval,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
}: {
  token: string
  session: SessionView
  item: TimelineItem
  approval?: Approval
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
}) {
  if (item.type === "turn.start" || item.type === "turn.end") return null
  if (item.type === "message") return <MessageCard token={token} session={session} item={item} />
  if (item.type === "tool") {
    return (
      <ToolCard
        item={item}
        token={token}
        session={session}
        approval={approval}
        resolvingApprovalId={resolvingApprovalId}
        resolvingStatus={resolvingStatus}
        onResolveApproval={onResolveApproval}
      />
    )
  }
  if (item.type === "system") return <SystemCard item={item} />
  if (item.type === "artifact") return <ArtifactCard token={token} session={session} item={item} />
  return null
}

function MessageCard({ token, session, item }: { token: string; session: SessionView; item: TimelineItem }) {
  const text = stripInjectedAttachmentMentions(messageText(item))
  const attachments = extractAttachments(item.content)
  const isUser = item.role === "user"
  const hasAttachments = attachments.length > 0
  const showUserStatus = isUser && (item.status === "pending" || item.status === "failed")
  const content = text ? (
    <MarkdownText text={text} token={token} session={session} />
  ) : hasAttachments ? null : (
    <JsonBlock value={item.content} />
  )
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
        {!content && !hasAttachments ? (
          <div className="min-w-0 max-w-full bg-transparent px-0 py-1">
            <JsonBlock value={item.content} />
          </div>
        ) : null}
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
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", failed ? "border-destructive/35 bg-destructive/5 text-destructive" : "border-border bg-muted/20 text-muted-foreground")}>
      {failed ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <Clock className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0">
        <div className="font-medium">{kind}</div>
        <div className="wrap-break-word">{text || item.status}</div>
      </div>
    </div>
  )
}

function ReasoningEntry({ item }: { item: TimelineItem }) {
  const tSession = useTranslations("dashboard.session")
  const summaries = recordsOf(item.content.summaries)
    .map((summary) => textOf(summary.text))
    .filter((text): text is string => Boolean(text))
  const rawText = textOf(item.content.rawText) || textOf(item.content.text)
  const lines = summaries.length > 0 ? summaries : rawText ? [rawText] : []
  return (
    <Collapsible className="min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="group inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-secondary px-2.5 text-left text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
            <Sparkles className="size-3.5 shrink-0" />
            <span className="truncate">{tSession("reasoning")}</span>
          </button>
        </CollapsibleTrigger>
        {lines.length > 0 ? (
          <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
            <div className="space-y-2 pl-1 text-sm leading-relaxed text-muted-foreground">
              {lines.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          </CollapsibleContent>
        ) : null}
      </div>
    </Collapsible>
  )
}

function ArtifactCard({ token, session, item }: { token: string; session: SessionView; item: TimelineItem }) {
  const kind = textOf(item.content.kind) || "artifact"
  if (kind === "diff") return null
  const path = firstTextOf(item.content.path, item.content.filePath, item.content.file, item.content.uri)
  const title = path ?? kind
  return (
    <Collapsible className="min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
            <FilePenLine className="size-4 shrink-0" />
            <span
              className={cn(
                "code-mono min-w-0 flex-1 truncate text-sm",
                path && "underline-offset-2 group-hover:underline",
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
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <JsonBlock value={item.content} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
