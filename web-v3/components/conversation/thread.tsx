"use client"

// The thread, shared by the web app and the mobile renderer: AI Elements · Chat (Message Scroller items) with Message,
// Bubble, Attachment and the step patterns. Items become turns (turns.ts); each turn is one scroller item, anchored on
// the person's message as Chat says. Who scrolls is the caller's: the web wraps these in Message Scroller, the renderer
// in the document scroller (renderer/document-scroller.tsx). Everything that acts goes out through ThreadEnv.
import { memo, useEffect, useMemo, useState } from 'react'
import type * as React from 'react'
import { CopyIcon, FileIcon, GitForkIcon, ImageIcon, LoaderCircleIcon, RefreshCwIcon, Undo2Icon } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { AssistantMessage, CompactPart, Control, FilePart, ImagePart, PendingRequest, UserMessage } from '@/lib/types/v3'
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from '@/components/ui/attachment'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Marker, MarkerContent } from '@/components/ui/marker'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Trace, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { cn } from '@/lib/utils'
import type { TimelineState } from '@/lib/timeline/store'
import { useThreadEnv } from './env'
import { Markdown } from './markdown'
import { StepGroup, type StepContext } from './steps'
import { formatBytes, formatTokens } from './text'
import { replyText, segmentsOf, TurnCache, userText, type TurnData } from './turns'
import { LazyTurn } from './virtual'

/** One scroller item (MessageScrollerItem on the web, a plain block in the document scroller). */
export type ThreadItem = React.ComponentType<{ id: string; anchor: boolean; children: React.ReactNode }>

/**
 * `showQueued`: draw messages waiting in control.queued at the end of the thread (the renderer: native has no queue
 * view yet). The web shows them in a Queue above the composer instead — Message Scroller re-anchors to the first
 * unhandled anchor when an item is swapped for another at the same count, which a queued bubble turning into a turn is.
 */
export function Thread({ state, Item, showQueued = true }: { state: TimelineState; Item: ThreadItem; showQueued?: boolean }) {
  const control = state.control
  // Turns whose items did not change keep their TurnData object, so their memoised components skip the update.
  const [cache] = useState(() => new TurnCache())
  // A message sent while a turn runs waits in control.queued (drawn below); its optimistic copy is not drawn twice.
  const turns = useMemo(() => {
    const queued = new Set(control?.queued.map((q) => q.client_msg_id))
    return cache.build(state.messages, queued.size ? state.outgoing.filter((o) => !queued.has(o.client_msg_id!)) : state.outgoing)
  }, [cache, state.messages, state.outgoing, control?.queued])
  const running = control?.state === 'running'
  // Changes only when a permission request does (rare): every turn re-renders then, never on a streamed push.
  const ctx = useMemo<StepContext>(
    () => ({
      requestsFor: (part, id) => {
        const forThis = (r: PendingRequest) => r.tool_call_id === part.id || r.message_id === id
        // The latest control is the truth: an answer it no longer lists is not shown (no client-side memory of it).
        const answered = (control?.answered ?? []).flatMap((a) => {
          const request = state.requests[a.request_id]
          return request && forThis(request) ? [{ request, by: a.by, device: a.device, option_id: a.option_id }] : []
        })
        return { pending: control?.pending.find(forThis), answered }
      },
      subagentSteps: new Map(),
    }),
    [control?.pending, control?.answered, state.requests],
  )
  const waiting = new Set((control?.pending ?? []).map((p) => p.message_id))
  return (
    <>
      {turns.map((t, i) => {
        const last = i === turns.length - 1
        const live = last && running
        return (
          <Item key={t.key} id={t.key} anchor={!!t.user}>
            <LazyTurn
              id={t.key}
              firstSeq={t.firstSeq}
              pinned={live || t.items.some((m) => waiting.has(m.id))}
              initiallyNear={i >= turns.length - 3}
              estimate={estimateHeight(t)}
            >
              <Turn turn={t} live={live} last={last} control={last ? control : null} ctx={ctx} />
            </LazyTurn>
          </Item>
        )
      })}
      {showQueued &&
        control?.queued.map((q) => (
        <Item key={`q-${q.client_msg_id}`} id={`q-${q.client_msg_id}`} anchor={false}>
          <Message align="end">
            <MessageContent>
              <MessageHeader className="justify-end">排队中 · 这一轮结束后发送</MessageHeader>
              <Bubble align="end" variant="outline">
                <BubbleContent className="whitespace-pre-wrap text-muted-foreground">{q.content}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        </Item>
      ))}
    </>
  )
}

/** A turn's height before it was ever drawn (rem-based, roughly): replaced by the measured height once drawn. */
function estimateHeight(t: TurnData) {
  // The renderer sets the root size inline (surroundings.ts); reading it there forces no style recalculation.
  const rem = parseFloat(document.documentElement.style.fontSize) || 16
  let h = t.user ? 6 + (t.user.parts.some((p) => p.type !== 'text') ? 12 : 0) : 0
  let group = false
  for (const m of t.items) {
    const p = m.role === 'assistant' ? m.parts[0] : null
    if (p?.type === 'text') {
      h += 3 + p.text.length / 18
      group = false
    } else if (!group) {
      h += 3
      group = true
    }
  }
  return Math.round((h + 3) * rem)
}

