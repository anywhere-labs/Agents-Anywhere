// MockHost: plays a fixture the way a Connector + server would drive `watch`, so the web demo and the standalone
// renderer run without a backend. Implements the script semantics documented at the top of v3poc/fixtures/build.py:
//   event          pushed as is; items get `seq` the first time their id appears, and keep it
//   stream         the item pushed whole every `interval` ms (default 333) while its text grows at `cps`
//   until answer   the script pauses until that request is answered; the answer moves it to `control.answered`
// plus what the demo composer needs: send (user item, then the `reply` script, queued while a turn runs), stop,
// set_config, rewind, and a page of older items.
import type { AssistantMessage, Control, FilePart, ImagePart, Message, Session, UserMessage, WatchEvent } from '@protocol/timeline'
import type { ScriptStep, SessionFixture } from './fixtures'

type Step = ScriptStep | { wait: number; dequeue: string }

export interface MockHostOptions {
  /** Where the answer came from, for `answered[].device` ("Web", "iPhone"). */
  device: string
  emit: (events: WatchEvent[]) => void
  /** Speed multiplier for waits and streaming (tests, impatient demos). */
  speed?: number
}

export interface SendInput {
  client_msg_id: string
  content: string
  attachments?: (ImagePart | FilePart)[]
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const now = () => new Date().toISOString()
let tokens = 0
const token = () => `${Date.now().toString(36)}${(tokens++).toString(36)}`

export class MockHost {
  private session: Session
  private messages = new Map<string, Message>()
  private nextSeq: number
  private control: Control
  private queued: Control['queued'] = []
  private answered: NonNullable<Control['answered']> = []
  private steps: Step[] = []
  private running = false
  private disposed = false
  /** Bumped by stop / rewind / dispose: a step that wakes up under an older generation does nothing. */
  private generation = 0
  private waitingFor: { request_id: string; resolve: () => void } | null = null
  private olderServed = false

  constructor(
    private fixture: SessionFixture,
    private opts: MockHostOptions,
  ) {
    const snap = clone(fixture.snapshot)
    this.session = snap.session
    for (const m of snap.messages) this.messages.set(m.id, m)
    this.nextSeq = Math.max(-1, ...snap.messages.map((m) => m.seq)) + 1
    this.control = snap.control
  }

  /** Push the snapshot, then play the script. */
  start() {
    this.opts.emit([this.snapshot(this.fixture.snapshot.has_more)])
    this.enqueue(clone(this.fixture.script))
  }

  dispose() {
    this.disposed = true
    this.generation++
    this.waitingFor = null
  }

  // ── what the client can do ───────────────────────────────────────────────────────────────────────────────

  send(input: SendInput) {
    const busy = this.running || this.control.state === 'running'
    if (busy) {
      // Effi Cloud's queue: the message waits in control.queued and starts its own turn when this one ends.
      this.queued.push({ client_msg_id: input.client_msg_id, author: this.fixture.account.name, content: input.content, attachments: input.attachments })
      this.emitControl()
      this.enqueue([{ wait: 0, dequeue: input.client_msg_id }])
      return
    }
    this.startTurn(input)
  }

  answer(request_id: string, option_id: string) {
    const p = this.control.pending.find((x) => x.request_id === request_id)
    if (!p) return
    this.control = { ...this.control, pending: this.control.pending.filter((x) => x.request_id !== request_id) }
    this.answered = [...this.answered, { request_id, by: this.fixture.account.name, device: this.opts.device, option_id, at: now() }].slice(-20)
    this.emitControl()
    if (this.waitingFor?.request_id === request_id) {
      const w = this.waitingFor
      this.waitingFor = null
      w.resolve()
    }
  }

