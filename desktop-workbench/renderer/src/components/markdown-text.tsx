"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Copy, Check, ExternalLink, GitBranch } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { highlightCode } from "@/lib/code-highlight"
import { openNativeFilePreviewWindow } from "@/lib/file-preview-window"
import type { SessionView } from "@/features/dashboard/types"
import { useTranslations } from "next-intl"

export function MarkdownText({
  text,
  token,
  session,
  inverted,
}: {
  text: string
  token?: string
  session?: SessionView
  inverted?: boolean
}) {
  return <MarkdownBody text={text} token={token} session={session} inverted={inverted} />
}

function MarkdownBody({
  text,
  token,
  session,
  inverted,
}: {
  text: string
  token?: string
  session?: SessionView
  inverted?: boolean
}) {
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-relaxed [&_a]:underline [&_blockquote]:border-l [&_blockquote]:pl-3 [&_code]:text-[1em] [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:m-0 [&_ul]:list-disc",
        inverted
          ? "[&_pre]:border-primary-foreground/15"
          : "[&_pre]:border-border",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkGitDirectiveBadges]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? "")
            const code = String(children).replace(/\n$/, "")
            if (!match) {
              const previewPath = typeof children === "string" ? parseInlineFileRef(children) : null
              if (previewPath && token && session) {
                return (
                  <span
                    role="button"
                    tabIndex={0}
                    className="inline-flex max-w-full items-baseline gap-0.5 rounded-none bg-transparent p-0 align-baseline text-[1em] text-inherit underline underline-offset-2 hover:text-foreground"
                    onClick={() => openSessionFilePreview(token, session, previewPath)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") openSessionFilePreview(token, session, previewPath)
                    }}
                  >
                    <span className="min-w-0 truncate">{children}</span>
                    <ExternalLink className="relative -top-0.5 size-3 shrink-0" />
                  </span>
                )
              }
              return (
                <code
                  className={cn(
                    className,
                    "rounded-md bg-secondary px-1.5 py-0.5 text-secondary-foreground",
                  )}
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return <MarkdownCodeBlock code={code} language={match[1] ?? "text"} />
          },
          a({ href, children, node: _node, ...props }) {
            const childText = textFromReactChildren(children)
            const path = href && isMarkdownFilePath(href)
              ? stripLineSuffix(href)
              : parseInlineFileRef(childText)
            if (!path || !token || !session) {
              return (
                <a href={href} target="_blank" rel="noreferrer" {...props}>
                  {children}
                </a>
              )
            }
            return (
              <span
                role="button"
                tabIndex={0}
                className="inline-flex max-w-full items-baseline gap-0.5 align-baseline text-left underline underline-offset-2 hover:text-foreground"
                onClick={() => openSessionFilePreview(token, session, path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") openSessionFilePreview(token, session, path)
                }}
              >
                <span className="min-w-0 truncate">{children}</span>
                <ExternalLink className="relative -top-0.5 size-3 shrink-0" />
              </span>
            )
          },
          table({ children, ...props }) {
            return (
              <ScrollArea contentWide className="my-3 min-w-0 max-w-full rounded-xl border border-border">
                <table className="w-full min-w-max border-collapse text-sm" {...props}>
                  {children}
                </table>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            )
          },
          thead({ children, ...props }) {
            return (
              <thead className="border-b border-border bg-muted/40" {...props}>
                {children}
              </thead>
            )
          },
          tbody({ children, ...props }) {
            return <tbody className="divide-y divide-border" {...props}>{children}</tbody>
          },
          tr({ children, ...props }) {
            return (
              <tr className="transition-colors hover:bg-muted/25" {...props}>
                {children}
              </tr>
            )
          },
          th({ children, ...props }) {
            return (
              <th className="border-r border-border px-3 py-2 text-left font-medium text-foreground last:border-r-0" {...props}>
                {children}
              </th>
            )
          },
          td({ children, ...props }) {
            return (
              <td className="border-r border-border px-3 py-2 align-top text-foreground/90 last:border-r-0" {...props}>
                {children}
              </td>
            )
          },
          span({ children, ...props }) {
            const directiveProps = props as React.HTMLAttributes<HTMLSpanElement> & {
              "data-git-actions"?: string
              "data-git-directive"?: string
            }
            if (directiveProps["data-git-directive"] === "true") {
              return <GitDirectiveBadge actions={directiveProps["data-git-actions"]} />
            }
            return <span {...props}>{children}</span>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

const GIT_DIRECTIVE_ACTIONS = [
  "stage",
  "commit",
  "create-branch",
  "push",
  "create-pr",
] as const

type GitDirectiveAction = (typeof GIT_DIRECTIVE_ACTIONS)[number]

type GitDirective = {
  action: GitDirectiveAction
  attrs: Record<string, string>
}

const gitDirectivePattern = new RegExp(
  `::git-(${GIT_DIRECTIVE_ACTIONS.join("|")})\\{([^}]*)\\}`,
  "g",
)

type MarkdownAstNode = {
  type: string
  value?: string
  children?: MarkdownAstNode[]
  data?: {
    hName?: string
    hProperties?: Record<string, string>
  }
}

function remarkGitDirectiveBadges() {
  return (tree: MarkdownAstNode) => {
    replaceGitDirectivesInTextChildren(tree)
    mergeAdjacentGitDirectiveNodes(tree)
  }
}

function replaceGitDirectivesInTextChildren(node: MarkdownAstNode) {
  if (!node.children) return

  const nextChildren: MarkdownAstNode[] = []
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...splitGitDirectiveTextNode(child.value))
      continue
    }
    replaceGitDirectivesInTextChildren(child)
    nextChildren.push(child)
  }
  node.children = nextChildren
}