/**
 * One turn. Memoised: a push changes one turn's TurnData, so only that turn re-renders. `control` is passed to the
 * last turn only (its working line and error).
 */
const Turn = memo(function Turn({ turn, live, last, control, ctx }: { turn: TurnData; live: boolean; last: boolean; control: Control | null; ctx: StepContext }) {
  const showReply = turn.items.length > 0 || live || (last && control?.state === 'error')
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {turn.user && <UserTurn message={turn.user} outgoing={turn.outgoing} />}
      {showReply && <AgentTurn turn={turn} live={live} last={last} control={control} ctx={ctx} />}
    </div>
  )
})

// ── The person's message ───────────────────────────────────────────────────────────────────────────────────────────

function UserTurn({ message, outgoing }: { message: UserMessage; outgoing?: boolean }) {
  const env = useThreadEnv()
  const text = userText(message)
  const authorName = !message.author ? null : env.whoIs ? env.whoIs(message.author) : message.author !== env.me ? message.author : null
  const files = message.parts.filter((p): p is ImagePart | FilePart => p.type === 'image' || p.type === 'file')
  return (
    <Message align="end" className="group/user">
      <MessageContent>
        {authorName && <MessageHeader className="justify-end">{authorName}</MessageHeader>}
        {files.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-2 self-end">
            {files.map((f, i) => (
              <UserAttachment key={i} part={f} />
            ))}
          </div>
        )}
        {text && (
          <Bubble align="end" variant="muted" className={cn(outgoing && 'opacity-70')}>
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        )}
        <MessageFooter className="gap-0.5 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/user:opacity-100 pointer-fine:focus-within:opacity-100">
          {outgoing ? (
            <span className="px-1 py-1.5">发送中…</span>
          ) : (
            <>
              {text && (
                <MessageAction label="复制" onClick={() => env.copy(text)}>
                  <CopyIcon />
                </MessageAction>
              )}
              {message.rewindable && env.rewind && (
                <MessageAction label="撤回到这条消息之前" onClick={() => env.rewind!(message.id)}>
                  <Undo2Icon />
                </MessageAction>
              )}
            </>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  )
}

/** An image attachment's bytes: the host's immediate source (a local thumbnail), else read from the device once. */
function DeviceImage({ part, className }: { part: ImagePart; className?: string }) {
  const env = useThreadEnv()
  const immediate = env.imageSrc(part.path, part.mime, part.name)
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null)
  useEffect(() => {
    if (immediate || !env.loadImage) return
    let alive = true
    void env.loadImage(part.path, part.mime).then((url) => {
      if (alive) setLoaded({ path: part.path, url })
    })
    return () => {
      alive = false
    }
  }, [env, immediate, part.mime, part.path])
  const src = immediate || (loaded?.path === part.path ? loaded.url : null)
  if (!src) return <ImageIcon className="m-auto size-6 text-muted-foreground" />
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={part.name} loading="lazy" className={className} />
}

