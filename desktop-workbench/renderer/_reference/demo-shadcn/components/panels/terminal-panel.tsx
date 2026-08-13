"use client"

import { Plus } from "lucide-react"

import { Separator } from "@/components/ui/separator"

export function TerminalPanelBody() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 items-center gap-2 px-3">
        <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1 text-xs">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          <span className="font-mono">zsh</span>
        </div>
        <button
          type="button"
          aria-label="新建终端"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
        </div>
      <Separator />

      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[13px] leading-relaxed">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">➜</span>
          <span className="font-semibold text-cyan-400">py-cli-uv-tools</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-muted-foreground">
          <span className="text-emerald-400">➜</span>
          <span className="size-2 animate-pulse bg-foreground/70" />
        </div>
      </div>
    </div>
  )
}
