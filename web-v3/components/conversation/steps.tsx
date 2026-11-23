"use client"

// One agent step per item, on AI Elements' Trace (https://ui.shadcn.com/docs/ai-elements/base/tool and its siblings
// Reasoning, Terminal, Plan, Subagent): a muted line ("运行了 …", "查看了 file#L70-95", "修改了 file +9 −4") that opens in
// place to the detail. The rules are the patterns' own: a line runs (shimmer) while its item streams; a terminal opens
// once output arrives and a reasoning while it is written; whatever the reader opens or closes by hand wins.
import { memo, useEffect, useMemo, useState } from 'react'
import type * as React from 'react'
import {
  BotIcon,
  BrainIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  FileIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MoveIcon,
  RouteIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react'
import type { AssistantMessage, PendingRequest, PlanPart, SubagentPart, ThinkingPart, ToolPart } from '@/lib/types/v3'
import { Badge } from '@/components/ui/badge'
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { cn } from '@/lib/utils'
import { diffCounts, lineDiff } from './diff'
import { useThreadEnv } from './env'
import { threadMemory } from './virtual'
import { Markdown } from './markdown'
import { Answered, Confirmation } from './confirmation'
import { basename, duration, commandOf, cwdOf, exitCodeOf, fileOf, languageOf, outputText, queryOf, rangeOf, startLineOf } from './text'
import type { Step } from './turns'

/** The stock open-state rule: `auto` until the reader toggles it; a tap is a light haptic on mobile. */
function useOpen(auto: boolean) {
  const env = useThreadEnv()
  const [open, setOpen] = useState<boolean>()
  return {
    open: open ?? auto,
    onOpenChange: (v: boolean) => {
      env.haptic?.('light')
      setOpen(v)
    },
  }
}

export interface StepContext {
  /** The permission request waiting on a tool step, and the ones already answered for it. */
  requestsFor: (part: ToolPart, messageId: string) => { pending?: PendingRequest; answered: AnsweredRequest[] }
  /** A subagent's own steps. */
  subagentSteps: Map<string, AssistantMessage[]>
}

export interface AnsweredRequest {
  request: PendingRequest
  by: string
  device?: string
  option_id: string
}

/**
 * One step. A tool step carries its permission request: the Confirmation (inline) right under it, or the "等待你确认"
 * marker (native dock), and "已由 X 在 Y 上处理" once answered.
 */
export const StepRow = memo(function StepRow({ step, ctx }: { step: Step; ctx: StepContext }) {
  const env = useThreadEnv()
  const part = step.parts[0]
  switch (part.type) {
    case 'thinking':
      return <ReasoningStep message={step} part={part} />
    case 'subagent':
      return <SubagentStep part={part} ctx={ctx} />
    case 'plan':
      return <PlanStep message={step} part={part} />
    case 'tool': {
      const { pending, answered } = ctx.requestsFor(part, step.id)
      return (
        <>
          <ToolStep message={step} part={part} request={pending} />
          {pending && env.approvals === 'inline' && <Confirmation request={pending} tool={part} />}
          {answered.map((a) => (
            <Answered key={a.request.request_id} request={a.request} by={a.by} device={a.device} option_id={a.option_id} />
          ))}
        </>
      )
    }
  }
})

// ── Step group (Effi Cloud's StepGroup) ───────────────────────────────────────────────────────────────────────────

const KIND_DONE: Record<string, [string, string]> = {
  read: ['查看了', '个文件'],
  edit: ['修改了', '处'],
  delete: ['删除了', '个文件'],
  move: ['移动了', '个文件'],
  search: ['搜索了', '次'],
  execute: ['运行了', '条命令'],
  fetch: ['访问了', '次'],
}

/** Finished steps in a few words: 运行了 2 条命令，查看了 1 个文件. What did not run (failed) is not counted as done. */
export function stepsSummary(tools: ToolPart[], thought: boolean, subagents = 0): string {
  const counts = new Map<string, number>()
  let skipped = 0
  for (const t of tools) {
    if (t.status === 'failed') {
      skipped++
      continue
    }
    const k = t.kind !== 'think' && KIND_DONE[t.kind] ? t.kind : 'other'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const phrases = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => (k === 'other' ? `操作了 ${n} 次` : `${KIND_DONE[k][0]} ${n} ${KIND_DONE[k][1]}`))
  if (subagents) phrases.unshift(`用了 ${subagents} 个子代理`)
  if (skipped) phrases.push(`${skipped} 步没有执行`)
  if (!phrases.length) return thought ? '想了一下' : '完成'
  return phrases.length > 3 ? `${phrases.slice(0, 3).join('，')}…` : phrases.join('，')
}

/** "想了 3 次，运行了 2 条命令，查看了 4 个文件": a stretch of steps in one line. */
export function runSummary(steps: Step[]): string {
  const parts = steps.map((s) => s.parts[0])
  const thoughts = parts.filter((p) => p.type === 'thinking').length
  const tools = parts.filter((p): p is ToolPart => p.type === 'tool')
  const subagents = parts.filter((p) => p.type === 'subagent').length
  const rest = tools.length || subagents ? stepsSummary(tools, false, subagents) : ''
  return [thoughts > 0 && `想了 ${thoughts} 次`, rest].filter(Boolean).join('，') || '完成'
}

function toolCount(steps: Step[]): number {
  return steps.reduce((n, s) => {
    const p = s.parts[0]
    return n + (p.type === 'tool' ? 1 : p.type === 'subagent' ? p.tool_count : 0)
  }, 0)
}

/** "1 分 12 秒 · 7 个工具 · 2 个子代理". */
function statsText(ms: number | undefined, tools: number, subagents: number): string {
  return [ms !== undefined && duration(ms), tools > 0 && `${tools} 个工具`, subagents > 0 && `${subagents} 个子代理`].filter(Boolean).join(' · ')
}

function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  return now
}

