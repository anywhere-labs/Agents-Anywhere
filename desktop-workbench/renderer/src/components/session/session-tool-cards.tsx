"use client"

import * as React from "react"
import { Bot, Check, ChevronDown, Code2, Copy, FilePenLine, Hammer, Loader2, TerminalSquare } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { InteractionCard } from "@/components/session/session-approval-card"
import { MonacoCodeView, monacoLanguageForFile } from "@/components/monaco-code-view"
import { openSessionFilePreview } from "@/components/markdown-text"
import { cn } from "@/lib/utils"
import { highlightCode } from "@/lib/code-highlight"
import { dashboardApi } from "@/features/dashboard/api"
import type { Notice, SessionView, TimelineItem } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"
import { commandText, firstTextOf, recordsOf, textOf } from "@/components/session/session-utils"

const FILE_CHANGE_MONACO_OPTIONS = {
  folding: false,
  glyphMargin: false,
  lineDecorationsWidth: 8,
  lineNumbersMinChars: 3,
  readOnly: true,
  renderLineHighlight: "none",
  scrollbar: {
    alwaysConsumeMouseWheel: false,
  },
} satisfies import("monaco-editor").editor.IStandaloneEditorConstructionOptions
const INLINE_FILE_CHANGE_PATH_MAX_CHARS = 60