function splitGitDirectiveTextNode(text: string): MarkdownAstNode[] {
  const matches = Array.from(text.matchAll(gitDirectivePattern))
  if (matches.length === 0) return [{ type: "text", value: text }]

  const nodes: MarkdownAstNode[] = []
  let cursor = 0
  let pendingDirectives: GitDirective[] = []

  const flushDirectives = () => {
    if (pendingDirectives.length === 0) return
    nodes.push(gitDirectiveNode(pendingDirectives))
    pendingDirectives = []
  }

  for (const match of matches) {
    const start = match.index ?? 0
    const before = text.slice(cursor, start)
    if (before) {
      if (before.trim()) flushDirectives()
      nodes.push({ type: "text", value: before })
    }
    const action = gitDirectiveAction(match[1])
    if (!action) continue
    const directive: GitDirective = {
      action,
      attrs: parseDirectiveAttributes(match[2] ?? ""),
    }
    pendingDirectives.push(directive)
    cursor = start + match[0].length
  }

  const after = text.slice(cursor)
  if (after) {
    if (after.trim()) flushDirectives()
    nodes.push({ type: "text", value: after })
  }
  flushDirectives()
  return nodes
}

function gitDirectiveNode(directives: GitDirective[]): MarkdownAstNode {
  return {
    type: "gitDirective",
    data: {
      hName: "span",
      hProperties: {
        "data-git-directive": "true",
        "data-git-actions": serializeGitDirectives(directives),
      },
    },
  }
}

function mergeAdjacentGitDirectiveNodes(node: MarkdownAstNode) {
  if (!node.children) return

  for (const child of node.children) mergeAdjacentGitDirectiveNodes(child)
  node.children = mergeInlineGitDirectiveNodes(node.children)
  node.children = mergeGitDirectiveOnlyParagraphs(node.children)
}

function mergeInlineGitDirectiveNodes(children: MarkdownAstNode[]): MarkdownAstNode[] {
  const merged: MarkdownAstNode[] = []
  let pendingDirectives: GitDirective[] = []
  let pendingSeparators: MarkdownAstNode[] = []

  const flushDirectives = () => {
    if (pendingDirectives.length === 0) return
    merged.push(gitDirectiveNode(pendingDirectives))
    pendingDirectives = []
    pendingSeparators = []
  }

  const flushSeparators = () => {
    if (pendingSeparators.length === 0) return
    merged.push(...pendingSeparators)
    pendingSeparators = []
  }

  for (const child of children) {
    const directives = gitDirectivesFromNode(child)
    if (directives) {
      pendingDirectives.push(...directives)
      pendingSeparators = []
      continue
    }

    if (pendingDirectives.length > 0 && isGitDirectiveSeparator(child)) {
      pendingSeparators.push(child)
      continue
    }

    flushDirectives()
    flushSeparators()
    merged.push(child)
  }

  flushDirectives()
  flushSeparators()
  return merged
}

function mergeGitDirectiveOnlyParagraphs(children: MarkdownAstNode[]): MarkdownAstNode[] {
  const merged: MarkdownAstNode[] = []
  let pendingDirectives: GitDirective[] = []

  const flushDirectives = () => {
    if (pendingDirectives.length === 0) return
    merged.push({
      type: "paragraph",
      children: [gitDirectiveNode(pendingDirectives)],
    })
    pendingDirectives = []
  }

  for (const child of children) {
    const directives = gitDirectivesFromDirectiveOnlyParagraph(child)
    if (directives) {
      pendingDirectives.push(...directives)
      continue
    }

    flushDirectives()
    merged.push(child)
  }

  flushDirectives()
  return merged
}

function gitDirectivesFromDirectiveOnlyParagraph(
  node: MarkdownAstNode,
): GitDirective[] | null {
  if (node.type !== "paragraph" || !node.children) return null

  const directives: GitDirective[] = []
  for (const child of node.children) {
    const childDirectives = gitDirectivesFromNode(child)
    if (childDirectives) {
      directives.push(...childDirectives)
      continue
    }
    if (isGitDirectiveSeparator(child)) continue
    return null
  }

  return directives.length > 0 ? directives : null
}