  /** session/cancel: drop the rest of the script, the queue, and close what was still open. */
  stop() {
    this.generation++
    this.steps = []
    this.queued = []
    this.waitingFor = null
    this.running = false
    const open = [...this.messages.values()].filter((m): m is AssistantMessage => m.role === 'assistant' && !m.done)
    const events: WatchEvent[] = open.map((m) => {
      const part = m.parts[0]
      const fixed = part.type === 'tool' && part.status !== 'completed' ? { ...part, status: 'failed' as const } : part
      const next: AssistantMessage = { ...m, done: true, parts: [fixed] }
      this.messages.set(m.id, next)
      return { type: 'message', message: next }
    })
    const last = [...this.messages.values()].filter((m): m is AssistantMessage => m.role === 'assistant').at(-1)
    if (last) {
      const marked: AssistantMessage = { ...last, interrupted: true }
      this.messages.set(last.id, marked)
      events.push({ type: 'message', message: marked })
    }
    this.control = { ...this.control, state: 'idle', pending: [] }
    this.opts.emit([...events, { type: 'control', control: this.withOverlay(this.control) }])
  }

  setConfig(config_id: string, value: string) {
    this.session = { ...this.session, config: this.session.config.map((c) => (c.id === config_id ? { ...c, current: value } : c)), updated_at: now() }
    this.opts.emit([{ type: 'session', session: this.session }])
  }

  /** Cut the conversation at a user message (it and everything after go); watchers get a new snapshot. */
  rewind(message_id: string) {
    const m = this.messages.get(message_id)
    if (!m || m.role !== 'user') return
    this.stop()
    for (const [id, x] of this.messages) if (x.seq >= m.seq) this.messages.delete(id)
    this.nextSeq = m.seq
    this.answered = []
    this.opts.emit([this.snapshot(this.fixture.snapshot.has_more && !this.olderServed)])
  }

