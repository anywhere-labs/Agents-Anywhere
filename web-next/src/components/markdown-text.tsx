"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Copy, Check, ExternalLink } from "lucide-react"

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
  return (
    <div
      className={cn(
        "space-y-3 text-sm leading-relaxed [&_a]:underline [&_blockquote]:border-l [&_blockquote]:pl-3 [&_code]:code-mono [&_code]:text-[0.92em] [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:m-0 [&_ul]:list-disc",
        inverted
          ? "[&_pre]:border-primary-foreground/15"
          : "[&_pre]:border-border",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
                    className="code-mono inline-flex max-w-full items-baseline gap-0.5 rounded-none bg-transparent p-0 align-baseline text-[0.92em] text-inherit underline underline-offset-2 hover:text-foreground"
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  const tSession = useTranslations("dashboard.session")
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="my-3 min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex h-9 items-center justify-between border-b bg-muted/25 px-3">
        <span className="code-mono text-xs text-muted-foreground">{language || "text"}</span>
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
        <pre className="code-mono w-max min-w-full p-3 text-xs leading-relaxed">
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