export function ToolCard({
  item,
  token,
  session,
  interaction,
  resolvingNoticeId,
  resolvingActionId,
  open,
  onOpenChange,
  onRespondInteraction,
  readOnly = false,
}: {
  item: TimelineItem
  token: string
  session: SessionView
  interaction?: Notice
  resolvingNoticeId: string | null
  resolvingActionId: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onRespondInteraction: (noticeId: string, actionId: string, input?: Record<string, unknown>) => void
  readOnly?: boolean
}) {
  const tSession = useTranslations("dashboard.session")
  const kind = timelineToolKind(item)
  const isAgentCall = kind === "agent_call"
  const command = timelineToolCommand(item)
  const output =
    textOf(item.content.output) ||
    textOf(item.content.outputPreview) ||
    textOf(item.content.outputText) ||
    textOf(item.content.error)
  const changes = recordsOf(item.content.changes)
  const displayOutput = changes.length > 0 ? null : output
  const title = timelineToolTitle(item, session, tSession)
  const hasDetail = !isAgentCall && Boolean(command || displayOutput || changes.length > 0 || interaction)
  const shouldOpenForInteraction = Boolean(interaction)
  const [localOpen, setLocalOpen] = React.useState(shouldOpenForInteraction)
  const actualOpen = open ?? localOpen
  const updateOpen = React.useCallback((nextOpen: boolean) => {
    if (onOpenChange) {
      onOpenChange(nextOpen)
      return
    }
    setLocalOpen(nextOpen)
  }, [onOpenChange])

  React.useEffect(() => {
    if (shouldOpenForInteraction) updateOpen(true)
  }, [shouldOpenForInteraction, updateOpen])

  if (!hasDetail) {
    return (
      <ToolMarkerRow
        kind={kind}
        status={item.status}
        title={title}
      />
    )
  }

  return (
    <Collapsible open={actualOpen} onOpenChange={updateOpen} className="min-w-0 max-w-full overflow-hidden">
      <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <Marker asChild className="w-full">
            <button type="button" className="text-left">
              <ToolMarkerRowContent
                collapsible
                kind={kind}
                status={item.status}
                title={title}
              />
            </button>
          </Marker>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <ToolDetailPanel
            token={token}
            session={session}
            command={command}
            output={displayOutput}
            changes={changes}
            readOnly={readOnly}
          />
          {interaction ? (
            <div className="mt-2">
              <InteractionCard
                notice={interaction}
                resolvingNoticeId={resolvingNoticeId}
                resolvingActionId={resolvingActionId}
                onRespondInteraction={onRespondInteraction}
                compact
              />
            </div>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolMarkerRow({
  kind,
  status,
  title,
}: {
  kind: string
  status: TimelineItem["status"]
  title: string
}) {
  return (
    <Marker className="w-full">
      <ToolMarkerRowContent kind={kind} status={status} title={title} />
    </Marker>
  )
}

export function ToolMarkerRowContent({
  kind,
  status,
  title,
  collapsible = false,
}: {
  kind: string
  status: TimelineItem["status"]
  title: string
  collapsible?: boolean
}) {
  const active = timelineItemStatusIsActive(status)
  const failed = timelineItemStatusIsFailure(status)
  return (
    <>
      {collapsible ? (
        <ChevronDown className="shrink-0 -rotate-90 transition-transform group-data-[state=open]/marker:rotate-0" />
      ) : null}
      <MarkerIcon>
        <ToolIcon kind={kind} status={status} />
      </MarkerIcon>
      <MarkerContent
        className={cn(
          "code-mono text-sm",
          active && "shimmer",
          failed && "text-destructive",
        )}
      >
        {title}
      </MarkerContent>
    </>
  )
}

export function timelineToolKind(item: TimelineItem): string {
  if (item.type === "artifact") return textOf(item.content.kind) || "artifact"
  return textOf(item.content.kind) || "tool"
}

export function timelineToolTitle(
  item: TimelineItem,
  session: SessionView,
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  const kind = timelineToolKind(item)
  const changes = recordsOf(item.content.changes)
  const createdFilesOnly = changes.length > 0 && changes.every(isCreatedFileChange)
  if (kind === "file_change") {
    const singlePath = changes.length === 1
      ? displayPathForSession(firstTextOf(changes[0]?.path, changes[0]?.filePath, changes[0]?.file, changes[0]?.uri), session.cwd)
      : null
    if (singlePath && singlePath.length <= INLINE_FILE_CHANGE_PATH_MAX_CHARS) {
      return tSession(createdFilesOnly ? "toolCreatedFile" : "toolChangedFile", { path: singlePath })
    }
    return tSession(createdFilesOnly ? "toolCreatedFiles" : "toolChangedFiles")
  }
  if (item.type === "artifact") {
    return firstTextOf(item.content.path, item.content.filePath, item.content.file, item.content.uri) ?? kind
  }
  const input = recordOf(item.content.input)
  if (kind === "agent_call") {
    const action = timelineAgentActionTitle(textOf(item.content.action), tSession)
    const description = firstTextOf(item.content.description, item.content.title)
    return description ? `${action}：${description}` : action
  }
  const command = timelineToolCommand(item)
  const toolName = firstTextOf(item.content.toolName, item.content.name, item.content.tool, item.content.title)
  const target = timelineToolTarget(item, session)
  return kind === "command"
    ? tSession("toolRan", { command: command || tSession("toolCommandFallback") })
    : kind === "web_search"
        ? tSession("toolSearched", { query: textOf(item.content.query) || textOf(input?.query) || tSession("toolWebFallback") })
        : kind === "mcp"
          ? `${textOf(item.content.server) || textOf(input?.server) || tSession("toolMcpFallback")} / ${
              textOf(item.content.tool) || textOf(input?.tool) || tSession("toolToolFallback")
            }`
          : toolName
            ? target ? `${toolName} ${target}` : toolName
            : target || kind
}

function timelineToolCommand(item: TimelineItem): string | null {
  const input = recordOf(item.content.input)
  return commandText(item.content.command) || commandText(input?.command) || commandText(input?.cmd)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function timelineToolTarget(item: TimelineItem, session: SessionView): string | null {
  const input = recordOf(item.content.input)
  const rawPath = firstTextOf(
    item.content.path,
    item.content.filePath,
    item.content.file,
    item.content.uri,
    input?.file_path,
    input?.notebook_path,
    input?.path,
  )
  if (rawPath) return displayPathForSession(rawPath, session.cwd) ?? rawPath
  return firstTextOf(
    item.content.query,
    input?.query,
    item.content.url,
    input?.url,
    item.content.command,
    input?.command,
    input?.cmd,
  )
}

export function ToolDetailPanel({
  token,
  session,
  command,
  output,
  changes,
  readOnly = false,
}: {
  token: string
  session: SessionView
  command: string | null
  output: string | null
  changes: Array<Record<string, unknown>>
  readOnly?: boolean
}) {
  const hasContent = Boolean(command || output || changes.length > 0)
  if (!hasContent) return null
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background">
      {command ? <CodePanel label="command" code={command} language="bash" flush /> : null}
      {changes.length > 0 ? (
        <div className={cn(command && "border-t")}>
          {changes.map((change, index) => (
            <FileChangeRow
              token={token}
              session={session}
              change={change}
              readOnly={readOnly}
              key={`${textOf(change.path) ?? "change"}-${index}`}
            />
          ))}
        </div>
      ) : null}
      {output ? (
        <div className={cn((command || changes.length > 0) && "border-t")}>
          <CodePanel label="output" code={output} language="text" flush />
        </div>
      ) : null}
    </div>
  )
}

export function CodePanel({ label, code, language, flush }: { label: string; code: string; language: string; flush?: boolean }) {
  return <CodePanelFrame label={label} code={code} flush={flush}>
    {language === "diff" ? (
      <DiffPanel code={code} maxHeight={codePanelHeight(code)} />
    ) : (
      <HighlightedCodeContent code={code} language={language} maxHeight={codePanelHeight(code)} />
    )}
  </CodePanelFrame>
}

function CodePanelFrame({
  label,
  code,
  flush,
  action,
  children,
}: {
  label: string
  code: string
  flush?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden bg-background", !flush && "rounded-xl border border-border")}>
      <div className="flex h-9 items-center justify-between border-b bg-muted/25 px-3">
        <span className="code-mono text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {action}
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              navigator.clipboard.writeText(code).catch(() => undefined)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>
      {children}
    </div>
  )
}

function HighlightedCodeContent({ code, language, maxHeight }: { code: string; language: string; maxHeight: number }) {
  return (
    <ScrollArea contentWide className="min-w-0" style={{ height: maxHeight, maxHeight }}>
      <pre className="code-mono min-w-full w-max px-3 py-2 text-xs leading-relaxed">
        <code className="code-mono whitespace-pre">{highlightCode(code, language)}</code>
      </pre>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

export function JsonBlock({ value }: { value: unknown }) {
  return <CodePanel label="json" code={JSON.stringify(value, null, 2)} language="json" />
}

function DiffPanel({ code, maxHeight }: { code: string; maxHeight: number }) {
  const rows = React.useMemo(() => buildDiffRows(code), [code])
  return (
    <ScrollArea contentWide className="min-w-0" style={{ height: maxHeight, maxHeight }}>
      <div className="code-mono w-max min-w-full py-2 text-xs">
        {rows.map((row, index) => (
          <div
            className={cn(
              "grid min-w-full grid-cols-[0.875rem_2.5rem_1px_minmax(0,1fr)] gap-1 px-3 py-0.5 leading-relaxed",
              row.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              row.kind === "delete" && "bg-red-500/10 text-red-700 dark:text-red-300",
              row.kind === "hunk" && "bg-violet-500/10 text-violet-700 dark:text-violet-300",
              row.kind === "file" && "bg-muted/35 text-muted-foreground",
              row.kind === "context" && "text-foreground/80",
            )}
            key={`${index}-${row.text}`}
          >
            <span
              className={cn(
                "code-mono select-none text-center font-medium",
                row.kind === "add" && "text-emerald-700/80 dark:text-emerald-300/80",
                row.kind === "delete" && "text-red-700/80 dark:text-red-300/80",
              )}
            >
              {diffSign(row.kind)}
            </span>
            <span className="code-mono select-none text-right tabular-nums text-muted-foreground">{diffDisplayLine(row)}</span>
            <span className="bg-border" aria-hidden="true" />
            <span className="code-mono whitespace-pre">{row.text}</span>
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

function FileChangeRow({
  token,
  session,
  change,
  readOnly,
}: {
  token: string
  session: SessionView
  change: Record<string, unknown>
  readOnly: boolean
}) {
  const tSession = useTranslations("dashboard.session")
  const path = firstTextOf(change.path, change.filePath, change.file, change.uri) ?? "unknown path"
  const displayPath = displayPathForSession(path, session.cwd) ?? path
  const diff = textOf(change.diff)
  const action = fileChangeAction(change)
  const displayDiff = fileChangeDisplayDiff(change, diff)
  const canPreview = !readOnly && path !== "unknown path"
  const renderAsDiff = Boolean(displayDiff)
  const editorHeight = displayDiff ? codePanelHeight(displayDiff) : diff ? codePanelHeight(diff) : 0
  const [codeOpen, setCodeOpen] = React.useState(false)
  const [codeLoading, setCodeLoading] = React.useState(false)
  const [codeError, setCodeError] = React.useState<string | null>(null)
  const [codeContent, setCodeContent] = React.useState<string | null>(null)

  const showCode = React.useCallback(async () => {
    if (!canPreview) return
    if (codeOpen) {
      setCodeOpen(false)
      return
    }
    setCodeOpen(true)
    if (codeContent !== null || codeLoading) return
    setCodeLoading(true)
    setCodeError(null)
    try {
      const response = await dashboardApi.connectorFsReadText(token, session.connectorId, session.cwd ?? ".", path, 512 * 1024)
      setCodeContent(response.content)
    } catch (error) {
      setCodeError(error instanceof Error ? error.message : tSession("loadCodeFailed"))
    } finally {
      setCodeLoading(false)
    }
  }, [canPreview, codeContent, codeLoading, codeOpen, path, session.connectorId, session.cwd, tSession, token])

  const showCodeAction = renderAsDiff && canPreview ? (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60"
      disabled={codeLoading}
      onClick={showCode}
    >
      {codeLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Code2 className="size-3.5" />}
      {codeOpen ? tSession("hideCode") : tSession("showCode")}
    </button>
  ) : null

  return (
    <div className="min-w-0 max-w-full overflow-hidden border-b last:border-b-0">
      <div className="flex h-9 items-center gap-2 bg-muted/20 px-3 text-sm">
        <FilePenLine className="size-4 text-muted-foreground" />
        <Badge variant="secondary" className="h-5 shrink-0 rounded-md px-1.5 text-[11px] font-normal">
          {tSession(fileChangeActionLabelKey(action))}
        </Badge>
        <button
          type="button"
          className="code-mono min-w-0 truncate rounded-sm text-left text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          disabled={!canPreview}
          onClick={() => {
            if (canPreview) openSessionFilePreview(token, session, path)
          }}
        >
          {displayPath}
        </button>
      </div>
      {diff ? (
        renderAsDiff ? (
          <>
            <CodePanelFrame label="diff" code={displayDiff ?? diff} flush action={showCodeAction}>
              <DiffPanel code={displayDiff ?? diff} maxHeight={editorHeight} />
            </CodePanelFrame>
            {codeOpen ? (
              <div className="border-t">
                {codeError ? (
                  <div className="px-3 py-2 text-sm text-destructive">{codeError}</div>
                ) : codeContent !== null ? (
                  <MonacoCodeView
                    className="min-h-0 min-w-0 max-w-full overflow-hidden"
                    content={codeContent}
                    fileName={path}
                    language={monacoLanguageForFile(path)}
                    options={FILE_CHANGE_MONACO_OPTIONS}
                    style={{ height: codePanelHeight(codeContent) }}
                  />
                ) : (
                  <div className="flex h-24 items-center gap-2 px-3 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {tSession("showCode")}
                  </div>
                )}
              </div>
            ) : null}
          </>
        ) : (
          <div className="border-t">
            <MonacoCodeView
              className="min-h-0 min-w-0 max-w-full overflow-hidden"
              content={diff}
              fileName={path}
              language={monacoLanguageForFile(path)}
              options={FILE_CHANGE_MONACO_OPTIONS}
              style={{ height: editorHeight }}
            />
          </div>
        )
      ) : null}
    </div>
  )
}

function ToolIcon({ kind, status }: { kind: string; status: TimelineItem["status"] }) {
  const className = cn("size-4", status === "failed" ? "text-destructive" : "text-muted-foreground")
  if (kind === "command") return <TerminalSquare className={className} />
  if (kind === "file_change") return <FilePenLine className={className} />
  if (kind === "agent_call") return <Bot className={className} />
  return <Hammer className={className} />
}

function timelineAgentActionTitle(
  action: string | null,
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  const key = {
    invoke: "toolAgentInvoke",
    spawn: "toolAgentSpawn",
    send_input: "toolAgentSendInput",
    resume: "toolAgentResume",
    wait: "toolAgentWait",
    close: "toolAgentClose",
  }[action ?? ""] ?? "toolAgentUnknown"
  return tSession(key)
}

export function TimelineStatusBadge({ status }: { status: TimelineItem["status"] }) {
  const variant = status === "failed" ? "destructive" : "secondary"
  return (
    <Badge variant={variant} className="h-5 text-[11px] font-normal">
      {status}
    </Badge>
  )
}

export function timelineItemStatusIsActive(status: TimelineItem["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting_approval"
}

export function timelineItemStatusIsFailure(status: TimelineItem["status"]): boolean {
  return status === "failed" || status === "cancelled" || status === "interrupted"
}

type DiffRow = {
  kind: "add" | "delete" | "hunk" | "file" | "context"
  newLine: number | null
  oldLine: number | null
  text: string
}

function buildDiffRows(code: string): DiffRow[] {
  let oldLine: number | null = null
  let newLine: number | null = null
  return code.split("\n").map((line) => {
    const parsed = parseDiffLine(line)
    if (parsed.kind === "hunk") {
      const hunk = parseDiffHunk(line)
      oldLine = hunk?.oldStart ?? null
      newLine = hunk?.newStart ?? null
      return { ...parsed, oldLine: null, newLine: null }
    }
    if (parsed.kind === "file") {
      return { ...parsed, oldLine: null, newLine: null }
    }

    const displayOldLine = parsed.kind === "add" ? null : oldLine
    const displayNewLine = parsed.kind === "delete" ? null : newLine
    if (parsed.kind !== "add" && oldLine != null) oldLine += 1
    if (parsed.kind !== "delete" && newLine != null) newLine += 1
    return { ...parsed, oldLine: displayOldLine, newLine: displayNewLine }
  })
}

function diffSign(kind: DiffRow["kind"]) {
  if (kind === "add") return "+"
  if (kind === "delete") return "-"
  return ""
}

function diffDisplayLine(row: DiffRow) {
  if (row.kind === "add") return row.newLine ?? ""
  if (row.kind === "delete") return row.oldLine ?? ""
  return row.newLine ?? row.oldLine ?? ""
}

function parseDiffLine(line: string) {
  if (line.startsWith("@@")) return { kind: "hunk" as const, text: line }
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return { kind: "file" as const, text: line }
  }
  if (line.startsWith("+")) return { kind: "add" as const, text: line.slice(1) }
  if (line.startsWith("-")) return { kind: "delete" as const, text: line.slice(1) }
  return { kind: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line }
}

function parseDiffHunk(line: string) {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line)
  if (!match) return null
  return { oldStart: Number(match[1]), newStart: Number(match[2]) }
}

function codePanelHeight(code: string) {
  const lines = Math.max(1, code.split("\n").length)
  return Math.max(96, Math.min(320, lines * 19 + 24))
}

function isUnifiedDiffLike(value: string) {
  return value.split("\n").some((line) => {
    if (line.startsWith("@@")) return true
    if (line.startsWith("diff --git") || line.startsWith("index ")) return true
    if (line.startsWith("--- ") || line.startsWith("+++ ")) return true
    if (/^[+-]\S/.test(line)) return true
    return false
  })
}

type FileChangeAction = "add" | "modify" | "delete" | "rename" | "unknown"

function fileChangeAction(change: Record<string, unknown>): FileChangeAction {
  const direct = textOf(change.action) || textOf(change.type) || textOf(change.status)
  const nestedKind = change.kind && typeof change.kind === "object" && !Array.isArray(change.kind)
    ? textOf((change.kind as Record<string, unknown>).type)
    : textOf(change.kind)
  const value = (nestedKind || direct || "").toLowerCase()
  if (value === "add" || value === "added" || value === "create" || value === "created") return "add"
  if (value === "delete" || value === "deleted" || value === "remove" || value === "removed") return "delete"
  if (value === "rename" || value === "renamed" || value === "move" || value === "moved") return "rename"
  if (value === "modify" || value === "modified" || value === "change" || value === "changed" || value === "edit" || value === "edited") return "modify"
  return "unknown"
}

function fileChangeActionLabelKey(action: FileChangeAction): string {
  if (action === "add") return "fileChangeAdded"
  if (action === "delete") return "fileChangeDeleted"
  if (action === "rename") return "fileChangeRenamed"
  if (action === "modify") return "fileChangeModified"
  return "fileChangeUnknown"
}

function displayPathForSession(path: string | null, cwd: string | null | undefined): string | null {
  if (!path) return null
  if (!cwd) return path
  const normalizedPath = normalizeDisplayPath(path)
  const normalizedCwd = normalizeDisplayPath(cwd)
  if (normalizedPath === normalizedCwd) return "."
  const cwdPrefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`
  if (!normalizedPath.startsWith(cwdPrefix)) return path
  return normalizedPath.slice(cwdPrefix.length) || "."
}

function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function fileChangeDisplayDiff(change: Record<string, unknown>, diff: string | null): string | null {
  if (!diff) return null
  if (isUnifiedDiffLike(diff)) return diff
  const action = fileChangeAction(change)
  if (action === "add") return diff.split("\n").map((line) => `+${line}`).join("\n")
  if (action === "delete") return diff.split("\n").map((line) => `-${line}`).join("\n")
  return null
}

export function isCreatedFileChange(change: Record<string, unknown>) {
  return fileChangeAction(change) === "add"
}
