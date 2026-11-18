// The web demo: sidebar, header, the thread (AI Elements · Chat on Message Scroller) and the composer. Sessions are
// played by MockHost from the fixtures in place of a Connector's `watch`.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleIcon, ListTodoIcon, MoonIcon, SunIcon } from 'lucide-react'
import type { OpenTarget } from '@protocol/bridge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace'
import { ThreadEnvContext, type ThreadEnv } from '@/conversation/env'
import { placeholderImage } from '@/conversation/placeholder'
import { agentLabel } from '@/conversation/text'
import { Thread, type ThreadItem } from '@/conversation/thread'
import { ScrollRootContext, useWindowTrimmer } from '@/conversation/virtual'
import { DEMO_SESSION_ID, workspace } from '@/timeline/fixtures'
import type { TimelineState } from '@/timeline/store'
import { useTimeline } from '@/timeline/use-timeline'
import { AppSidebar } from './app-sidebar'
import { Composer, type Draft } from './composer'
import { ContextMeter } from './context-meter'
import { loadOlder, openSession, send, type DemoSession } from './sessions'

const params = new URLSearchParams(location.search)
/** Local previews of attachments sent from this page, by path. */
const previews = new Map<string, string>()

const WebItem: ThreadItem = ({ id, anchor, children }) => (
  <MessageScrollerItem messageId={id} scrollAnchor={anchor}>
    {children}
  </MessageScrollerItem>
)

export function App() {
  const [active, setActive] = useState(() => params.get('session') ?? DEMO_SESSION_ID)
  const [read, setRead] = useState(() => new Set<string>([active]))
  // Opened in the handler, not while rendering: opening starts the session's host, which updates the sidebar.
  const [session, setSession] = useState(() => openSession(active))
  const open = (id: string) => {
    setActive(id)
    setSession(openSession(id))
    setRead((r) => new Set(r).add(id))
  }
  return (
    <SidebarProvider className="h-svh">
      <AppSidebar workspace={workspace} active={active} read={read} onOpen={open} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SessionView key={active} session={session} />
      </SidebarInset>
    </SidebarProvider>
  )
}

const STATE_LABEL: Record<string, string> = {
  running: '运行中',
  idle: '空闲',
  error: '出错',
  disconnected: '已断开',
}

function SessionView({ session }: { session: DemoSession }) {
  const state = useTimeline(session.store)
  const s = state.session
  const control = state.control
  const reduceMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const env = useMemo<ThreadEnv>(
    () => ({
      me: workspace.account.name,
      approvals: params.get('approvals') === 'host' ? 'host' : 'inline',
      reduceMotion,
      imageSrc: (path, _mime, name) => previews.get(path) ?? placeholderImage(name),
      answer: (request_id, option_id) => session.host.answer(request_id, option_id),
      open: (target: OpenTarget) => {
        if (target.kind === 'url') window.open(target.url, '_blank', 'noopener')
        else console.info('[demo] open file', target.path, target.line ?? '')
      },
      copy: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
      rewind: (id) => session.host.rewind(id),
      fork: (id) => console.info('[demo] fork from', id),
    }),
    [session, reduceMotion],
  )
  const onSend = useCallback(
    (text: string, drafts: Draft[]) => {
      for (const d of drafts) if (d.preview) previews.set(d.part.path, d.preview)
      send(
        session,
        text,
        drafts.map((d) => d.part),
      )
    },
    [session],
  )
  if (!s) return <div className="flex flex-1 items-center justify-center text-muted-foreground">正在打开…</div>
  const waiting = !!control?.pending.length
  return (
    <ThreadEnvContext.Provider value={env}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <div className="flex min-w-0 flex-col leading-tight">
          <h1 className="truncate text-sm font-medium">{s.title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {agentLabel(s.agent)} · {s.device.name}
            {s.branch ? ` · ${s.branch}` : ''}
          </p>
        </div>
        <Badge variant={control?.state === 'error' ? 'destructive' : waiting ? 'outline' : 'secondary'} className="ml-1 shrink-0">
          {control?.state === 'running' && !waiting && <Spinner className="size-3" />}
          {waiting ? '等待确认' : STATE_LABEL[control?.state ?? 'idle']}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <ContextMeter usage={control?.usage} />
          <ThemeToggle />
        </div>
      </header>
      <ChatView state={state} session={session} />
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-4">
        {!!control?.queued.length && <Queue items={control.queued.map((q) => q.content)} />}
        <Composer config={s.config} running={control?.state === 'running'} onSend={onSend} onStop={() => session.host.stop()} onConfig={(id, v) => session.host.setConfig(id, v)} />
      </div>
    </ThreadEnvContext.Provider>
  )
}

// The Message Scroller's viewport scrolls the thread: turns far from it let go of their DOM, and the window is kept
// while the reader is at the end (virtual.tsx). Looked up in the DOM: it exists before the turns' layout effects run,
// unlike a ref on it.
const scrollRoot = () => document.querySelector('[data-slot="message-scroller-viewport"]')

/** AI Elements · Chat: Message Scroller with autoScroll, the person's turns as scroll anchors, the scroll button. */
function ChatView({ state, session }: { state: TimelineState; session: DemoSession }) {
  useWindowTrimmer(session.store, scrollRoot)
  return (
    <ScrollRootContext.Provider value={scrollRoot}>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            {state.has_more && (
              <div className="flex justify-center pt-4">
                <Button variant="ghost" size="sm" disabled={state.loadingOlder} onClick={() => loadOlder(session)}>
                  {state.loadingOlder && <Spinner />}
                  加载更早的消息
                </Button>
              </div>
            )}
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
              <Thread state={state} Item={WebItem} showQueued={false} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </ScrollRootContext.Provider>
  )
}

/** AI Elements · Queue: messages that start their own turn when this one ends. */
function Queue({ items }: { items: string[] }) {
  return (
    <Trace className="px-1">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <ListTodoIcon />
            </TraceIcon>
            <TraceTitle>{items.length} 条排队中，这一轮结束后发送</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {items.map((t, i) => (
              <TraceLine key={i}>
                <TraceIcon>
                  <CircleIcon />
                </TraceIcon>
                <TraceTitle>{t}</TraceTitle>
              </TraceLine>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? '切换到浅色' : '切换到深色'}
      onClick={() => {
        setDark(!dark)
        localStorage.setItem('aa-v3poc.theme', dark ? 'light' : 'dark')
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}
