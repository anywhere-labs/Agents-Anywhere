"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Copy, Check, ExternalLink, GitBranch } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { highlightCode } from "@/lib/code-highlight"
import { openNativeFilePreviewWindow } from "@/components/panels/files-panel"
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

type GitDirective = {
  action: "stage" | "commit" | "push"
  attrs: Record<string, string>
}

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
  const directivePattern = /::git-(stage|commit|push)\{([^}]*)\}/g
  const matches = Array.from(text.matchAll(directivePattern))
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
    const directive: GitDirective = {
      action: gitDirectiveAction(match[1] ?? "stage"),
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

function serializeGitDirectives(directives: GitDirective[]): string {
  return directives
    .map((directive) => {
      const branch = directive.attrs.branch
      return branch ? `${directive.action}:${encodeURIComponent(branch)}` : directive.action
    })
    .join(",")
}

function parseGitDirectives(input?: string): GitDirective[] {
  if (!input) return []
  return input
    .split(",")
    .map(parseGitDirective)
    .filter((directive): directive is GitDirective => directive !== null)
}

function parseGitDirective(input: string): GitDirective | null {
  const [actionInput, branchInput] = input.split(":", 2)
  if (!actionInput) return null
  const action = gitDirectiveAction(actionInput)
  const branch = branchInput ? decodeURIComponent(branchInput) : ""
  return { action, attrs: branch ? { branch } : {} }
}

function gitDirectiveAction(action: string): GitDirective["action"] {
  if (action === "commit" || action === "push") return action
  return "stage"
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
      <span>{directives.map((directive) => gitDirectiveLabel(directive, tSession)).join(" · ")}</span>
    </Badge>
  )
}

function gitDirectiveLabel(
  directive: GitDirective,
  tSession: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (directive.action === "stage") return tSession("gitOperationStaged")
  if (directive.action === "commit") return tSession("gitOperationCommitted")
  const branch = directive.attrs.branch
  if (branch) return tSession("gitOperationPushedBranch", { branch })
  return tSession("gitOperationPushed")
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
