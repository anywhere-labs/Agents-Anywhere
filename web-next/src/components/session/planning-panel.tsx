"use client"

import * as React from 'react'
import { FileText, Download, Copy, RefreshCw, X, Check, Loader2, ListChecks, ChevronDown, PencilLine, Send, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MarkdownText } from '@/components/markdown-text'
import { copyText } from '@/lib/clipboard'
import type { useSessionPlanning, PlanDocument, PlanningState } from '@/features/planning/use-session-planning'
import { cn } from '@/lib/utils'

type Planning = ReturnType<typeof useSessionPlanning>
type ReviewTarget = { document: PlanDocument; review: NonNullable<PlanningState['review']>; epoch: string }

export function getPlanReviewTarget(state: PlanningState | null, canReview: boolean): ReviewTarget | null {
  const review = state?.review, document = state?.proposal
  const retry = review?.status === 'approved' && state?.execution?.status === 'rejected' && state.execution.retryable === true
  if (!canReview || !review || !document || (review.status !== 'open' && !retry)) return null
  if (review.planId !== document.planId || review.planRevision !== document.revision || review.contentHash !== document.contentHash) return null
  if (!state?.capabilities?.actions?.some(action => ['approve_and_execute', 'request_revision', 'dismiss_review'].includes(action) && (review.actions?.includes(action) ?? true))) return null
  return { document, review, epoch: state?.epoch ?? '' }
}

export function usePlanReader(sessionId: string) {
  const [selection, setSelection] = React.useState<{ sessionId: string; document: PlanDocument } | null>(null)
  const positions = React.useRef(new Map<string, number>())
  const trigger = React.useRef<HTMLElement | null>(null)
  const document = selection?.sessionId === sessionId ? selection.document : null
  const open = (document: PlanDocument) => {
    trigger.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
    setSelection({ sessionId, document })
  }
  const close = () => {
    setSelection(null)
    window.requestAnimationFrame(() => trigger.current?.isConnected && trigger.current.focus())
  }
  return { document, open, close, positions, sessionId }
}

