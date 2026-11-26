"use client"

// The conversation's right side panel (client-experience-proposal §2.4; Effi Cloud panel.tsx; v2 session tool
// sidebar): Files (the conversation's directory, and files the thread points at), Changes (what this conversation's
// edits did, and the directory's uncommitted git diff), Terminal (one in the conversation's directory) and Plan (the
// agent's latest plan and its background tasks). The page decides where it sits: beside the thread (≥ 1280), over it
// (768–1279) or in a bottom sheet (phones).
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  FileDiffIcon,
  FilesIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react"

import { diffCounts, lineDiff } from "@/components/conversation/diff"
import { useI18n } from "@/components/i18n-provider"
import { TerminalView } from "@/components/terminal/terminal-view"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockLine } from "@/components/ui/code-block"
import { FileBrowser } from "@/components/workbench/file-browser"
import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { clientLabel } from "@/lib/terminal/label"
import { createMeshTerminalTransport } from "@/lib/terminal/mesh-transport"
import type { Control, DeviceRecord, Message, PlanPart, TerminalInfo, ToolPart } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { parseUnifiedDiff, type DiffFile, type DiffLine } from "@/lib/workbench/unified-diff"

type TunnelDevice = Pick<DeviceRecord, "id" | "mode_hint" | "presence">

export type PanelTab = "files" | "diff" | "terminal" | "plan"
export const PANEL_TABS: PanelTab[] = ["files", "diff", "terminal", "plan"]

const TAB_ICON: Record<PanelTab, typeof FilesIcon> = {
  files: FilesIcon,
  diff: FileDiffIcon,
  terminal: SquareTerminalIcon,
  plan: ListChecksIcon,
}

export function SidePanel({
  tunnelManager,
  device,
  sessionId,
  cwd,
  messages,
  control,
  tab,
  onTab,
  onClose,
  openFile,
  className,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  sessionId: string
  cwd?: string
  messages: Message[]
  control: Control | null
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  onClose: () => void
  openFile?: { path: string; nonce: number } | null
  className?: string
}) {
  const { t } = useI18n()
  const label: Record<PanelTab, string> = {
    files: t("panel.files"),
    diff: t("panel.diff"),
    terminal: t("panel.terminal"),
    plan: t("panel.plan"),
  }
  // Terminals stay mounted once opened so switching tabs does not drop the attach.
  const [terminalSeen, setTerminalSeen] = useState(tab === "terminal")
  if (tab === "terminal" && !terminalSeen) setTerminalSeen(true)

  return (
    <aside className={cn("flex min-h-0 flex-col bg-background", className)}>
      <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-2">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {PANEL_TABS.map((id) => {
            const Icon = TAB_ICON[id]
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => onTab(id)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  tab === id && "bg-secondary text-foreground"
                )}
              >
                <Icon className="size-3.5" />
                {label[id]}
              </button>
            )
          })}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t("panel.close")} onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-3">
        {tab === "files" && (
          <FileBrowser
            tunnelManager={tunnelManager}
            device={device}
            initialPath={cwd}
            openFile={openFile}
            layout="stack"
            className="min-h-0 flex-1"
          />
        )}
        {tab === "diff" && (
          <ChangesTab tunnelManager={tunnelManager} device={device} cwd={cwd} messages={messages} />
        )}
        {terminalSeen && (
          <div className={cn("min-h-0 flex-1 flex-col", tab === "terminal" ? "flex" : "hidden")}>
            <ConversationTerminal tunnelManager={tunnelManager} device={device} sessionId={sessionId} cwd={cwd} />
          </div>
        )}
        {tab === "plan" && <PlanTab messages={messages} control={control} />}
      </div>
    </aside>
  )
}

