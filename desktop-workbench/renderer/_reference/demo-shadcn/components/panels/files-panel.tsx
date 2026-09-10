"use client"

import { ChevronRight, File, Folder } from "lucide-react"

import { sampleCode, sampleFiles } from "@/lib/data"
import { useWorkspace } from "@/components/workspace-context"

const BASE_PATH = "/Users/t4wefan/Documents/Codex/2026-06-20/py-cli-uv-tool"

export function FilesPanelBody() {
  const { openPreview } = useWorkspace()

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
          <span className="truncate font-mono text-xs text-muted-foreground">{BASE_PATH}</span>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {sampleFiles.map((node) => (
          <button
            key={node.name}
            type="button"
            onClick={() =>
              node.kind === "file"
                ? openPreview({
                    name: node.name,
                    path: `C:\\Users\\admin\\${node.name}`,
                    lang: node.hint ?? "txt",
                    lines: sampleCode,
                  })
                : undefined
            }
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
          >
            {node.kind === "directory" ? (
              <Folder className="size-4 text-muted-foreground" />
            ) : (
              <File className="size-4 text-muted-foreground" />
            )}
            <span className="truncate font-mono text-[13px]">{node.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{node.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
