"use client"

import { useState, useMemo } from "react"
import { Monitor, ChevronDown, ArrowUp, Hand } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { CascadingSelector } from "@/components/cascading-selector"
import { AttachmentBar, DragOverlay, useAttachments } from "@/components/attachment-input"
import { WorkspacePicker } from "@/components/workspace-picker"
import { useWorkspace } from "@/components/workspace-context"

export function TaskComposer() {
  const { connectors, sessions } = useWorkspace()

  // Derive online connectors for the device picker
  const deviceOptions = useMemo(
    () =>
      connectors.map((c) => ({
        id: c.id,
        label: c.name,
        disabled: c.status === "offline",
      })),
    [connectors],
  )

  // Derive unique runtimes from sessions (or use defaults)
  const agentOptions = useMemo(() => {
    const runtimes = Array.from(new Set(sessions.map((s) => s.runtime))).sort()
    return runtimes.length > 0
      ? runtimes.map((r) => ({ id: r.toLowerCase(), label: r }))
      : [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }]
  }, [sessions])

  const [selectedDevice, setSelectedDevice] = useState(deviceOptions[0]?.id ?? "")
  const [selectedAgent, setSelectedAgent] = useState(agentOptions[0]?.id ?? "")
  const [selectedModel, setSelectedModel] = useState("gpt-5.5")
  const [selectedReasoning, setSelectedReasoning] = useState("medium")
  const [approval, setApproval] = useState("ask")

  const { attachments, isDragging, add, remove, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useAttachments()

  const models = [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-4", label: "GPT-4" },
    { id: "claude-4", label: "Claude 4" },
  ]
  const reasoningOptions = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ]
  const approvalOptions: { id: string; label: string }[] = [
    { id: "ask", label: "Ask approval" },
    { id: "auto", label: "Auto approve" },
    { id: "readonly", label: "Read only" },
  ]
  const approvalLabel = approvalOptions.find((o) => o.id === approval)?.label ?? "Ask approval"

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center px-6"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DragOverlay isDragging={isDragging} />

      <div className="w-full max-w-3xl">
        <h1 className="mb-8 text-balance text-center text-5xl font-semibold tracking-tight">
          Give the agent a task
        </h1>

        <div className="rounded-2xl border border-border bg-card shadow-sm">
          <div className="px-6 pt-6">
            <Textarea
              placeholder="Describe the task…"
              className="min-h-24 max-h-64 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 text-base leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-2">
            <AttachmentBar
              attachments={attachments}
              onAttach={add}
              onRemove={remove}
              isDragging={isDragging}
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                  <Hand className="size-4" />
                  <span className="text-foreground">{approvalLabel}</span>
                  <ChevronDown className="size-3.5 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {approvalOptions.map((opt) => (
                  <DropdownMenuItem key={opt.id} onSelect={() => setApproval(opt.id)}>
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <CascadingSelector
              icon={<Monitor className="size-4" />}
              primaryOptions={deviceOptions}
              secondaryOptions={agentOptions}
              selectedPrimary={selectedDevice}
              selectedSecondary={selectedAgent}
              onPrimaryChange={setSelectedDevice}
              onSecondaryChange={setSelectedAgent}
              secondaryLabel="Agent"
            />

            <CascadingSelector
              primaryOptions={models}
              secondaryOptions={reasoningOptions}
              selectedPrimary={selectedModel}
              selectedSecondary={selectedReasoning}
              onPrimaryChange={setSelectedModel}
              onSecondaryChange={setSelectedReasoning}
              secondaryLabel="Reasoning"
            />

            <Button size="icon" aria-label="发送任务" className="ml-auto rounded-full">
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>

        <div className="mt-3">
          <WorkspacePicker />
        </div>
      </div>
    </div>
  )
}