// ── Changes ───────────────────────────────────────────────────────────────────────────────────────────────────────

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <CodeBlock size="sm" className="rounded-xl border-0 bg-background">
      <CodeBlockContent className="max-h-96 text-xs">
        {lines.map((l, i) =>
          l.kind === "hunk" ? (
            <CodeBlockLine key={i} className="text-muted-foreground">
              {l.text}
            </CodeBlockLine>
          ) : (
            <CodeBlockLine key={i} variant={l.kind === "add" ? "added" : l.kind === "del" ? "removed" : "default"}>
              {l.text}
            </CodeBlockLine>
          )
        )}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function Counts({ add, del }: { add: number; del: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-success">+{add}</span> <span className="text-destructive">−{del}</span>
    </span>
  )
}

function FileRow({ file, defaultOpen }: { file: DiffFile; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  return (
    <li className="rounded-2xl bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full min-w-0 items-center gap-2 px-3 text-left text-xs"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.path}>
          {file.path}
        </span>
        <Counts add={file.additions} del={file.deletions} />
      </button>
      {open && file.lines.length > 0 && (
        <div className="px-2 pb-2">
          <DiffLines lines={file.lines} />
        </div>
      )}
    </li>
  )
}

/** The edits this conversation's tool calls made, per file (from ToolPart.diffs). */
function conversationEdits(messages: Message[]): DiffFile[] {
  const byPath = new Map<string, DiffFile>()
  for (const m of messages) {
    if (m.role !== "assistant") continue
    const part = m.parts[0]
    if (part.type !== "tool") continue
    for (const d of (part as ToolPart).diffs ?? []) {
      const rows = lineDiff(d.old_text ?? "", d.new_text)
      const counts = diffCounts(rows)
      const file = byPath.get(d.path) ?? {
        path: d.path,
        status: d.old_text == null ? ("added" as const) : ("modified" as const),
        additions: 0,
        deletions: 0,
        lines: [],
      }
      file.additions += counts.additions
      file.deletions += counts.deletions
      file.lines.push(
        { kind: "hunk", text: `@@ ${part.title}` },
        ...rows.map((r) => ({ kind: r.kind, text: r.text }) as DiffLine)
      )
      byPath.set(d.path, file)
    }
  }
  return [...byPath.values()]
}

