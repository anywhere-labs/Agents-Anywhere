"use client"

import { Copy } from "lucide-react"
import { useTranslations } from "next-intl"

import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { sampleThread } from "@/lib/data"

export function ChatThread() {
  const tSession = useTranslations("dashboard.session")

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
      {sampleThread.map((msg) => (
        <div key={msg.id} className="space-y-3">
          <p className="text-[15px] leading-relaxed text-foreground/90">{msg.content}</p>

          {msg.code ? (
            <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
              {/* Sticky header: always visible while scrolling */}
              <div className="sticky top-0 z-10 flex items-center justify-between bg-muted/30 px-4 pt-3 pb-2 backdrop-blur-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {msg.code.lang}
                </span>
                <button
                  type="button"
                  aria-label={tSession("copyCode")}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
              <ScrollArea className="max-h-80">
                <pre className="px-4 pb-4 pt-1 code-mono text-[13px] leading-relaxed">
                  {msg.code.lines.join("\n")}
                </pre>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>
          ) : null}

          {msg.list ? (
            <ul className="space-y-2">
              {msg.list.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <code className="rounded bg-muted px-1.5 py-0.5 code-mono text-[13px]">{item}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  )
}