/**
 * The steps between two things the agent says, under one line, as Effi Cloud draws them: "运行中 · 12 秒 · 3 个工具"
 * (open, shimmering) while they run, "用时 1 分 40 秒 · 想了 2 次，运行了 3 条命令" (folded) once done; opened, a finished
 * group's line says 收起. One finished step needs no group line: its own line says it. A step waiting for an answer
 * keeps the group open; a subagent still running stays in view outside the fold. Flush with the column: no rule, no
 * indent, here or in anything a step opens.
 *
 * `turnMs`: for the turn's last group, how long the turn took.
 */
export const StepGroup = memo(StepGroupImpl, (a, b) => a.live === b.live && a.turnMs === b.turnMs && a.ctx === b.ctx && a.steps.length === b.steps.length && a.steps.every((s, i) => s === b.steps[i]))

function StepGroupImpl({ steps, live, turnMs, ctx }: { steps: Step[]; live: boolean; turnMs?: number; ctx: StepContext }) {
  const env = useThreadEnv()
  // Opened or folded by hand: remembered past the turn being let go off screen (virtual.tsx).
  const [open, setOpenState] = useState<boolean | undefined>(() => threadMemory.opened.get(steps[0].id))
  const setOpen = (v: boolean) => {
    threadMemory.opened.set(steps[0].id, v)
    setOpenState(v)
  }
  const asking = steps.some((s) => s.parts[0].type === 'tool' && ctx.requestsFor(s.parts[0], s.id).pending)
  const shown = asking || (open ?? live)
  const now = useNow(live)
  if (!live && steps.length === 1) return <StepRow step={steps[0]} ctx={ctx} />
  const subagents = steps.filter((s) => s.parts[0].type === 'subagent').length
  const started = new Date(steps[0].created_at).getTime()
  const header = live
    ? ['运行中', statsText(Number.isFinite(started) ? Math.max(0, now - started) : undefined, toolCount(steps), subagents)].filter(Boolean).join(' · ')
    : turnMs !== undefined
      ? `用时 ${duration(turnMs)} · ${runSummary(steps)}`
      : runSummary(steps)
  return (
    <>
      <TraceCollapsible
        // Folding by itself (the steps finished) is instant; only the reader's own taps animate. A fold animating
        // while the reply's text starts below it reads as the steps showing twice, and WKWebView can leave a panel
        // mid-way when the transition is cut short.
        data-instant={open === undefined || undefined}
        open={shown}
        onOpenChange={(v) => {
          env.haptic?.('light')
          setOpen(v)
        }}
      >
        <TraceCollapsibleTrigger>
          <TraceLine status={live ? 'running' : undefined}>
            <TraceTitle>{!live && shown ? '收起' : header}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className={cn(FLUSH, 'flex flex-col gap-2')}>
          {steps.map((s) => (
            <StepRow key={s.id} step={s} ctx={ctx} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {!shown && steps.map((s) => (s.parts[0].type === 'subagent' && s.parts[0].status === 'running' ? <StepRow key={s.id} step={s} ctx={ctx} /> : null))}
    </>
  )
}

/** Trace's collapsible content is inset behind a rule; Effi Cloud's steps open flush with the column. */
const FLUSH = 'ml-0 border-l-0 pl-0 pr-0'

// ── Reasoning ──────────────────────────────────────────────────────────────────────────────────────────────────────

function ReasoningStep({ message, part }: { message: AssistantMessage; part: ThinkingPart }) {
  const running = !message.done
  const state = useOpen(running)
  const line = (
    <TraceLine status={running ? 'running' : undefined}>
      <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <BrainIcon />}</TraceIcon>
      <TraceTitle>{running ? '正在思考' : '想了一下'}</TraceTitle>
    </TraceLine>
  )
  // Nothing to open before the model has written anything.
  if (!part.text) return line
  return (
    <TraceCollapsible {...state}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      {/* AI Elements › Reasoning keeps Streamdown for the text. */}
      <TraceCollapsibleContent className={FLUSH}>
        <Markdown streaming={running} size="compact" className="text-muted-foreground">
          {part.text}
        </Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

// ── Tool ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const KIND_ICON: Record<string, React.ReactNode> = {
  execute: <TerminalIcon />,
  read: <FileTextIcon />,
  search: <SearchIcon />,
  delete: <Trash2Icon />,
  move: <MoveIcon />,
  fetch: <GlobeIcon />,
  think: <BrainIcon />,
}

/** The line's words: what the call did (or is doing), in Effi Cloud's wording. */
function toolWords(part: ToolPart, phase: 'running' | 'done' | 'failed' | 'waiting' | 'unfinished') {
  const file = fileOf(part)
  const v = (done: string, running: string, waiting: string, failed: string) =>
    ({ done, running, waiting, failed, unfinished: `没有${done.replace(/了$/, '')}完` })[phase]
  switch (part.kind) {
    case 'execute': {
      const cmd = commandOf(part) ?? part.title
      const code = exitCodeOf(part.output)
      if (phase === 'failed' && code !== undefined) return { verb: '', subject: `${cmd} 以退出码 ${code} 结束`, mono: true }
      return { verb: v('运行了', '正在运行', '请求运行', '运行失败'), subject: cmd, mono: true }
    }
    case 'read':
      return { verb: v('查看了', '正在查看', '请求查看', '没能查看'), subject: file ? `${basename(file)}${rangeOf(part)}` : part.title, mono: !!file }
    case 'edit': {
      const created = !!part.diffs?.length && part.diffs.every((d) => !d.old_text)
      const subject = file ? basename(file) + ((part.diffs?.length ?? 0) > 1 ? ` 等 ${part.diffs!.length} 个文件` : '') : part.title
      return created
        ? { verb: v('新建了', '正在新建', '请求新建', '没能新建'), subject, mono: !!file }
        : { verb: v('修改了', '正在修改', '请求修改', '没能修改'), subject, mono: !!file }
    }
    case 'delete':
      return { verb: v('删除了', '正在删除', '请求删除', '没能删除'), subject: file ? basename(file) : part.title, mono: !!file }
    case 'move':
      return { verb: v('移动了', '正在移动', '请求移动', '没能移动'), subject: file ? basename(file) : part.title, mono: !!file }
    case 'search':
      return { verb: v('搜索了', '正在搜索', '请求搜索', '搜索失败'), subject: queryOf(part), mono: true }
    case 'fetch':
      return { verb: v('访问了', '正在访问', '请求访问', '没能访问'), subject: queryOf(part), mono: false }
    default:
      return { verb: '', subject: part.title, mono: false }
  }
}

function ToolStep({ message, part, request }: { message: AssistantMessage; part: ToolPart; request?: PendingRequest }) {
  const env = useThreadEnv()
  const live = !message.done
  const waiting = !!request
  const unfinished = part.status === 'pending' || part.status === 'in_progress'
  const phase = waiting ? 'waiting' : part.status === 'failed' ? 'failed' : unfinished ? (live ? 'running' : 'unfinished') : 'done'
  const output = outputText(part.output)
  const diffs = part.diffs ?? []
  const counts = diffs.reduce(
    (s, d) => {
      const c = diffCounts(lineDiff(d.old_text ?? '', d.new_text))
      return { additions: s.additions + c.additions, deletions: s.deletions + c.deletions }
    },
    { additions: 0, deletions: 0 },
  )
  const words = toolWords(part, phase)
  const hasDetail = !!(output || diffs.length || part.locations?.length || (part.kind === 'execute' && commandOf(part)))
  // Terminal pattern: open once output arrives while it runs.
  const state = useOpen(phase === 'running' && part.kind === 'execute' && output.length > 0)
  const status = phase === 'running' ? 'running' : phase === 'failed' || phase === 'unfinished' ? 'error' : phase === 'waiting' ? 'pending' : undefined

  const line = (
    <TraceLine status={status}>
      <TraceIcon>{KIND_ICON[part.kind] ?? (part.kind === 'edit' ? diffs.every((d) => !d.old_text) && diffs.length ? <FilePlusIcon /> : <FilePenLineIcon /> : <WrenchIcon />)}</TraceIcon>
      <TraceTitle>
        {words.verb && <>{words.verb} </>}
        <span className={cn(words.mono && 'font-mono text-[0.92em]')}>{words.subject}</span>
      </TraceTitle>
      {diffs.length > 0 && phase === 'done' && (
        <TraceDescription>
          <span className="text-emerald-600 dark:text-emerald-400">+{counts.additions}</span> <span className="text-destructive">−{counts.deletions}</span>
        </TraceDescription>
      )}
    </TraceLine>
  )
  const marker = waiting && env.approvals === 'host' && (
    <Badge variant="outline" className="ml-6 w-fit text-amber-700 dark:text-amber-400">
      等待你确认
    </Badge>
  )
  if (!hasDetail)
    return (
      <>
        {line}
        {marker}
      </>
    )
  return (
    <>
      <TraceCollapsible {...state}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent className={cn(FLUSH, 'flex flex-col gap-2')}>
          <ToolDetail part={part} output={output} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {marker}
    </>
  )
}

function ToolDetail({ part, output }: { part: ToolPart; output: string }) {
  const env = useThreadEnv()
  const diffs = part.diffs ?? []
  const command = part.kind === 'execute' ? commandOf(part) : undefined
  const shown = new Set(diffs.map((d) => d.path))
  const locations = (part.locations ?? []).filter((l) => !shown.has(l.path))
  const tail = useLines(output, 'tail')
  return (
    <>
      {locations.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
          {locations.map((l, i) => (
            <button
              key={i}
              type="button"
              className="flex min-w-0 items-center gap-1 text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
              onClick={() => {
                env.haptic?.('light')
                env.open({ kind: 'file', path: l.path, line: l.line })
              }}
            >
              <FileIcon className="size-3 shrink-0" />
              <span className="truncate">
                {l.path}
                {l.line ? `:${l.line}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {command && (
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle className="font-mono font-normal text-muted-foreground">{cwdOf(part) ?? '终端'}</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={command} aria-label="复制命令" onClick={() => env.copy(command)} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-64">
            <CodeBlockLine>
              <span className="text-muted-foreground select-none">$ </span>
              {command}
              {tail.text ? `\n${tail.text}` : ''}
            </CodeBlockLine>
          </CodeBlockContent>
          {tail.hidden > 0 && <MoreLines hidden={tail.hidden} where="前面" onMore={tail.more} />}
        </CodeBlock>
      )}
      {diffs.map((d, i) => (
        <DiffBlock key={i} path={d.path} oldText={d.old_text ?? ''} newText={d.new_text} />
      ))}
      {!command && output && !diffs.length && (part.kind === 'read' ? <FileExcerpt part={part} text={output} /> : <OutputBlock text={output} />)}
    </>
  )
}

// Long output is drawn in part: the last (terminal) or first (file, diff) PREVIEW lines, all of it up to FULL lines on
// request. A 2000-line terminal or a 1000-line read is tens of thousands of nodes (or one huge text node to lay out on
// every push) otherwise; nobody reads that inside a chat bubble.
const PREVIEW = 200
const FULL = 2000

function useLines(text: string, keep: 'head' | 'tail') {
  const [limit, setLimit] = useState(PREVIEW)
  return useMemo(() => {
    const trimmed = text.replace(/\n$/, '')
    if (!trimmed) return { text: '', hidden: 0, more: undefined }
    const lines = trimmed.split('\n')
    const shown = keep === 'tail' ? lines.slice(-limit) : lines.slice(0, limit)
    return { text: shown.join('\n'), hidden: lines.length - shown.length, more: limit < FULL ? () => setLimit(FULL) : undefined }
  }, [text, keep, limit])
}

function MoreLines({ hidden, where, onMore }: { hidden: number; where: '前面' | '后面'; onMore?: () => void }) {
  const all = hidden + PREVIEW <= FULL
  return (
    <div className="flex items-center gap-2 px-2.5 pb-2 text-xs text-muted-foreground">
      <span>
        {where} {hidden} 行没有显示
      </span>
      {onMore && (
        <button type="button" className="font-medium text-foreground underline-offset-3 hover:underline" onClick={onMore}>
          {all ? '显示全部' : `显示${where === '前面' ? '最后' : '前'} ${FULL} 行`}
        </button>
      )}
    </div>
  )
}

function OutputBlock({ text }: { text: string }) {
  const tail = useLines(text, 'tail')
  return (
    <CodeBlock size="sm">
      <CodeBlockContent wrap className="max-h-64">
        {tail.text}
      </CodeBlockContent>
      {tail.hidden > 0 && <MoreLines hidden={tail.hidden} where="前面" onMore={tail.more} />}
    </CodeBlock>
  )
}

/** What a read returned, highlighted and numbered from where it started (Code Block › Start Line). */
function FileExcerpt({ part, text }: { part: ToolPart; text: string }) {
  const env = useThreadEnv()
  const path = fileOf(part) ?? ''
  const head = useLines(text, 'head')
  const lines = useHighlightedCode(head.text, languageOf(path) || 'text')
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono font-normal">
          <button type="button" className="truncate hover:underline" onClick={() => env.open({ kind: 'file', path, line: startLineOf(part) })}>
            {path}
          </button>
        </CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers startLine={startLineOf(part) ?? 1} className="max-h-64">
        {lines.map((l, i) => (
          <CodeBlockLine key={i}>{l}</CodeBlockLine>
        ))}
      </CodeBlockContent>
      {head.hidden > 0 && <MoreLines hidden={head.hidden} where="后面" onMore={head.more} />}
    </CodeBlock>
  )
}

/** ACP diffs carry both sides; Code Block › Diff draws the line diff with its added / removed variants. */
function DiffBlock({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const env = useThreadEnv()
  const rows = lineDiff(oldText, newText)
  const { additions, deletions } = diffCounts(rows)
  const [limit, setLimit] = useState(PREVIEW)
  const shownRows = rows.length > limit ? rows.slice(0, limit) : rows
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono font-normal">
          <button type="button" className="truncate hover:underline" onClick={() => env.open({ kind: 'file', path })}>
            {path}
          </button>
        </CodeBlockTitle>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> <span className="text-destructive">−{deletions}</span>
        </span>
        <CodeBlockActions>
          <CodeBlockCopyButton value={newText} aria-label="复制新内容" onClick={() => env.copy(newText)} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent className="max-h-72">
        {shownRows.map((r, i) => (
          <CodeBlockLine key={i} variant={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : 'default'}>
            {r.text}
          </CodeBlockLine>
        ))}
      </CodeBlockContent>
      {rows.length > shownRows.length && <MoreLines hidden={rows.length - shownRows.length} where="后面" onMore={limit < FULL ? () => setLimit(FULL) : undefined} />}
    </CodeBlock>
  )
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function PlanStep({ message, part }: { message: AssistantMessage; part: PlanPart }) {
  const done = part.entries.filter((e) => e.status === 'completed').length
  const running = !message.done && part.entries.some((e) => e.status === 'in_progress')
  const state = useOpen(true)
  return (
    <TraceCollapsible {...state}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? 'running' : undefined}>
          <TraceIcon>
            <RouteIcon />
          </TraceIcon>
          <TraceTitle>计划</TraceTitle>
          <TraceDescription>
            {done} / {part.entries.length} 已完成
          </TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className={FLUSH}>
        <Trace>
          {part.entries.map((e, i) => (
            <TraceLine key={i} status={e.status === 'in_progress' && !message.done ? 'running' : e.status === 'pending' ? 'pending' : undefined}>
              <TraceIcon>{e.status === 'completed' ? <CircleCheckIcon /> : e.status === 'in_progress' ? <CircleDotIcon /> : <CircleIcon />}</TraceIcon>
              <TraceTitle className={cn(e.status === 'completed' && 'text-foreground/70')}>{e.content}</TraceTitle>
            </TraceLine>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

// ── Subagent ───────────────────────────────────────────────────────────────────────────────────────────────────────

function SubagentStep({ part, ctx }: { part: SubagentPart; ctx: StepContext }) {
  const running = part.status === 'running'
  const failed = part.status === 'failed'
  const steps = (ctx.subagentSteps.get(part.id) ?? []).filter((m): m is Step => m.parts[0].type !== 'text' && m.parts[0].type !== 'compaction')
  const words = (ctx.subagentSteps.get(part.id) ?? []).filter((m) => m.parts[0].type === 'text')
  const state = useOpen(false)
  const who = part.agent_type ?? '子 Agent'
  const what = part.description || part.title
  return (
    <TraceCollapsible {...state}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? 'running' : failed ? 'error' : undefined}>
          <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <BotIcon />}</TraceIcon>
          <TraceTitle>
            {running ? '正在运行' : failed ? '没能完成' : part.status === 'cancelled' ? '取消了' : '运行了'} {who}：{what}
          </TraceTitle>
          <TraceDescription>{part.tool_count} 次调用</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted className={cn(FLUSH, 'flex flex-col gap-3')}>
        {steps.length > 0 && (
          <Trace>
            {steps.map((s) => (
              <StepRow key={s.id} step={s} ctx={ctx} />
            ))}
          </Trace>
        )}
        {words.map((m) => (
          <Markdown key={m.id} size="compact" className="text-muted-foreground">
            {m.parts[0].type === 'text' ? m.parts[0].text : ''}
          </Markdown>
        ))}
        {part.result && <Markdown size="compact" className="text-muted-foreground">{part.result}</Markdown>}
        {part.error && <p className="text-destructive">{part.error}</p>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}