function gitDirectivesFromNode(node: MarkdownAstNode): GitDirective[] | null {
  const actions = node.data?.hProperties?.["data-git-actions"]
  if (node.type !== "gitDirective" || typeof actions !== "string") return null

  const directives = parseGitDirectives(actions)
  return directives.length > 0 ? directives : null
}

function isGitDirectiveSeparator(node: MarkdownAstNode): boolean {
  if (node.type === "break" || node.type === "html" && node.value === "\n") return true
  if (node.type !== "text") return false
  return !node.value || node.value.trim().length === 0
}

function serializeGitDirectives(directives: GitDirective[]): string {
  return JSON.stringify(directives)
}

function parseGitDirectives(input?: string): GitDirective[] {
  if (!input) return []
  try {
    const values: unknown = JSON.parse(input)
    if (!Array.isArray(values)) return []
    return values.flatMap((value): GitDirective[] => {
      if (!isRecord(value)) return []
      const action = gitDirectiveAction(value.action)
      if (!action || !isRecord(value.attrs)) return []
      const attrs = Object.fromEntries(
        Object.entries(value.attrs).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
      return [{ action, attrs }]
    })
  } catch {
    return []
  }
}

function gitDirectiveAction(action: unknown): GitDirectiveAction | null {
  if (typeof action !== "string") return null
  return GIT_DIRECTIVE_ACTIONS.find((candidate) => candidate === action) ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseDirectiveAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of input.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g)) {
    const key = match[1]
    if (key) attrs[key] = match[2] ?? ""
  }
  return attrs
}

function GitDirectiveBadge({ actions }: { actions?: string }) {
  const tSession = useTranslations("dashboard.session")
  const directives = parseGitDirectives(actions)
  if (directives.length === 0) return null
  return (
    <Badge variant="secondary" className="mx-0.5 inline-flex h-6 gap-1.5 rounded-full px-2.5 align-baseline font-normal">
      <GitBranch data-icon="inline-start" />
      <span className="inline-flex items-center gap-1">
        {directives.map((directive, index) => (
          <React.Fragment key={`${directive.action}-${index}`}>
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            <GitDirectiveLabel directive={directive} tSession={tSession} />
          </React.Fragment>
        ))}
      </span>
    </Badge>
  )
}

function GitDirectiveLabel({
  directive,
  tSession,
}: {
  directive: GitDirective
  tSession: (key: string, values?: Record<string, string | number>) => string
}) {
  const label = gitDirectiveLabel(directive, tSession)
  const url = directive.action === "create-pr" ? safeExternalUrl(directive.attrs.url) : null
  if (!url) return label
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {label}
    </a>
  )
}

function gitDirectiveLabel(
  directive: GitDirective,
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (directive.action === "stage") return tSession("gitOperationStaged")
  if (directive.action === "commit") return tSession("gitOperationCommitted")
  const branch = directive.attrs.branch
  if (directive.action === "create-branch") {
    return branch
      ? tSession("gitOperationCreatedBranchNamed", { branch })
      : tSession("gitOperationCreatedBranch")
  }
  if (directive.action === "push") {
    return branch
      ? tSession("gitOperationPushedBranch", { branch })
      : tSession("gitOperationPushed")
  }
  const isDraft = directive.attrs.isDraft === "true"
  if (isDraft) {
    return branch
      ? tSession("gitOperationCreatedDraftPrForBranch", { branch })
      : tSession("gitOperationCreatedDraftPr")
  }
  return branch
    ? tSession("gitOperationCreatedPrForBranch", { branch })
    : tSession("gitOperationCreatedPr")
}

function safeExternalUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  const tSession = useTranslations("dashboard.session")
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex h-9 items-center justify-between border-b bg-muted/25 px-3">
        <span className="text-xs text-muted-foreground">{language || "text"}</span>
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => undefined)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          aria-label={tSession("copyCode")}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <ScrollArea contentWide className="max-h-96 min-w-0 max-w-full overflow-hidden">
        <pre className="w-max min-w-full p-3 text-sm leading-relaxed">
          <code>{highlightCode(code, language)}</code>
        </pre>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}

function stripLineSuffix(path: string) {
  return path.replace(/:\d+(?::\d+)?$/, "")
}

function parseInlineFileRef(text: string): string | null {
  if (!text || text.includes(" ") || text.includes("://")) return null
  if (!text.includes("/")) return null
  if (!/\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?$/.test(text)) return null
  return stripLineSuffix(text)
}

function textFromReactChildren(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(textFromReactChildren).join("")
  return ""
}

function isMarkdownFilePath(href: string): boolean {
  if (!href) return false
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#") ||
    href.startsWith("//")
  ) {
    return false
  }
  return true
}

export function openSessionFilePreview(token: string, session: SessionView, path: string) {
  openNativeFilePreviewWindow({
    token,
    connectorId: session.connectorId,
    root: session.cwd || ".",
    file: { name: fileNameFromPath(path), path },
  })
}

function fileNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || path
}