function UserAttachment({ part }: { part: ImagePart | FilePart }) {
  const env = useThreadEnv()
  const [zoomed, setZoomed] = useState(false)
  const open = () => {
    env.haptic?.('light')
    env.open({ kind: 'file', path: part.path })
  }
  if (part.type === 'image')
    return (
      <>
        <button
          type="button"
          title={part.name}
          aria-label={`打开 ${part.name}`}
          onClick={() => {
            env.haptic?.('light')
            setZoomed(true)
          }}
          className="flex size-28 overflow-hidden rounded-2xl bg-card focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <DeviceImage part={part} className="size-full object-cover" />
        </button>
        <Dialog open={zoomed} onOpenChange={setZoomed}>
          <DialogContent className="max-w-[min(92vw,64rem)] gap-2 p-2 sm:max-w-[min(92vw,64rem)]">
            <DialogTitle className="sr-only">{part.name}</DialogTitle>
            <DeviceImage part={part} className="max-h-[80vh] w-full rounded-[calc(var(--radius-card)-0.5rem)] object-contain" />
            <div className="flex items-center gap-2 px-2 pb-1 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {part.name} · {formatBytes(part.size)}
              </span>
              <Button variant="ghost" size="xs" onClick={open}>
                <FileIcon />
                {part.path.split(/[\\/]/).slice(-2).join('/')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    )
  return (
    <Attachment className="min-w-44 border-0 bg-card">
      <AttachmentMedia>
        <FileIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{part.name}</AttachmentTitle>
        <AttachmentDescription>
          {(part.name.split('.').pop() ?? '').toUpperCase()} · {formatBytes(part.size)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentTrigger aria-label={`打开 ${part.name}`} onClick={open} />
    </Attachment>
  )
}

// ── The agent's reply ──────────────────────────────────────────────────────────────────────────────────────────────

function AgentTurn({ turn, live, last, control, ctx: base }: { turn: TurnData; live: boolean; last: boolean; control: Control | null; ctx: StepContext }) {
  const env = useThreadEnv()
  const segments = useMemo(() => segmentsOf(turn.items), [turn.items])
  const ctx = useMemo<StepContext>(() => ({ ...base, subagentSteps: turn.sub }), [base, turn.sub])
  const assistant = turn.items.filter((m): m is AssistantMessage => m.role === 'assistant')
  const lastItem = assistant.at(-1)
  const lastSegment = segments.at(-1)
  // Between items (the agent is working, nothing streams yet): one running line, like the patterns' "Thinking" — unless
  // the running step group's own line already says so.
  const idleWhileRunning = live && !assistant.some((m) => !m.done) && !control?.pending.length && lastSegment?.kind !== 'steps'
  const text = replyText(turn.items)
  const error = last && control?.state === 'error' ? (control.error ?? '这一轮失败了') : null
  // How long the turn took, on its last step group once it is done (from its first item to its last).
  const turnMs = !live && assistant.length > 1 ? new Date(lastItem!.created_at).getTime() - new Date(assistant[0].created_at).getTime() : undefined
  const lastGroup = segments.findLast((s) => s.kind === 'steps')
  // The last reply can be asked for again (its prompt resent); a prompt with attachments cannot be resent as text.
  const canRegenerate = Boolean(
    env.regenerate && turn.user?.rewindable && !turn.outgoing && turn.user.parts.every((p) => p.type === 'text'),
  )
  return (
    <Message>
      <MessageContent className="gap-4">
        {segments.map((s) => {
          switch (s.kind) {
            case 'steps': {
              // The plan stays open for the whole turn (it is updated to the end); it does not keep a group running.
              const groupLive = live && (s === lastSegment || s.steps.some((m) => !m.done && m.parts[0].type !== 'plan'))
              return (
                <Trace key={s.key}>
                  <StepGroup steps={s.steps} live={groupLive} turnMs={s === lastGroup && turnMs && turnMs > 0 ? turnMs : undefined} ctx={ctx} />
                </Trace>
              )
            }
            case 'text':
              return <TextBlock key={s.key} message={s.message} text={s.text} />
            case 'compaction':
              return <Compaction key={s.key} part={s.message.parts[0] as CompactPart} />
            case 'steer':
              return (
                <Message key={s.key} align="end">
                  <MessageContent>
                    <MessageHeader className="justify-end">插话</MessageHeader>
                    <Bubble align="end" variant="muted">
                      <BubbleContent className="whitespace-pre-wrap">{userText(s.message)}</BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
              )
          }
        })}
        {idleWhileRunning && (
          <Trace>
            <TraceLine status="running">
              <TraceIcon>
                <LoaderCircleIcon className="animate-spin" />
              </TraceIcon>
              <TraceTitle>正在处理</TraceTitle>
            </TraceLine>
          </Trace>
        )}
        {lastItem?.interrupted && <p className="text-sm text-muted-foreground">已停止</p>}
        {error && (
          <Bubble variant="destructive">
            <BubbleContent>{error}</BubbleContent>
          </Bubble>
        )}
        {!live && (text || (last && canRegenerate)) && (
          <MessageFooter className="-ml-1.5 gap-0.5 px-0">
            {text && (
              <MessageAction label="复制" onClick={() => env.copy(text)}>
                <CopyIcon />
              </MessageAction>
            )}
            {last && canRegenerate && (
              <MessageAction label="重新生成" onClick={() => env.regenerate!(turn.user!.id)}>
                <RefreshCwIcon />
              </MessageAction>
            )}
            {env.fork && lastItem && (
              <MessageAction label="从这里分叉" onClick={() => env.fork!(lastItem.id)}>
                <GitForkIcon />
              </MessageAction>
            )}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}

/** Streamdown animates the words of each push in (and repairs unterminated Markdown) while the item streams. */
function TextBlock({ message, text }: { message: AssistantMessage; text: string }) {
  return <Markdown streaming={!message.done}>{text}</Markdown>
}

function Compaction({ part }: { part: CompactPart }) {
  const running = part.status === 'running'
  const saved = part.tokens_before && part.tokens_after ? ` · ${formatTokens(part.tokens_before)} → ${formatTokens(part.tokens_after)}` : ''
  return (
    <Marker variant="separator">
      <MarkerContent className={cn(running && 'shimmer')}>
        {running ? '正在压缩上下文' : part.status === 'failed' ? '压缩上下文失败' : `已压缩上下文${saved}`}
      </MarkerContent>
    </Marker>
  )
}

/** Message › Actions: a ghost icon button with its name as the tooltip. */
function MessageAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  const env = useThreadEnv()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => {
              env.haptic?.('light')
              onClick()
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

