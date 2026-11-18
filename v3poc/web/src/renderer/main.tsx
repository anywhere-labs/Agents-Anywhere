// renderer.html: only the thread, for the native apps' WebView (aa.render/1, v3poc/protocol/bridge.ts). Native keeps
// the connection and forwards `watch` events unchanged; they go into the same TimelineStore the web app uses and are
// drawn by the same thread components. The document scrolls (see document-scroller.tsx).
import { StrictMode, useMemo, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { RENDER_PROTOCOL, type HostMessage } from '@protocol/bridge'
import { Spinner } from '@/components/ui/spinner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThreadEnvContext, type ThreadEnv } from '@/conversation/env'
import { placeholderImage } from '@/conversation/placeholder'
import { Thread } from '@/conversation/thread'
import { memoryPressure, useWindowTrimmer } from '@/conversation/virtual'
import { demo } from '@/timeline/fixtures'
import { TimelineStore } from '@/timeline/store'
import { useTimeline } from '@/timeline/use-timeline'
import { cn } from '@/lib/utils'
import '@/styles/renderer.css'
import { nativeHost, post, setFallbackHost } from './bridge'
import { startDevHost } from './dev-host'
import { DocumentItem, documentScroll, useDocumentScroller } from './document-scroller'
import { surroundings, type Appearance } from './surroundings'

const store = new TimelineStore()
const native = nativeHost()

function receive(input: HostMessage | string) {
  const m: HostMessage = typeof input === 'string' ? JSON.parse(input) : input
  switch (m.type) {
    case 'watch':
      store.watch(m.events)
      return
    case 'older':
      store.older(m.messages, m.has_more)
      return
    case 'viewport':
      surroundings.set({ viewport: { top: m.top, bottom: m.bottom } })
      return
    case 'appearance':
      surroundings.set({ appearance: { scheme: m.scheme, textScale: m.textScale, reduceMotion: m.reduceMotion, locale: m.locale, account: (m as Appearance).account } })
      return
    case 'chrome':
      surroundings.set({ chrome: { approvals: m.approvals } })
      return
    case 'scrollToEnd':
      documentScroll.scrollToEnd(m.animated)
      return
    case 'memoryPressure':
      memoryPressure(m.level)
      return
  }
}

window.aaRenderer = { receive }
if (!native) setFallbackHost(startDevHost(receive))

function loadOlder() {
  const s = store.get()
  const first = s.messages[0]
  if (!s.has_more || s.loadingOlder || !first) return
  store.setLoadingOlder(true)
  post({ type: 'loadOlder', before_seq: first.seq })
}

// The document scrolls: no scroll root element (virtual.tsx).
const documentRoot = () => null

function Renderer() {
  const state = useTimeline(store)
  useWindowTrimmer(store, documentRoot)
  const env0 = useSyncExternalStore(surroundings.subscribe, surroundings.get)
  const env = useMemo<ThreadEnv>(
    () => ({
      // Who the reader is: `appearance.account` from native; the dev host sends the fixture's account the same way.
      me: env0.appearance.account?.name ?? (native ? '' : demo.account.name),
      approvals: env0.chrome.approvals,
      reduceMotion: env0.appearance.reduceMotion,
      imageSrc: (path, _mime, name) => (native ? `aa-app://file?path=${encodeURIComponent(path)}` : placeholderImage(name)),
      answer: (request_id, option_id) => post({ type: 'answer', request_id, option_id }),
      open: (target) => post({ type: 'open', target }),
      copy: (text) => post({ type: 'copy', text }),
      rewind: (message_id) => post({ type: 'rewind', message_id }),
      fork: (message_id) => post({ type: 'fork', message_id }),
      haptic: (style) => post({ type: 'haptic', style }),
      markdownControls: { table: { copy: true, download: true, fullscreen: false }, code: true, mermaid: { copy: true, download: true, fullscreen: false, panZoom: true } },
    }),
    [env0.chrome.approvals, env0.appearance.reduceMotion, env0.appearance.account?.name],
  )
  const keys = state.messages
  const last = state.outgoing.at(-1) ?? keys.at(-1)
  const { content, settled } = useDocumentScroller({
    epoch: state.epoch,
    firstKey: keys[0]?.id,
    lastKey: last?.role === 'user' ? (last.client_msg_id ?? last.id) : last?.id,
    lastIsAnchor: last?.role === 'user',
    canLoadOlder: state.has_more && !state.loadingOlder,
    onLoadOlder: loadOlder,
    onScrollState: (s) => post({ type: 'scroll', ...s }),
    reduceMotion: env0.appearance.reduceMotion,
  })
  return (
    <ThreadEnvContext.Provider value={env}>
      <div className={cn('mx-auto w-full max-w-3xl px-4', !settled && 'invisible')}>
        {state.loadingOlder && (
          <div className="flex justify-center py-3 text-muted-foreground">
            <Spinner />
          </div>
        )}
        <div ref={content} role="log" aria-label="对话" className="flex flex-col gap-6 py-4">
          <Thread state={state} Item={DocumentItem} />
        </div>
      </div>
    </ThreadEnvContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Renderer />
    </TooltipProvider>
  </StrictMode>,
)

post({ type: 'ready', protocol: RENDER_PROTOCOL, renderer: 'aa-v3poc-web/0.0.0' })