function download(document: PlanDocument) {
  const url = URL.createObjectURL(new Blob([document.markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'PLAN.md'; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function PlanningPanel({ planning, canReview = true, onRead }: {
  planning: Planning; canReview?: boolean; onRead: (document: PlanDocument) => void
}) {
  const { state, documents, error } = planning
  const target = getPlanReviewTarget(state, canReview)
  const cards = [
    ...documents.map(document => ({ key: `${document.planId}:${document.revision}`, document, draft: null })),
    ...(state?.draft ? [{ key: `${state.draft.planId}:${state.draft.revision}`, document: null, draft: state.draft }] : []),
  ]
  if (!documents.length && !state?.draft && state?.effectiveMode !== "plan" && !state?.requestedMode && !error) return null
  const uncertain = !!state && (state.effectiveMode === 'unknown' || state.freshness !== 'fresh')
  const mode = state?.requestedMode ? '模式切换待原生确认' : state?.effectiveMode === 'plan' ? '规划模式' : uncertain ? '规划状态待核对' : null
  const execution = state?.execution && (state.execution.status === 'started' ? '计划执行已开始' : state.execution.status === 'accepted' ? '执行请求已接受，等待原生开始' : state.execution.status === 'rejected' ? '计划已同意，执行尚未启动' : '执行结果待核对')
  return <section className="flex flex-col gap-3" aria-label="计划">
    {(mode || execution) && <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground" role="status">
      <ListChecks className="size-3.5" aria-hidden="true" />
      <span>{[mode, execution].filter(Boolean).join(' · ')}</span>
      {(uncertain || error) && !target && <RefreshButton planning={planning} />}
    </div>}
    {state?.executionProgress && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">执行步骤进度</summary><ul className="mt-1 list-inside list-disc">{((state.executionProgress.steps ?? []) as { step: string; status: string }[]).map((step, index) => <li key={index}>{step.step} · {step.status}</li>)}</ul></details>}
    {cards.map(({ key, document, draft }) => <PlanCard key={key} document={document} draft={draft} onRead={onRead} />)}
    {error && !target && <p className="text-xs text-destructive" role="alert">{error}</p>}
  </section>
}

export function PlanningReviewPanel({ planning, target }: { planning: Planning; target: ReviewTarget }) {
  // New native identity/version remounts the form; ordinary projection updates preserve the draft.
  return <PlanReviewForm key={`${planning.state?.sessionId}:${target.epoch}:${target.review.reviewId}:${target.document.planId}:${target.document.revision}:${target.document.contentHash}`} planning={planning} target={target} />
}

type ReviewCommand = 'approve_and_execute' | 'request_revision' | 'dismiss_review'

function PlanReviewForm({ planning, target }: { planning: Planning; target: ReviewTarget }) {
  const [feedback, setFeedback] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [pending, setPending] = React.useState<ReviewCommand | null>(null)
  const id = React.useId()
  const { state, busy, error, execute } = planning
  const open = target.review.status === 'open'
  const allowed = (command: ReviewCommand) =>
    state?.freshness === 'fresh' && !!target.epoch && state.capabilities?.actions?.includes(command) &&
    (target.review.actions?.includes(command) ?? true)
  const respond = async (command: ReviewCommand) => {
    if (busy || !allowed(command) || (command === 'request_revision' && !feedback.trim())) return
    setPending(command)
    const ok = await execute({ command, reviewId: target.review.reviewId, planId: target.review.planId, planRevision: target.review.planRevision, contentHash: target.review.contentHash, epoch: target.epoch, feedback: command === 'request_revision' ? feedback.trim() : undefined })
    setPending(null)
    if (ok && command === 'request_revision') { setEditing(false); setFeedback('') }
  }
  const spinner = (command: ReviewCommand) => busy && pending === command ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null
  const actions = !open
    ? <Button size="sm" disabled={busy || !allowed('approve_and_execute')} onClick={() => void respond('approve_and_execute')}>{spinner('approve_and_execute') ?? <RotateCcw data-icon="inline-start" />}重试启动</Button>
    : editing
      ? <>
        <Button size="sm" disabled={busy || !allowed('request_revision') || !feedback.trim()} onClick={() => void respond('request_revision')}>{spinner('request_revision') ?? <Send data-icon="inline-start" />}提交修改意见</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>取消</Button>
      </>
      : <>
        <Button size="sm" disabled={busy || !allowed('approve_and_execute')} onClick={() => void respond('approve_and_execute')}>{spinner('approve_and_execute') ?? <Check data-icon="inline-start" />}同意并执行</Button>
        <Button size="sm" variant="outline" disabled={busy || !allowed('request_revision')} onClick={() => setEditing(true)}><PencilLine data-icon="inline-start" />修改计划</Button>
        <Button size="sm" variant="ghost" disabled={busy || !allowed('dismiss_review')} onClick={() => void respond('dismiss_review')}>{spinner('dismiss_review')}暂不执行</Button>
      </>
  return <section aria-labelledby={`${id}-title`} className="shrink-0 px-4 pb-4 pt-2">
    <div className="mx-auto flex max-h-[40dvh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-3 shadow-lg">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 gap-2">
          <ListChecks className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="wrap-break-word text-sm font-medium">{open ? '是否执行这个计划？' : '计划已同意，执行尚未启动'}</h2>
            <p className="text-xs text-muted-foreground">版本 {target.document.revision}</p>
          </div>
        </div>
        {!editing && <div className="flex flex-wrap gap-2 md:flex-nowrap md:justify-end">{actions}</div>}
      </div>
      {state?.freshness !== 'fresh' && <div className="flex items-center gap-1.5 pl-6 text-xs text-muted-foreground"><TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /><span>原生状态待核对，请刷新后再确认。</span><RefreshButton planning={planning} /></div>}
      {error && <p className="pl-6 text-xs text-destructive" role="alert">{error}</p>}
      {editing && <div className="flex flex-col gap-2">
        <Textarea id={`${id}-feedback`} aria-label="修改意见" rows={3} autoFocus value={feedback} disabled={busy}
          onChange={event => setFeedback(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void respond('request_revision') }
          }}
          placeholder="说明需要如何调整计划" />
        <div className="flex flex-wrap justify-end gap-2">{actions}</div>
      </div>}
    </div>
  </section>
}

export function PlanningReader({ reader, className }: { reader: ReturnType<typeof usePlanReader>; className?: string }) {
  const viewport = React.useRef<HTMLDivElement>(null)
  const title = React.useRef<HTMLHeadingElement>(null)
  const id = React.useId()
  const document = reader.document
  const key = document ? `${reader.sessionId}:${document.planId}:${document.revision}` : null
  React.useEffect(() => {
    if (key && viewport.current) {
      viewport.current.scrollTop = reader.positions.current.get(key) ?? 0
      title.current?.focus({ preventScroll: true })
    }
  }, [key, reader.positions])
  if (!document) return null
  return <aside aria-labelledby={id} className={cn("flex h-full min-h-0 w-full shrink-0 flex-col border-l bg-background @min-[48rem]/plan-layout:w-[45%]", className)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); reader.close() } }}>
    <header className="flex items-start justify-between gap-3 border-b p-4">
      <div className="flex min-w-0 flex-col gap-1"><h2 ref={title} tabIndex={-1} id={id} className="rounded-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">{document.title}</h2><p className="text-sm text-muted-foreground">计划 · 版本 {document.revision}</p></div>
      <Button variant="ghost" size="icon" onClick={reader.close} aria-label="关闭计划"><X /></Button>
    </header>
    <div ref={viewport} tabIndex={0} role="region" aria-label="计划正文" className="min-h-0 flex-1 overflow-y-auto p-5 focus-visible:outline-2 focus-visible:outline-ring" onScroll={event => { if (key) reader.positions.current.set(key, event.currentTarget.scrollTop) }}><MarkdownText text={document.markdown} /></div>
    <footer className="flex flex-wrap gap-2 border-t p-4"><Button variant="outline" onClick={() => void copyText(document.markdown)}><Copy data-icon="inline-start" />复制</Button><Button variant="outline" onClick={() => download(document)}><Download data-icon="inline-start" />下载 Markdown</Button></footer>
  </aside>
}

function RefreshButton({ planning }: { planning: Planning }) {
  return <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void planning.refresh().catch(() => undefined)} aria-label="刷新规划状态"><RefreshCw data-icon="inline-start" />刷新</Button>
}

