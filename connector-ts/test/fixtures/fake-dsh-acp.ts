// A stand-in for DSH 0.2.2-rc.3's automation ACP (`dsh --profile acp`), covering the
// behaviours the direct route relies on (S7): one prompt per session, empty prompts
// rejected, whole committed messages, random session IDs, write-locked resume.
import * as acp from '@agentclientprotocol/sdk'
import { DshDirectRoute } from '../../src/runtime/profiles/dsh/direct/route.js'

/** Behaves like DSH 0.2.2-rc.3's automation ACP for the parts the direct route relies on. */
export class FakeDshAcp implements acp.Agent {
  conn!: acp.AgentSideConnection
  prompts: { sessionId: string, text: string }[] = []
  private running = new Map<string, () => void>()
  held = new Set<string>()
  closed: string[] = []
  gate: Promise<void> | undefined
  private nextId = 0
  async initialize(): Promise<acp.InitializeResponse> {
    return { protocolVersion: 1, agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] }
  }
  async authenticate() {}
  private options(): acp.SessionConfigOption[] {
    return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [{ value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' }] }] },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }]
  }
  /** Persisted sessions by cwd, newest first, as `session/list` reports them. */
  persisted: { sessionId: string, cwd: string }[] = [{ sessionId: 'cold-1', cwd: '/w' }]
  active = new Set<string>()
  /** Simulates DSH dying after it persisted a new session but before it answered. */
  dropNextNewSession = false
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = `uuid-${++this.nextId}`
    this.persisted.unshift({ sessionId, cwd: params.cwd })
    if (this.dropNextNewSession) { this.dropNextNewSession = false; throw new Error('connection lost') }
    this.active.add(sessionId)
    return { sessionId, configOptions: this.options() }
  }
  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    if (this.held.has(params.sessionId)) throw acp.RequestError.internalError()
    return { configOptions: this.options() }
  }
  async closeSession(params: acp.CloseSessionRequest) { this.closed.push(params.sessionId); this.active.delete(params.sessionId); return {} }
  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return { sessions: this.persisted.filter(item => !this.active.has(item.sessionId) && (!params.cwd || item.cwd === params.cwd)) }
  }
  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const options = this.options().map(option => option.id === params.configId ? { ...option, currentValue: String((params as { value: unknown }).value) } : option)
    return { configOptions: options as acp.SessionConfigOption[] }
  }
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    if (this.running.has(params.sessionId)) throw acp.RequestError.invalidParams(undefined, 'a prompt is already running')
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    if (!text.trim()) throw acp.RequestError.invalidParams(undefined, 'empty prompt')
    this.prompts.push({ sessionId: params.sessionId, text })
    let cancelled = false
    await new Promise<void>(resolve => {
      this.running.set(params.sessionId, () => { cancelled = true; resolve() })
      void (this.gate ?? Promise.resolve()).then(resolve)
    })
    this.running.delete(params.sessionId)
    if (cancelled) return { stopReason: 'cancelled' }
    if (text.includes('needs approval')) {
      const answer = await this.conn.requestPermission({ sessionId: params.sessionId,
        toolCall: { toolCallId: 'call-1', title: 'bash', status: 'pending', kind: 'other' },
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] })
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-perm',
        content: { type: 'text', text: answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled' } } })
      return { stopReason: 'end_turn' }
    }
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', kind: 'other', status: 'in_progress', rawInput: { path: 'a' } } })
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file' } }] } })
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: `m-${this.prompts.length}`, content: { type: 'text', text: `reply to ${text}` } } })
    return { stopReason: 'end_turn' }
  }
  async cancel(params: acp.CancelNotification) { this.running.get(params.sessionId)?.() }
}

export async function startFake() {
  const fake = new FakeDshAcp()
  const a = new TransformStream<Uint8Array, Uint8Array>()
  const b = new TransformStream<Uint8Array, Uint8Array>()
  new acp.AgentSideConnection(conn => { fake.conn = conn; return fake }, acp.ndJsonStream(a.writable, b.readable))
  const route = await DshDirectRoute.start({ plan: { command: 'fake', args: [], source: 'configured' }, env: {}, stream: acp.ndJsonStream(b.writable, a.readable) })
  return { fake, route }
}