function ChangesTab({
  tunnelManager,
  device,
  cwd,
  messages,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  cwd?: string
  messages: Message[]
}) {
  const { t } = useI18n()
  const edits = useMemo(() => conversationEdits(messages), [messages])
  const [git, setGit] = useState<{ repo: boolean; files: DiffFile[]; truncated?: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!tunnelManager || !device || !cwd || device.presence !== "online") return
    setLoading(true)
    setError(null)
    try {
      const res = await tunnelManager.gitDiff(device, cwd)
      setGit({ repo: res.is_repo, files: parseUnifiedDiff(res.diff ?? ""), truncated: res.truncated })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [cwd, device, tunnelManager])

  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [load])

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      {edits.length > 0 && (
        <section className="space-y-2">
          <p className="px-1 text-xs font-medium text-muted-foreground">{t("panel.conversationEdits")}</p>
          <ul className="space-y-1.5">
            {edits.map((f) => (
              <FileRow key={f.path} file={f} />
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <p className="flex-1 text-xs font-medium text-muted-foreground">
            {git?.files.length ? t("panel.filesChanged", { count: git.files.length }) : t("panel.workingTree")}
          </p>
          <Button variant="ghost" size="icon-xs" aria-label={t("panel.loadDiff")} onClick={() => void load()}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
        {error && <p className="px-1 text-xs text-destructive">{error}</p>}
        {!git && loading && (
          <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t("common.loading")}
          </p>
        )}
        {git && !git.repo && <p className="px-1 text-xs text-muted-foreground">{t("panel.notRepo")}</p>}
        {git?.repo && git.files.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">{t("panel.noChanges")}</p>
        )}
        {git && git.files.length > 0 && (
          <ul className="space-y-1.5">
            {git.files.map((f) => (
              <FileRow key={f.path} file={f} defaultOpen={git.files.length === 1} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── Terminal ──────────────────────────────────────────────────────────────────────────────────────────────────────

const terminalKey = (deviceId: string, sessionId: string) => `aa-v3.conv-terminal.${deviceId}.${sessionId}`

/** One terminal in the conversation's directory: the one opened here before (if it still runs), or a new one. */
function ConversationTerminal({
  tunnelManager,
  device,
  sessionId,
  cwd,
}: {
  tunnelManager: DeviceTunnelManager | null
  device: TunnelDevice | null
  sessionId: string
  cwd?: string
}) {
  const { t } = useI18n()
  const [info, setInfo] = useState<TerminalInfo | null>(null)
  const [created, setCreated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label] = useState(() => (typeof navigator === "undefined" ? "Web" : clientLabel(navigator.userAgent)))
  const transport = useMemo(
    () => (tunnelManager && device ? createMeshTerminalTransport(tunnelManager, device) : null),
    [device, tunnelManager]
  )

  // Re-attach the terminal this conversation used before, if it is still there.
  useEffect(() => {
    if (!tunnelManager || !device || device.presence !== "online") return
    let alive = true
    const saved = window.sessionStorage.getItem(terminalKey(device.id, sessionId))
    if (!saved) return
    void tunnelManager
      .listTerminals(device)
      .then((res) => {
        const found = res.terminals.find((x) => x.id === saved && x.running)
        if (alive && found) setInfo(found)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [device, sessionId, tunnelManager])

  const create = async () => {
    if (!tunnelManager || !device) return
    setBusy(true)
    setError(null)
    try {
      const term = await tunnelManager.createTerminal(device, cwd ? { cwd } : undefined)
      window.sessionStorage.setItem(terminalKey(device.id, sessionId), term.id)
      setCreated(true)
      setInfo(term)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!device || device.presence !== "online") {
    return <p className="p-4 text-sm text-muted-foreground">{t("panel.offline")}</p>
  }
  if (!info || !transport) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <SquareTerminalIcon className="size-7 stroke-[1.5] text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("panel.terminalHint")}</p>
        <Button size="sm" disabled={busy} onClick={() => void create()}>
          {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
          {t("devices.createTerminal")}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }
  return (
    <TerminalView
      key={info.id}
      info={info}
      transport={transport}
      initialMode={created ? "control" : "view"}
      label={label}
      className="min-h-0 flex-1 [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
    />
  )
}

// ── Plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function PlanTab({ messages, control }: { messages: Message[]; control: Control | null }) {
  const { t } = useI18n()
  const plan = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && m.parts[0].type === "plan") return m.parts[0] as PlanPart
    }
    return null
  }, [messages])
  const background = control?.background ?? []
  const done = plan?.entries.filter((e) => e.status === "completed").length ?? 0
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      {plan ? (
        <section className="space-y-2">
          <p className="px-1 text-xs font-medium text-muted-foreground tabular-nums">
            {t("panel.planProgress", { done, total: plan.entries.length })}
          </p>
          <ul className="space-y-1 rounded-2xl bg-card p-2">
            {plan.entries.map((e, i) => (
              <li key={i} className="flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-sm">
                {e.status === "completed" ? (
                  <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                ) : e.status === "in_progress" ? (
                  <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-foreground" />
                ) : (
                  <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "min-w-0 leading-relaxed",
                    e.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40"
                  )}
                >
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="px-1 pt-2 text-xs text-muted-foreground">{t("panel.noPlan")}</p>
      )}
      {background.length > 0 && (
        <section className="space-y-2">
          <p className="px-1 text-xs font-medium text-muted-foreground">{t("panel.background")}</p>
          <ul className="space-y-1.5">
            {background.map((b) => (
              <li key={b.id} className="space-y-1 rounded-2xl bg-card px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  {b.status === "running" ? (
                    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <CircleCheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">{b.title}</span>
                  {b.exit_code != null && (
                    <span className="text-xs tabular-nums text-muted-foreground">exit {b.exit_code}</span>
                  )}
                </div>
                {b.output_tail && (
                  <pre className="max-h-32 overflow-auto rounded-xl bg-background p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                    {b.output_tail}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
