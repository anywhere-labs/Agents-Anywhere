// The web demo's sessions: one TimelineStore + MockHost per session, made the first time it is opened and kept, so a
// session keeps playing in the background while another one is open (as a real `watch` per open session would).
import type { FilePart, ImagePart, UserMessage } from '@protocol/timeline'
import { MockHost } from '@/timeline/mock-host'
import { fixtureFor } from '@/timeline/fixtures'
import { TimelineStore } from '@/timeline/store'

export interface DemoSession {
  store: TimelineStore
  host: MockHost
}

const sessions = new Map<string, DemoSession>()
const listeners = new Set<() => void>()
let version = 0

export function openSession(id: string): DemoSession {
  let s = sessions.get(id)
  if (!s) {
    const store = new TimelineStore()
    const host = new MockHost(fixtureFor(id), { device: 'Web', emit: (events) => store.watch(events) })
    s = { store, host }
    sessions.set(id, s)
    host.start()
    version++
    for (const fn of listeners) fn()
  }
  return s
}

export const peekSession = (id: string) => sessions.get(id)
export const subscribeSessions = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const sessionsVersion = () => version

let seq = 0
export const newClientMsgId = () => `web-${Date.now().toString(36)}-${(seq++).toString(36)}`

/** Send: show it at once (optimistic), then hand it to the host; the pushed item with the same key replaces it. */
export function send(s: DemoSession, content: string, attachments: (ImagePart | FilePart)[]) {
  const client_msg_id = newClientMsgId()
  const optimistic: UserMessage = {
    id: `local-${client_msg_id}`,
    role: 'user',
    client_msg_id,
    created_at: new Date().toISOString(),
    seq: Number.MAX_SAFE_INTEGER,
    done: true,
    parts: [...(content ? [{ type: 'text' as const, text: content }] : []), ...attachments],
  }
  s.store.addOutgoing(optimistic)
  s.host.send({ client_msg_id, content, attachments })
}

export function loadOlder(s: DemoSession) {
  const state = s.store.get()
  const first = state.messages[0]
  if (!state.has_more || state.loadingOlder || !first) return
  s.store.setLoadingOlder(true)
  void s.host.older(first.seq).then((r) => s.store.older(r.messages, r.has_more))
}