  /**
   * `list_messages({before_seq})`: what the host still has before `before_seq` (the view let it go, see the window in
   * store.ts), else one synthesized page of older history, then nothing more.
   */
  older(before_seq: number): Promise<{ messages: Message[]; has_more: boolean }> {
    const kept = [...this.messages.values()].filter((m) => m.seq < before_seq).sort((a, b) => a.seq - b.seq)
    if (kept.length) {
      let from = Math.max(0, kept.length - 100)
      while (from > 0 && kept[from].role !== 'user') from--
      const has_more = from > 0 || (this.fixture.snapshot.has_more && !this.olderServed)
      return new Promise((resolve) => setTimeout(() => resolve({ messages: kept.slice(from), has_more }), 200))
    }
    this.olderServed = true
    const at = '2026-11-17T08:40:00Z'
    const u = `older-u-${before_seq}`
    const messages: Message[] = [
      { id: u, role: 'user', seq: before_seq - 3, created_at: at, done: true, rewindable: true, parts: [{ type: 'text', text: '先帮我确认一下本地测试库能不能连上。' }] },
      {
        id: `older-a1-${before_seq}`,
        role: 'assistant',
        turn_id: u,
        seq: before_seq - 2,
        created_at: at,
        done: true,
        parts: [{ type: 'tool', id: `older-call-${before_seq}`, title: 'psql -c "select 1"', kind: 'execute', status: 'completed', input: { command: 'psql "$AGENT_SERVER_TEST_DB_URL" -c "select 1"' }, output: ' ?column? \n----------\n        1\n(1 row)\n' }],
      },
      { id: `older-a2-${before_seq}`, role: 'assistant', turn_id: u, seq: before_seq - 1, created_at: at, done: true, parts: [{ type: 'text', text: '能连上，测试库是空的。' }] },
    ]
    return new Promise((resolve) => setTimeout(() => resolve({ messages, has_more: false }), 500))
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────

  private snapshot(has_more: boolean): WatchEvent {
    const messages = [...this.messages.values()].sort((a, b) => a.seq - b.seq)
    return { type: 'snapshot', session: this.session, messages, has_more, control: this.withOverlay(this.control) }
  }

  /**
   * Script controls are whole values; the queue and the answers are this host's own and ride on top. build.py's rule:
   * after `until: answer`, every later scripted control carries the answers the replayer added, as a real Connector's
   * whole control would (the fixture's controls list none).
   */
  private withOverlay(c: Control): Control {
    const answered = [...(c.answered ?? []).filter((a) => !this.answered.some((b) => b.request_id === a.request_id)), ...this.answered]
    return { ...c, queued: this.queued, answered }
  }

  private emitControl() {
    this.opts.emit([{ type: 'control', control: this.withOverlay(this.control) }])
  }

  private startTurn(input: SendInput) {
    const user: UserMessage = {
      id: `m-u-${token()}`,
      role: 'user',
      client_msg_id: input.client_msg_id,
      created_at: now(),
      seq: 0,
      done: true,
      rewindable: true,
      parts: [...(input.content ? [{ type: 'text' as const, text: input.content }] : []), ...(input.attachments ?? [])],
    }
    this.push(user)
    const x = token()
    const reply = JSON.parse(JSON.stringify(this.fixture.reply).replaceAll('$TURN', user.id).replaceAll('$X', x)) as ScriptStep[]
    this.enqueue(reply, true)
  }

  /** Give an item its position (first sight of its id: the next one; later: the one it had), store it, push it. */
  private push(m: Message) {
    const prev = this.messages.get(m.id)
    const seq = prev ? prev.seq : this.nextSeq++
    // Played items happen now: like `seq`, `created_at` is stamped the first time an id appears (the fixture's fixed
    // times would make "用时 …" and the running timer meaningless).
    const item = { ...m, seq, created_at: prev ? prev.created_at : now() } as Message
    this.messages.set(item.id, item)
    this.opts.emit([{ type: 'message', message: item }])
    return item
  }

  private enqueue(steps: Step[], front = false) {
    this.steps = front ? [...steps, ...this.steps] : [...this.steps, ...steps]
    if (!this.running) void this.run()
  }

  private sleep(ms: number, gen: number) {
    const scaled = ms / (this.opts.speed ?? 1)
    return new Promise<boolean>((resolve) => setTimeout(() => resolve(gen === this.generation && !this.disposed), scaled))
  }

  private async run() {
    this.running = true
    const gen = this.generation
    while (this.steps.length && gen === this.generation && !this.disposed) {
      const step = this.steps.shift()!
      if (step.wait && !(await this.sleep(step.wait, gen))) return
      if ('event' in step) this.applyEvent(clone(step.event))
      else if ('stream' in step) {
        if (!(await this.stream(step.stream, gen))) return
      } else if ('until' in step) {
        if (this.control.pending.some((p) => p.request_id === step.request_id)) {
          await new Promise<void>((resolve) => (this.waitingFor = { request_id: step.request_id, resolve }))
          if (gen !== this.generation || this.disposed) return
        }
      } else if ('dequeue' in step) {
        const q = this.queued.find((x) => x.client_msg_id === step.dequeue)
        if (!q) continue
        this.queued = this.queued.filter((x) => x !== q)
        this.emitControl()
        this.startTurn({ client_msg_id: q.client_msg_id, content: q.content, attachments: q.attachments })
      }
    }
    if (gen === this.generation) this.running = false
  }

  private applyEvent(e: WatchEvent) {
    if (e.type === 'message') this.push(e.message)
    else if (e.type === 'control') {
      this.control = e.control
      this.emitControl()
    } else if (e.type === 'session') {
      this.session = e.session
      this.opts.emit([e])
    } else this.opts.emit([e])
  }

  private async stream(s: { message: AssistantMessage; cps: number; interval?: number }, gen: number) {
    const final = clone(s.message)
    const part = final.parts[0]
    const full = part.type === 'text' || part.type === 'thinking' ? part.text : part.type === 'tool' && typeof part.output === 'string' ? part.output : ''
    const chars = Array.from(full)
    const interval = s.interval ?? 333
    const started = performance.now()
    for (;;) {
      const elapsed = (performance.now() - started) * (this.opts.speed ?? 1)
      const n = Math.min(chars.length, Math.round((elapsed * s.cps) / 1000))
      if (n >= chars.length) break
      const text = chars.slice(0, n).join('')
      const p = clone(part)
      if (p.type === 'text' || p.type === 'thinking') p.text = text
      else if (p.type === 'tool') {
        p.output = text
        p.status = 'in_progress'
      }
      this.push({ ...final, done: false, parts: [p] } as AssistantMessage)
      if (!(await this.sleep(interval, gen))) return false
    }
    this.push(final)
    return true
  }
}
