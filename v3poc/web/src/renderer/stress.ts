// Stress mode for the renderer's dev host: `renderer.html?stress=items:3000,chars:3000,hz:30,parallel:3`.
// A port of the iOS demo's StressContent / runStress (v3poc/ios/AAv3PoC/Model/StressContent.swift,
// MockSessionsClient.swift) so the same load can be measured in a desktop browser: long Markdown (headings, lists, code
// in several languages, wide tables, quotes, math, mermaid), thinking, tools (thousands of terminal lines, long file
// reads, search, long diffs, failures), a plan updated often, subagents with steps, approvals, user messages with
// attachments. Items grow and are pushed whole `hz` times a second, `parallel` of them at once.
//   items     finished items before the feed stops            chars     Markdown characters per text item
//   hz        pushes per second per growing item              parallel  items growing at once
//   snapshot  finished items already in the session at open   lines     terminal lines (reads: lines / 2)
//   difflines lines per side of an edit                       approve   an approval every n steps (0: none)
//   cps / lps text characters / tool lines per second         answer    seconds before the host answers (default 1.5)
// The host runs in a Web Worker, as native runs outside the WebView: the page's heap holds only what the renderer
// keeps, and every push is copied across (structured clone) like the native bridge's evaluateJavaScript.
// It also records what the measurements need in `window.__aaPerf` (see .local-dev/v3poc/web/perf/).
import type { HostMessage } from '@protocol/bridge'
import type { AssistantMessage, Control, Message, PendingRequest, Session, UserMessage, WatchEvent } from '@protocol/timeline'

export interface StressConfig {
  items: number
  chars: number
  hz: number
  parallel: number
  snapshot: number
  lines: number
  diffLines: number
  approveEvery: number
  cps: number
  lps: number
  answer: number
}

