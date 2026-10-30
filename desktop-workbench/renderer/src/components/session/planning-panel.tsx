"use client"

import * as React from 'react'
import { FileText, Download, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Field, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { MarkdownText } from '@/components/markdown-text'
import { copyText } from '@/lib/clipboard'
import type { useSessionPlanning, PlanDocument, PlanningState } from '@/features/planning/use-session-planning'
import { cn } from '@/lib/utils'

type ReviewTarget = { document: PlanDocument; review: NonNullable<PlanningState['review']>; epoch: string; revision: number }
export function PlanningPanel({ planning, canReview = true }: { planning: ReturnType<typeof useSessionPlanning>; canReview?: boolean }) {
  const { state, documents, busy, error, execute } = planning
  const [reader, setReader] = React.useState<PlanDocument | null>(null)
  const readerScroll = React.useRef(new Map<string, number>())
  const [target, setTarget] = React.useState<ReviewTarget | null>(null)
  const [feedback, setFeedback] = React.useState('')
  const reviewTitle = React.useRef<HTMLHeadingElement>(null)
  const readerTitle = React.useRef<HTMLHeadingElement>(null)
  const shown = React.useRef(new Set<string>())
  const open = React.useCallback(() => {
    if (!state?.proposal || !state.review) return
    setTarget({ document: state.proposal, review: state.review, epoch: state.epoch ?? "", revision: state.revision ?? 0 })
    setFeedback('')
  }, [state])
  React.useEffect(() => {
    if (canReview && state?.freshness === 'fresh' && state.review?.status === 'open' && state.capabilities?.actions?.length && !shown.current.has(state.review.reviewId)) {
      shown.current.add(state.review.reviewId); open()
    }
  }, [state, open, canReview])
  const current = Boolean(canReview && target && state?.freshness === 'fresh' && state.epoch === target.epoch && state.review?.reviewId === target.review.reviewId && (state.review?.status === 'open' || (state.review?.status === 'approved' && state.execution?.status === 'rejected' && state.execution?.retryable === true)) && state.capabilities?.actions?.length)
  const respond = async (command: 'approve_and_execute' | 'request_revision' | 'dismiss_review') => {
    if (!target || !current) return
    if (await execute({ command, reviewId: target.review.reviewId, planId: target.review.planId, planRevision: target.review.planRevision, contentHash: target.review.contentHash, epoch: target.epoch, feedback })) setTarget(null)
  }
  const download = (document: PlanDocument) => {
    const url = URL.createObjectURL(new Blob([document.markdown], { type: 'text/markdown;charset=utf-8' }))
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'PLAN.md'; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
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
        <Button variant="outline" size="sm" onClick={() => setReader(document)}>打开计划</Button>
        <Button variant="ghost" size="sm" onClick={() => download(document)}><Download data-icon="inline-start" />下载</Button>
        {state?.review?.planId === document.planId && state.review.planRevision === document.revision && (state.review.status === 'open' || (state.review.status === 'approved' && state.execution?.status === 'rejected' && state.execution?.retryable === true)) && <Button size="sm" variant="secondary" onClick={open} disabled={!canReview || state.freshness !== 'fresh' || !state.capabilities?.actions?.length}>{state.review.status === 'approved' ? '重试启动' : '审阅计划'}</Button>}
      </CardFooter>}
    </PlanCard>)}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Sheet open={reader !== null} onOpenChange={value => { if (!value) setReader(null) }}>
      <SheetContent onOpenAutoFocus={event => { event.preventDefault(); readerTitle.current?.focus() }} className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader className="pr-16"><SheetTitle ref={readerTitle} tabIndex={-1} className="outline-none">{reader?.title ?? '计划'}</SheetTitle><SheetDescription>已保存的计划 · 版本 {reader?.revision}</SheetDescription></SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
          ref={node => { if (node && reader) node.scrollTop = readerScroll.current.get(`${reader.planId}:${reader.revision}`) ?? 0 }}
          onScroll={event => { if (reader) readerScroll.current.set(`${reader.planId}:${reader.revision}`, event.currentTarget.scrollTop) }}>
          {reader && <MarkdownText text={reader.markdown} />}
        </div>
        <SheetFooter className="flex-row flex-wrap border-t"><Button variant="outline" onClick={() => reader && void copyText(reader.markdown)}><Copy data-icon="inline-start" />复制</Button><Button onClick={() => reader && download(reader)}><Download data-icon="inline-start" />下载 Markdown</Button></SheetFooter>
      </SheetContent>
    </Sheet>
    <Dialog open={target !== null} onOpenChange={value => { if (!value && !busy) setTarget(null) }}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-y-auto sm:max-w-3xl" onOpenAutoFocus={event => { event.preventDefault(); reviewTitle.current?.focus() }} onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
        <DialogHeader><DialogTitle ref={reviewTitle} tabIndex={-1} className="outline-none">是否执行这个计划？</DialogTitle><DialogDescription>{target?.document.title} · 版本 {target?.document.revision}。批准后按当前权限设置继续执行。</DialogDescription></DialogHeader>
        <div className="max-h-[45dvh] min-h-0 overflow-y-auto">{target && <MarkdownText text={target.document.markdown} />}</div>
        {!current && <Alert><AlertDescription>审阅状态已变化，请刷新后重新打开当前计划。</AlertDescription></Alert>}
        <Field><FieldLabel htmlFor="plan-feedback">修改意见</FieldLabel><Textarea id="plan-feedback" value={feedback} onChange={event => setFeedback(event.target.value)} disabled={busy || target?.review.status !== 'open'} placeholder="说明需要调整的部分" /></Field>
        <DialogFooter className="flex-wrap [&_button]:max-sm:min-h-11"><Button variant="ghost" disabled={busy || !current || target?.review.status !== 'open'} onClick={() => void respond('dismiss_review')}>暂不执行</Button><Button variant="outline" disabled={busy || !current || !feedback.trim() || target?.review.status !== 'open'} onClick={() => void respond('request_revision')}>提交修改意见</Button><Button disabled={busy || !current} onClick={() => void respond('approve_and_execute')}>{busy ? '正在确认…' : target?.review.status === 'approved' ? '重试启动' : '同意并执行'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
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
