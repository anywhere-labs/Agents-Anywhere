"use client"

import * as React from "react"
import { Check, ChevronDown, Code2, Copy, FilePenLine, Hammer, Loader2, TerminalSquare } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { ApprovalCard } from "@/components/session/session-approval-card"
import { MonacoCodeView, monacoLanguageForFile } from "@/components/monaco-code-view"
import { openSessionFilePreview } from "@/components/markdown-text"
import { cn } from "@/lib/utils"
import { highlightCode } from "@/lib/code-highlight"
import { dashboardApi } from "@/features/dashboard/api"
import type { Approval, ApprovalResolveStatus, SessionView, TimelineItem } from "@/features/dashboard/types"
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

export function ToolCard({
  item,
  token,
  session,
  approval,
  resolvingApprovalId,
  resolvingStatus,
  onResolveApproval,
}: {
  item: TimelineItem
  token: string
  session: SessionView
  approval?: Approval
  resolvingApprovalId: string | null
  resolvingStatus: ApprovalResolveStatus | null
  onResolveApproval: (approvalId: string, status: ApprovalResolveStatus) => void
}) {
  const tSession = useTranslations("dashboard.session")
  const kind = timelineToolKind(item)
  const command = commandText(item.content.command)
  const output = textOf(item.content.outputPreview) || textOf(item.content.outputText) || textOf(item.content.error)
  const changes = recordsOf(item.content.changes)
  const title = timelineToolTitle(item, tSession)
  const defaultOpen = Boolean(approval)

  return (
    <Collapsible defaultOpen={defaultOpen} className="min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground">
            <ChevronDown className="size-3.5 shrink-0 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
            <ToolIcon kind={kind} status={item.status} />
            <span className="code-mono min-w-0 flex-1 truncate text-sm">{title}</span>
            <TimelineStatusBadge status={item.status} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 max-w-full overflow-hidden">
          <ToolDetailPanel
            token={token}
            session={session}
            command={command}
            output={output}
            changes={changes}
            fallback={item.content}
          />
          {approval ? (
            <div className="mt-2">
              <ApprovalCard
                approval={approval}
                resolvingApprovalId={resolvingApprovalId}
                resolvingStatus={resolvingStatus}
                onResolveApproval={onResolveApproval}
                compact
              />
            </div>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function timelineToolKind(item: TimelineItem): string {
  if (item.type === "artifact") return textOf(item.content.kind) || "artifact"
  return textOf(item.content.kind) || "tool"
}

export function timelineToolTitle(
  item: TimelineItem,
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (item.type === "artifact") {
    return firstTextOf(item.content.path, item.content.filePath, item.content.file, item.content.uri) ?? (textOf(item.content.kind) || "artifact")
  }
  const kind = timelineToolKind(item)
  const changes = recordsOf(item.content.changes)
  const createdFilesOnly = changes.length > 0 && changes.every(isCreatedFileChange)
  return kind === "command"
    ? tSession("toolRan", { command: commandText(item.content.command) || tSession("toolCommandFallback") })
    : kind === "file_change"
      ? tSession(createdFilesOnly ? "toolCreatedFiles" : "toolChangedFiles")
      : kind === "web_search"
        ? tSession("toolSearched", { query: textOf(item.content.query) || tSession("toolWebFallback") })
        : kind === "mcp"
          ? `${textOf(item.content.server) || tSession("toolMcpFallback")} / ${
              textOf(item.content.tool) || tSession("toolToolFallback")
            }`
          : kind
}

export function ToolDetailPanel({
  token,
  session,
  command,
  output,
  changes,
  fallback,
}: {
  token: string
  session: SessionView
  command: string | null
  output: string | null
  changes: Array<Record<string, unknown>>
  fallback: unknown
}) {
  const hasContent = Boolean(command || output || changes.length > 0)
  if (!hasContent) return <JsonBlock value={fallback} />
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
    <ScrollArea contentWide className="min-w-0" style={{ maxHeight }}>
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
    <ScrollArea contentWide className="min-w-0" style={{ maxHeight }}>
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
}: {
  token: string
  session: SessionView
  change: Record<string, unknown>
}) {
  const tSession = useTranslations("dashboard.session")
  const path = firstTextOf(change.path, change.filePath, change.file, change.uri) ?? "unknown path"
  const diff = textOf(change.diff)
  const canPreview = path !== "unknown path"
  const renderAsDiff = diff ? isUnifiedDiffLike(diff) : false
  const editorHeight = diff ? codePanelHeight(diff) : 0
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
        <button
          type="button"
          className="code-mono min-w-0 truncate rounded-sm text-left text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          disabled={!canPreview}
          onClick={() => {
            if (canPreview) openSessionFilePreview(token, session, path)
          }}
        >
          {path}
        </button>
      </div>
      {diff ? (
        renderAsDiff ? (
          <>
            <CodePanelFrame label="diff" code={diff} flush action={showCodeAction}>
              <DiffPanel code={diff} maxHeight={editorHeight} />
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
  if (status === "running") return <Loader2 className={cn(className, "animate-spin")} />
  return <Hammer className={className} />
}

export function TimelineStatusBadge({ status }: { status: TimelineItem["status"] }) {
  const variant = status === "failed" ? "destructive" : "secondary"
  return (
    <Badge variant={variant} className="h-5 text-[11px] font-normal">
      {status}
    </Badge>
  )
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

export function isCreatedFileChange(change: Record<string, unknown>) {
  const diff = textOf(change.diff)
  return Boolean(diff && !isUnifiedDiffLike(diff))
}