/** Everything the host does, in one self-contained function: it is stringified into the worker (no outer references). */
function stressWorker(spec: string) {
  const c = parseStress(spec)
  const perf = { feed: { finished: 0, pushes: 0 }, hostItems: 0 }
  const report = () => self.postMessage({ kind: 'stats', feed: perf.feed, hostItems: perf.hostItems })
  setInterval(report, 1000)
  const timed = (m: HostMessage, snapshot = false) => self.postMessage({ kind: 'host', message: m, sentAt: performance.timeOrigin + performance.now(), snapshot })
  function parseStress(spec: string): StressConfig {
    const c: StressConfig = { items: 3000, chars: 3000, hz: 30, parallel: 3, snapshot: 0, lines: 2000, diffLines: 300, approveEvery: 40, cps: 1500, lps: 150, answer: 1.5 }
    const keys: Record<string, keyof StressConfig> = { difflines: 'diffLines', approve: 'approveEvery' }
    for (const pair of spec.split(',')) {
      const [k, v] = pair.split(':')
      const n = Number(v)
      const key = (keys[k] ?? k) as keyof StressConfig
      if (key in c && Number.isFinite(n)) c[key] = n
    }
    c.hz = Math.max(0.5, c.hz)
    c.parallel = Math.max(1, c.parallel)
    return c
  }

  // ── content (StressContent.swift) ───────────────────────────────────────────────────────────────────────────────

  function rng(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const WORDS = ['会话', '同步', '渲染', '整条替换', '推送', '连接器', '审批', '快照', '缓存', 'WebView', 'React', 'Markdown', 'Timeline', 'seq', 'control', 'watch', '队列', '回压', '增量', '高亮', '虚拟化', '布局', '滚动', '内存']

  function codeLine(lang: string, n: number) {
    switch (lang) {
      case 'swift':
        return `    let value${n} = try await client.watch(id: "s-${n}").first { $0.type == .snapshot } // ${n}`
      case 'typescript':
        return `  const item${n}: Message = { id: \`m-${n}\`, seq: ${n}, done: false, parts: [{ type: 'text', text: '' }] }`
      case 'python':
        return `    result_${n} = await store.get(session_id="s-${n}", limit=${n * 3})  # noqa: E501`
      case 'go':
        return `\tif err := router.Forward(ctx, frame${n}); err != nil { return fmt.Errorf("forward %d: %w", ${n}, err) }`
      case 'rust':
        return `    let frame_${n} = codec.decode(&mut buf).map_err(|e| Error::Frame(${n}, e))?;`
      default:
        return `SELECT id, seq, payload FROM items WHERE session_id = 's-${n}' AND seq > ${n} ORDER BY seq LIMIT 100;`
    }
  }

  function terminalLine(n: number) {
    switch (n % 5) {
      case 0:
        return `tests/test_module_${Math.floor(n / 5)}.py::test_case_${n} PASSED                                    [${n % 100}%]`
      case 1:
        return `  Compiling crate-${n} v0.${n % 10}.${n % 7} (/srv/build/crate-${n})`
      case 2:
        return `2026-11-17T10:${String(n % 60).padStart(2, '0')}:00Z INFO  router: forwarded frame seq=${n} bytes=${(n * 37) % 9000}`
      case 3:
        return `\u001b[32mok\u001b[0m   step ${n}: applied migration v2_${n % 50} in ${n % 300}ms`
      default:
        return `warning: unused variable \`tmp_${n}\` --> src/lib.rs:${n}:${n % 80}`
    }
  }

  const fileLines = (count: number, offset: number) =>
    Array.from({ length: count }, (_, i) => `${offset + i + 1}\t${codeLine(['python', 'swift', 'typescript'][i % 3], offset + i)}`).join('\n')

  type Step = { kind: 'text'; message: AssistantMessage } | { kind: 'tool'; message: AssistantMessage; pending: boolean } | { kind: 'whole'; message: Message }

  class Content {
    private r: () => number
    constructor(
      private c: StressConfig,
      seed: number,
    ) {
      this.r = rng(seed)
    }

    sentence(count: number) {
      return Array.from({ length: count }, () => WORDS[Math.floor(this.r() * WORDS.length)]).join(' ') + '。'
    }

    markdown(chars: number, index: number) {
      let out = `## 第 ${index} 段分析\n\n`
      let block = 0
      while (out.length < chars) {
        switch (block % 9) {
          case 0:
            out += `${this.sentence(24)} 包含 \`inline_code_${block}\` 和 **加粗** 以及 *斜体*。\n\n`
            break
          case 1:
            out += [1, 2, 3, 4, 5, 6].map((i) => `- 第 ${i} 点：${this.sentence(10)}`).join('\n') + '\n\n'
            break
          case 2: {
            const lang = ['swift', 'typescript', 'python', 'go', 'rust', 'sql'][index % 6]
            out += '```' + lang + '\n' + Array.from({ length: 40 }, (_, i) => codeLine(lang, i)).join('\n') + '\n```\n\n'
            break
          }
          case 3:
            out += '| 列 A | 列 B | 列 C | 列 D | 列 E | 列 F | 列 G | 列 H |\n|---|---|---|---|---|---|---|---|\n'
            out += Array.from({ length: 12 }, (_, r) => `| r${r} ` + Array.from({ length: 7 }, (_, k) => `| 单元格内容 ${r}-${k} 比较长一些`).join('') + ' |').join('\n') + '\n\n'
            break
          case 4:
            out += `> ${this.sentence(30)}\n> ${this.sentence(12)}\n\n`
            break
          case 5:
            out += `### 小节 ${block}\n\n1. ${this.sentence(8)}\n2. ${this.sentence(9)}\n3. ${this.sentence(7)}\n\n`
            break
          case 6:
            out += index % 5 === 0 ? '$$\n\\sum_{i=0}^{n} x_i^2 = \\int_0^1 f(t)\\,dt\n$$\n\n' : `${this.sentence(20)}\n\n`
            break
          case 7:
            out += index % 7 === 0 ? '```mermaid\ngraph TD\n  A[watch] --> B[snapshot]\n  B --> C[message]\n  C --> D[render]\n```\n\n' : `${this.sentence(16)}\n\n`
            break
          default:
            out += `${this.sentence(40)}\n\n`
        }
        block++
      }
      return out
    }

    user(t: number): UserMessage {
      const parts: UserMessage['parts'] = [{ type: 'text', text: `第 ${t} 轮：继续，把剩下的步骤做完，顺便把测试补齐。` }]
      if (t % 3 === 0) {
        parts.push({ type: 'image', path: `/tmp/shot-${t}.png`, name: `截图-${t}.png`, mime: 'image/png', size: 182_000 })
        parts.push({ type: 'file', path: `/tmp/log-${t}.txt`, name: `日志-${t}.txt`, mime: 'text/plain', size: 48_000 })
      }
      return { id: `m-st${t}-u`, role: 'user', created_at: '', seq: 0, done: true, rewindable: true, parts }
    }

    turn(t: number, userId: string, approve: () => boolean): Step[] {
      let n = 0
      const next = () => ++n
      const assistant = (id: number, part: AssistantMessage['parts'][0], done = true): AssistantMessage => ({ id: `m-st${t}-${id}`, role: 'assistant', turn_id: userId, created_at: '', seq: 0, done, parts: [part] })
      const steps: Step[] = []
      steps.push({ kind: 'text', message: assistant(next(), { type: 'thinking', text: `${this.sentence(60)}\n\n${this.sentence(80)}` }) })
      const planId = next()
      const entries = ['读取相关代码', '修改同步逻辑', '补充测试', '跑测试', '整理结论'].map((x, i) => `步骤 ${i + 1}：${x}`)
      const plan = (doneCount: number, final: boolean) =>
        assistant(planId, { type: 'plan', entries: entries.map((content, i) => ({ content, status: i < doneCount ? 'completed' : i === doneCount ? 'in_progress' : 'pending' })) }, final)
      steps.push({ kind: 'whole', message: plan(0, false) })
      const kinds = ['execute', 'read', 'text', 'search', 'edit', 'execute-fail', 'text', 'subagent']
      kinds.forEach((kind, k) => {
        const callId = `call-st${t}-${k}`
        if (kind === 'execute' || kind === 'execute-fail') {
          const failed = kind === 'execute-fail'
          const output =
            Array.from({ length: failed ? Math.floor(this.c.lines / 4) : this.c.lines }, (_, i) => terminalLine(i + k * 7)).join('\n') + (failed ? '\nError: process exited with code 1' : '')
          const command = failed ? 'uv run pytest tests/ -q -x' : 'cargo test --workspace -- --nocapture'
          steps.push({ kind: 'tool', pending: approve(), message: assistant(next(), { type: 'tool', id: callId, title: command, kind: 'execute', status: failed ? 'failed' : 'completed', input: { command }, output }) })
        } else if (kind === 'read') {
          const path = `server/agent_server/services/module_${t % 40}.py`
          steps.push({
            kind: 'tool',
            pending: false,
            message: assistant(next(), { type: 'tool', id: callId, title: `Read ${path}`, kind: 'read', status: 'completed', input: { path }, output: fileLines(Math.floor(this.c.lines / 2), t), locations: [{ path, line: 1 }] }),
          })
        } else if (kind === 'search') {
          const output = Array.from({ length: 200 }, (_, i) => `services/module_${i % 40}.py:${i * 3 + 1}: state.unread = state.latest_seq > ${i}`).join('\n')
          steps.push({ kind: 'tool', pending: false, message: assistant(next(), { type: 'tool', id: callId, title: 'rg -n "unread" server/', kind: 'search', status: 'completed', input: { pattern: 'unread' }, output }) })
        } else if (kind === 'edit') {
          const path = `server/agent_server/services/module_${t % 40}.py`
          steps.push({
            kind: 'whole',
            message: assistant(next(), { type: 'tool', id: callId, title: `Edit ${path}`, kind: 'edit', status: 'completed', input: { path }, diffs: [{ path, old_text: fileLines(this.c.diffLines, t), new_text: fileLines(this.c.diffLines, t + 1) }] }),
          })
          steps.push({ kind: 'whole', message: plan(2, false) })
        } else if (kind === 'subagent') {
          const partId = `sub-st${t}`
          const sub = assistant(next(), { type: 'subagent', id: partId, title: '检查其他调用方', description: '在代码库里找出所有写未读状态的地方', agent_type: 'explore', status: 'running', started_at: '2026-11-17T10:00:00Z', tool_count: 4, parts: [] }, false)
          steps.push({ kind: 'whole', message: sub })
          for (let s = 0; s < 4; s++) {
            const child =
              s % 2 === 0
                ? assistant(next(), { type: 'tool', id: `${callId}-${s}`, title: `Read services/module_${s}.py`, kind: 'read', status: 'completed', output: fileLines(80, s) })
                : assistant(next(), { type: 'text', text: this.sentence(40) })
            child.subagent_id = partId
            steps.push(s % 2 === 0 ? { kind: 'tool', message: child, pending: false } : { kind: 'text', message: child })
          }
          steps.push({
            kind: 'whole',
            message: { ...sub, done: true, parts: [{ type: 'subagent', id: partId, title: '检查其他调用方', agent_type: 'explore', status: 'completed', started_at: '2026-11-17T10:00:00Z', ended_at: '2026-11-17T10:00:09Z', tool_count: 4, parts: [], result: this.sentence(30) }] },
          })
        } else {
          steps.push({ kind: 'text', message: assistant(next(), { type: 'text', text: this.markdown(this.c.chars, t * 10 + k) }) })
        }
      })
      steps.push({ kind: 'whole', message: plan(5, true) })
      return steps
    }
  }

  // ── host (MockSessionsClient.runStress) ─────────────────────────────────────────────────────────────────────────

  interface Growing {
    message: AssistantMessage
    field: 'text' | 'output'
    full: string
    shown: number
    perTick: number
    requestId?: string
  }

  const now = () => new Date().toISOString()
  const messages = new Map<string, Message>()
  const position = new Map<string, number>()
  const ordered: Message[] = []
  let nextSeq = 0
  const session: Session = {
    id: 's-stress',
    title: '压力测试：长会话高频推送',
    agent: 'codex',
    device: { id: 'dev-mbp', name: 't4wefan 的 MacBook Pro' },
    cwd: '~/code/github/Agents-Anywhere',
    branch: 'stress/long-session',
    created_at: now(),
    updated_at: now(),
    message_count: 0,
    config: [],
  }
  let control: Control = { state: 'running', steer: 'native', pending: [], queued: [], answered: [] }
  /** Give an item its position the first time its id appears, as the protocol says. */
  const stamp = (m: Message): Message => {
    const prev = messages.get(m.id)
    const item = { ...m, seq: prev ? prev.seq : nextSeq++, created_at: prev ? prev.created_at : now() } as Message
    if (!prev) position.set(m.id, ordered.push(item) - 1)
    else ordered[position.get(m.id)!] = item
    messages.set(m.id, item)
    perf.hostItems = messages.size
    return item
  }

  // snapshot:n — n finished items already there.
  const content = new Content(c, 0xf111)
  let turn = 0
  while (ordered.length < c.snapshot) {
    const user = stamp(content.user(turn))
    for (const s of content.turn(turn, user.id, () => false)) stamp(s.message)
    turn++
  }
  timed({ type: 'watch', events: [{ type: 'snapshot', session, messages: [...ordered], has_more: false, control }] }, true)

  const pending = new Set<string>()
  const answer = (request_id: string, option_id: string) => {
    if (!pending.delete(request_id)) return
    control = {
      ...control,
      pending: control.pending.filter((p) => p.request_id !== request_id),
      answered: [...(control.answered ?? []), { request_id, by: 't4wefan', device: 'iPhone', option_id, at: now() }].slice(-20),
    }
    timed({ type: 'watch', events: [{ type: 'control', control }] })
  }

  const feed = new Content(c, 0x5eed)
  const queue: Step[] = []
  const growing: Growing[] = []
  let stepCount = 0
  const interval = 1000 / c.hz
  const tick = () => {
    const events: WatchEvent[] = []
    const push = (m: Message) => {
      events.push({ type: 'message', message: stamp(m) })
      perf.feed.pushes++
    }
    while (growing.length < c.parallel && perf.feed.finished < c.items) {
      if (!queue.length) {
        const user = feed.user(turn)
        push(user)
        perf.feed.finished++
        queue.push(...feed.turn(turn, user.id, () => c.approveEvery > 0 && ++stepCount % c.approveEvery === 0))
        turn++
      }
      const step = queue.shift()!
      if (step.kind === 'whole') {
        push(step.message)
        if (step.message.done) perf.feed.finished++
      } else if (step.kind === 'text') {
        const p = step.message.parts[0]
        growing.push({ message: step.message, field: 'text', full: p.type === 'text' || p.type === 'thinking' ? p.text : '', shown: 0, perTick: (c.cps * interval) / 1000 })
      } else {
        const p = step.message.parts[0]
        const g: Growing = { message: step.message, field: 'output', full: p.type === 'tool' && typeof p.output === 'string' ? p.output : '', shown: 0, perTick: (c.lps * 70 * interval) / 1000 }
        if (step.pending && p.type === 'tool') {
          const request: PendingRequest = {
            request_id: `req-${step.message.id}`,
            message_id: step.message.id,
            tool_call_id: p.id,
            title: p.title,
            options: [
              { id: 'allow', name: '允许', kind: 'allow_once' },
              { id: 'always', name: '本会话都允许', kind: 'allow_always' },
              { id: 'reject', name: '拒绝', kind: 'reject_once' },
            ],
          }
          g.requestId = request.request_id
          pending.add(request.request_id)
          push({ ...step.message, done: false, parts: [{ ...p, status: 'pending', output: undefined }] })
          control = { ...control, state: 'running', pending: [...control.pending, request] }
          events.push({ type: 'control', control })
          if (c.answer >= 0) setTimeout(() => answer(request.request_id, 'allow'), c.answer * 1000)
        }
        growing.push(g)
      }
    }
    for (const g of growing) {
      if (g.requestId) {
        if (pending.has(g.requestId)) continue
        g.requestId = undefined
      }
      g.shown += g.perTick * (0.8 + Math.random() * 0.4)
      const n = Math.floor(g.shown)
      if (n < g.full.length) {
        const part = { ...g.message.parts[0], [g.field]: g.full.slice(0, n), ...(g.field === 'output' ? { status: 'in_progress' } : {}) } as AssistantMessage['parts'][0]
        push({ ...g.message, done: false, parts: [part] })
      } else {
        push(g.message)
        perf.feed.finished++
        g.shown = Infinity
      }
    }
    for (let i = growing.length - 1; i >= 0; i--) if (growing[i].shown === Infinity && !growing[i].requestId) growing.splice(i, 1)
    if (events.length) timed({ type: 'watch', events })
    if (perf.feed.finished >= c.items && !growing.length) {
      control = { ...control, state: 'idle' }
      timed({ type: 'watch', events: [{ type: 'control', control }] })
      return
    }
    setTimeout(tick, interval)
  }
  if (c.items > 0) setTimeout(tick, interval)

  self.onmessage = (e: MessageEvent) => {
    const m = e.data as { kind: 'answer'; request_id: string; option_id: string } | { kind: 'older'; before_seq: number }
    if (m.kind === 'answer') answer(m.request_id, m.option_id)
    else {
      // `list_messages({before_seq})`: up to 100 items before it, extended to the start of the turn the boundary cuts.
      const before = ordered.filter((x) => x.seq < m.before_seq)
      let from = Math.max(0, before.length - 100)
      while (from > 0 && before[from].role !== 'user') from--
      self.postMessage({ kind: 'older', messages: before.slice(from), has_more: from > 0 })
    }
  }
}
/** Where the measurements go; read by the perf harness. */
export interface PerfLog {
  /** receive() → the frame after it painted, per receive, in ms: [at, ms]. */
  paint: [number, number][]
  /** Frame intervals in ms. */
  frames: number[]
  snapshotPainted?: number
  feed: { finished: number; pushes: number }
  hostItems: number
}

declare global {
  interface Window {
    __aaPerf?: PerfLog
  }
}

export function startStressHost(spec: string, receive: (m: HostMessage) => void) {
  const perf: PerfLog = { paint: [], frames: [], feed: { finished: 0, pushes: 0 }, hostItems: 0 }
  window.__aaPerf = perf
  // Frame pacing (dropped frames): the gaps between animation frames.
  let lastFrame = performance.now()
  const frame = (t: number) => {
    perf.frames.push(t - lastFrame)
    lastFrame = t
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  const worker = new Worker(URL.createObjectURL(new Blob([`(${stressWorker.toString()})(${JSON.stringify(spec)})`], { type: 'text/javascript' })))
  worker.onmessage = (e: MessageEvent) => {
    const d = e.data
    if (d.kind === 'stats') {
      perf.feed = d.feed
      perf.hostItems = d.hostItems
    } else if (d.kind === 'older') receive({ type: 'older', messages: d.messages, has_more: d.has_more })
    else if (d.kind === 'host') {
      // Sent → received (the copy) → applied → the frame after it painted.
      receive(d.message)
      requestAnimationFrame(() => {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => {
          const ms = performance.timeOrigin + performance.now() - d.sentAt
          perf.paint.push([performance.now(), ms])
          if (d.snapshot && perf.snapshotPainted === undefined) perf.snapshotPainted = ms
        }
        ch.port2.postMessage(0)
      })
    }
  }
  return {
    answer: (request_id: string, option_id: string) => worker.postMessage({ kind: 'answer', request_id, option_id }),
    older: (before_seq: number) => worker.postMessage({ kind: 'older', before_seq }),
  }
}
