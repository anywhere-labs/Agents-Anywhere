// 进程内的假 ACP Agent：在内存传输的另一端注册处理器，测试按需编排 prompt 的行为。

import { JsonRpcPeer, memoryTransportPair, type RequestContext } from '../../src/runtime/acp/jsonrpc.js'

export type Json = Record<string, unknown>

export interface PromptScript {
  (params: Json, agent: FakeAcpAgent, context: RequestContext): Promise<Json>
}

export class FakeAcpAgent {
  readonly peer: JsonRpcPeer
  readonly clientPeer: JsonRpcPeer
  readonly received: { method: string; params: Json }[] = []
  sessions = 0
  initializeResult: Json = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } },
    agentInfo: { name: 'fake-agent', version: '1.0.0' },
    authMethods: [],
    _meta: { steering: { supported: true } },
  }
  configOptions: Json[] = [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }, { value: 'm2', name: 'Model 2' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ]
  /** 旧的 session modes（session/new 一并返回）。 */
  modes: Json | undefined
  onPrompt: PromptScript = async () => ({ stopReason: 'end_turn' })
  onSteer: (params: Json) => Promise<Json> = async () => ({ outcome: 'injected' })
  cancelled = 0
  history: Json[] = []

  constructor() {
    const [client, agent] = memoryTransportPair()
    this.clientPeer = new JsonRpcPeer(client)
    this.peer = new JsonRpcPeer(agent)
    const record = (method: string) => (params: unknown) => this.received.push({ method, params: (params ?? {}) as Json })
    this.peer.onRequest('initialize', params => {
      record('initialize')(params)
      return this.initializeResult
    })
    this.peer.onRequest('session/new', params => {
      record('session/new')(params)
      this.sessions += 1
      return { sessionId: `native-${this.sessions}`, configOptions: this.configOptions, ...(this.modes ? { modes: this.modes } : {}) }
    })
    this.peer.onRequest('session/resume', params => {
      record('session/resume')(params)
      return { configOptions: this.configOptions }
    })
    this.peer.onRequest('session/load', async params => {
      record('session/load')(params)
      const sessionId = (params as Json).sessionId as string
      for (const update of this.history) this.update(sessionId, update)
      await new Promise(resolve => setTimeout(resolve, 5))
      return { configOptions: this.configOptions }
    })
    this.peer.onRequest('session/list', params => {
      record('session/list')(params)
      return { sessions: [{ sessionId: 'native-old', title: 'Old', cwd: '/w' }] }
    })
    this.peer.onRequest('session/close', params => {
      record('session/close')(params)
      return {}
    })
    this.peer.onRequest('session/set_config_option', params => {
      record('session/set_config_option')(params)
      const { configId, value } = params as Json
      this.configOptions = this.configOptions.map(o => (o.id === configId ? { ...o, currentValue: value } : o))
      return { configOptions: this.configOptions }
    })
    this.peer.onRequest('session/set_mode', params => {
      record('session/set_mode')(params)
      if (this.modes) this.modes = { ...this.modes, currentModeId: (params as Json).modeId }
      return {}
    })
    this.peer.onRequest('session/prompt', (params, context) => {
      record('session/prompt')(params)
      return this.onPrompt(params as Json, this, context)
    })
    this.peer.onRequest('_session/steering', params => {
      record('_session/steering')(params)
      return this.onSteer(params as Json)
    })
    this.peer.onNotification('session/cancel', params => {
      record('session/cancel')(params)
      this.cancelled += 1
    })
  }

  update(sessionId: string, update: Json): void {
    this.peer.notify('session/update', { sessionId, update })
  }

  text(sessionId: string, text: string, messageId?: string): void {
    this.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) })
  }

  ask<T = Json>(method: string, params: Json): Promise<T> {
    return this.peer.request<T>(method, params)
  }
}

export const tick = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
