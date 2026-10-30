"use client"

import * as React from 'react'
import { FileText, Download, Copy, RefreshCw, X, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
  return <section className="flex flex-col gap-3" aria-label="计划">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{state?.effectiveMode === 'plan' ? '规划模式' : state?.effectiveMode === 'normal' ? '执行模式' : '规划状态待核对'}</Badge>
      {state?.requestedMode && <span className="text-sm text-muted-foreground">模式切换待原生确认</span>}
      <Button size="sm" variant="ghost" onClick={() => void planning.refresh().catch(() => undefined)} aria-label="刷新规划状态"><RefreshCw data-icon="inline-start" />刷新</Button>
    </div>
    {state?.execution && <p className="text-sm text-muted-foreground" role="status">{state.execution.status === 'started' ? '计划执行已开始' : state.execution.status === 'accepted' ? '执行请求已接受，等待原生开始' : state.execution.status === 'rejected' ? '计划已同意，执行尚未启动' : '执行结果待核对'}</p>}
    {state?.executionProgress && <details><summary className="cursor-pointer text-sm">执行步骤进度</summary><ul className="list-inside list-disc text-sm">{((state.executionProgress.steps ?? []) as { step: string; status: string }[]).map((step, index) => <li key={index}>{step.step} · {step.status}</li>)}</ul></details>}
    {cards.map(({ key, document, draft }) => <PlanCard key={key} writing={draft?.contentState === 'drafting'}>
      <CardHeader><CardTitle className="flex items-center gap-2"><FileText aria-hidden="true" /><span className={cn(draft?.contentState === 'drafting' && 'plan-writing-title')}>{draft ? draft.contentState === 'drafting' ? '正在撰写计划' : '计划草稿已中断' : document!.title}</span></CardTitle><CardDescription>{draft ? '正文随原生计划输出更新' : `计划 · 版本 ${document!.revision}`}</CardDescription></CardHeader>
      <CardContent><div className={cn(!draft && 'max-h-72 overflow-hidden')}><MarkdownText text={draft?.content ?? document!.markdown} /></div></CardContent>
      {document && <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onRead(document)}>打开计划</Button>
        <Button variant="ghost" size="sm" onClick={() => download(document)}><Download data-icon="inline-start" />下载</Button>
      </CardFooter>}
    </PlanCard>)}
    {error && !target && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

  </section>
}

export function PlanningReviewPanel({ planning, target, onRead }: {
  planning: Planning; target: ReviewTarget; onRead: (document: PlanDocument) => void
}) {
  // New native identity/version remounts the form; ordinary projection updates preserve the draft.
  return <PlanReviewForm key={`${planning.state?.sessionId}:${target.epoch}:${target.review.reviewId}:${target.document.planId}:${target.document.revision}:${target.document.contentHash}`} planning={planning} target={target} onRead={onRead} />
}

function PlanReviewForm({ planning, target, onRead }: {
  planning: Planning; target: ReviewTarget; onRead: (document: PlanDocument) => void
}) {
  const [feedback, setFeedback] = React.useState('')
  const id = React.useId()
  const { state, busy, error, execute } = planning
  const allowed = (command: 'approve_and_execute' | 'request_revision' | 'dismiss_review') =>
    state?.freshness === 'fresh' && !!target.epoch && state.capabilities?.actions?.includes(command) &&
    (target.review.actions?.includes(command) ?? true)
  const respond = (command: 'approve_and_execute' | 'request_revision' | 'dismiss_review') => {
    if (busy || !allowed(command)) return
    void execute({ command, reviewId: target.review.reviewId, planId: target.review.planId, planRevision: target.review.planRevision, contentHash: target.review.contentHash, epoch: target.epoch, feedback: command === 'request_revision' ? feedback.trim() : undefined })
  }
  return <section aria-labelledby={`${id}-title`} className="mx-auto w-full max-w-[calc(48rem+2rem)] px-4 pb-4 pt-2">
    <Card>
      <CardHeader>
        <CardTitle><h2 id={`${id}-title`}>是否执行这个计划？</h2></CardTitle>
        <CardDescription>{target.document.title} · 版本 {target.document.revision}</CardDescription>
      </CardHeader>
      <CardContent className="flex max-h-[40dvh] flex-col gap-3 overflow-y-auto">
        {state?.freshness !== 'fresh' && <Alert><AlertDescription>原生状态待核对，请刷新后再确认。</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {target.review.status === 'open' && <FieldGroup><Field>
          <FieldLabel htmlFor={`${id}-feedback`}>修改意见</FieldLabel>
          <Textarea id={`${id}-feedback`} rows={2} value={feedback} onChange={event => setFeedback(event.target.value)} disabled={busy || !allowed('request_revision')} placeholder="不，说明需要如何调整计划" />
        </Field></FieldGroup>}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 [&_button]:min-h-11">
        <Button disabled={busy || !allowed('approve_and_execute')} onClick={() => respond('approve_and_execute')}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{busy ? '正在确认…' : target.review.status === 'approved' ? '重试启动' : '同意并执行'}</Button>
        {target.review.status === 'open' && <>
          <Button variant="outline" disabled={busy || !allowed('request_revision') || !feedback.trim()} onClick={() => respond('request_revision')}>提交修改意见</Button>
          <Button variant="ghost" disabled={busy || !allowed('dismiss_review')} onClick={() => respond('dismiss_review')}>暂不执行</Button>
        </>}
        <Button variant="ghost" onClick={() => onRead(target.document)}>打开计划</Button>
        <Button variant="ghost" onClick={() => void planning.refresh().catch(() => undefined)} disabled={busy} aria-label="刷新规划状态"><RefreshCw data-icon="inline-start" />刷新</Button>
      </CardFooter>
    </Card>
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

function PlanCard({ writing, children }: { writing: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)
  const [foreground, setForeground] = React.useState(true)
  React.useEffect(() => {
    const node = ref.current
    const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false))
    if (node) observer.observe(node)
    const changed = () => setForeground(!document.hidden)
    changed(); document.addEventListener('visibilitychange', changed)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', changed) }
  }, [])
  return <Card ref={ref} aria-busy={writing} className={cn((!writing || !visible || !foreground) && 'plan-writing-paused')}>{children}</Card>
}
