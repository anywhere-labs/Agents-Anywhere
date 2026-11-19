// A stand-in for the native app when renderer.html is opened in a plain browser: plays the demo fixture through the
// same aa.render/1 messages native would send, and answers what the renderer posts. URL parameters for testing:
//   ?scheme=dark|light  ?approvals=inline|host  ?top=…&bottom=… (insets, CSS px)  ?scale=1.2  ?speed=2
//   ?stress=items:3000,chars:3000,hz:30,parallel:3  plays the stress session instead (stress.ts)
import type { HostMessage, RendererMessage } from '@protocol/bridge'
import { demo } from '@/timeline/fixtures'
import { MockHost } from '@/timeline/mock-host'
import { startStressHost } from './stress'

export function startDevHost(receive: (m: HostMessage) => void): (m: RendererMessage) => void {
  const q = new URLSearchParams(location.search)
  const host = new MockHost(demo, {
    device: 'iPhone',
    speed: Number(q.get('speed')) || 1,
    emit: (events) => receive({ type: 'watch', events }),
  })
  let started = false
  const stressSpec = q.get('stress')
  let stress: ReturnType<typeof startStressHost> | null = null
  console.info('[aa.render dev host] no native host: playing the demo fixture')
  return (m) => {
    switch (m.type) {
      case 'ready':
        if (started) return
        started = true
        receive({ type: 'chrome', approvals: q.get('approvals') === 'host' ? 'host' : 'inline' })
        receive({
          type: 'appearance',
          scheme: q.get('scheme') === 'dark' || (!q.get('scheme') && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
          textScale: Number(q.get('scale')) || 1,
          reduceMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          locale: 'zh-CN',
          account: { name: demo.account.name },
        } as HostMessage)
        receive({ type: 'viewport', top: Number(q.get('top')) || 0, bottom: Number(q.get('bottom')) || 0 })
        if (stressSpec != null) stress = startStressHost(stressSpec, receive)
        else host.start()
        return
      case 'answer':
        if (stress) stress.answer(m.request_id, m.option_id)
        else host.answer(m.request_id, m.option_id)
        return
      case 'loadOlder':
        if (stress) return stress.older(m.before_seq)
        void host.older(m.before_seq).then((r) => receive({ type: 'older', messages: r.messages, has_more: r.has_more }))
        return
      case 'rewind':
        host.rewind(m.message_id)
        return
      case 'open':
        if (m.target.kind === 'url') window.open(m.target.url, '_blank', 'noopener')
        else console.info('[aa.render dev host] open', m.target)
        return
      case 'copy':
        void navigator.clipboard?.writeText(m.text).catch(() => {})
        return
      default:
        if (m.type !== 'scroll' && m.type !== 'haptic') console.info('[aa.render dev host]', m)
    }
  }
}
