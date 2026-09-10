"use client"

import { Download, FileCode2, Search } from "lucide-react"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import type { PreviewTarget } from "@/components/workspace-context"

function tokenize(line: string) {
  // Lightweight highlighting for the preview, intentionally simple.
  const commentMatch = line.match(/^(\s*)(#.*)$/)
  if (commentMatch) {
    return (
      <span className="text-muted-foreground italic">{line}</span>
    )
  }
  const parts = line.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)
  const keywords = /\b(import|from|def|return|if|else|for|while|class|with|as|in|True|False|None|print|os|sys)\b/g
  return parts.map((part, i) => {
    if (/^["']/.test(part)) {
      return (
        <span key={i} className="text-emerald-400">
          {part}
        </span>
      )
    }
    const sub: React.ReactNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    keywords.lastIndex = 0
    while ((m = keywords.exec(part)) !== null) {
      if (m.index > last) sub.push(part.slice(last, m.index))
      sub.push(
        <span key={`${i}-${m.index}`} className="text-violet-400">
          {m[0]}
        </span>,
      )
      last = m.index + m[0].length
    }
    if (last < part.length) sub.push(part.slice(last))
    return <span key={i}>{sub}</span>
  })
}

export function PreviewPanelBody({ target }: { target: PreviewTarget }) {
  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <FileCode2 className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{target.name}</span>
        <div className="ml-2 flex items-center gap-2">
          <Switch id="edit-toggle" />
          <Label htmlFor="edit-toggle" className="text-sm text-muted-foreground">
            Edit
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-1 text-muted-foreground">
          <span className="px-1 text-xs">{target.lang}</span>
          <button type="button" aria-label="下载" className="rounded-md p-1.5 hover:bg-accent hover:text-foreground">
            <Download className="size-4" />
          </button>
          <button type="button" aria-label="搜索" className="rounded-md p-1.5 hover:bg-accent hover:text-foreground">
            <Search className="size-4" />
          </button>
        </div>
      </div>

      <div className="border-b border-border px-4 py-2">
        <span className="font-mono text-xs text-muted-foreground">{target.path}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[13px] leading-6">
        {target.lines.map((line, i) => (
          <div key={i} className="flex hover:bg-muted/30">
            <span className="w-12 shrink-0 select-none px-2 text-right text-muted-foreground/50">{i + 1}</span>
            <pre className="flex-1 whitespace-pre px-3">{tokenize(line)}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