const PLAN_PREVIEW_HEIGHT = 288

// The card header already shows the title; drop a leading Markdown line that repeats it.
function planBody(document: PlanDocument) {
  const markdown = document.markdown.replace(/^\s*\n/, '')
  const [first = '', ...rest] = markdown.split('\n')
  const heading = first.replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim()
  return heading && heading === document.title.trim() ? rest.join('\n').replace(/^\s*\n/, '') : markdown
}

function PlanCard({ document, draft, onRead }: {
  document: PlanDocument | null; draft: PlanningState['draft'] | null; onRead: (document: PlanDocument) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [foreground, setForeground] = React.useState(true)
  const [expanded, setExpanded] = React.useState(false)
  const [collapsible, setCollapsible] = React.useState(false)
  const writing = draft?.contentState === 'drafting'
  const text = draft?.content ?? (document ? planBody(document) : '')
  React.useEffect(() => {
    const node = ref.current
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false))
    if (node) observer.observe(node)
    const changed = () => setForeground(!window.document.hidden)
    changed(); window.document.addEventListener('visibilitychange', changed)
    return () => { observer.disconnect(); window.document.removeEventListener('visibilitychange', changed) }
  }, [])
  React.useEffect(() => {
    const node = content.current
    if (!node || draft) return
    const measure = () => setCollapsible(node.scrollHeight > PLAN_PREVIEW_HEIGHT + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [draft, text])
  const clamped = collapsible && !expanded
  return <div ref={ref} aria-busy={writing} className={cn('flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm', (!writing || !visible || !foreground) && 'plan-writing-paused')}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 gap-2">
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <div className="wrap-break-word text-sm font-medium"><span className={cn(writing && 'plan-writing-title')}>{draft ? writing ? '正在撰写计划' : '计划草稿已中断' : document!.title}</span></div>
          <div className="text-xs text-muted-foreground">{draft ? '正文随原生计划输出更新' : `计划 · 版本 ${document!.revision}`}</div>
        </div>
      </div>
      {document && <Button variant="outline" size="sm" onClick={() => onRead(document)}>打开计划</Button>}
    </div>
    <div className="relative pl-6">
      <div ref={content} className="min-w-0 overflow-hidden" style={clamped ? { maxHeight: PLAN_PREVIEW_HEIGHT } : undefined}><MarkdownText text={text} /></div>
      {clamped && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />}
    </div>
    {collapsible && <Button variant="ghost" size="xs" className="ml-4 self-start text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} data-icon="inline-start" />{expanded ? '收起' : '展开全文'}
    </Button>}
  </div>
}
