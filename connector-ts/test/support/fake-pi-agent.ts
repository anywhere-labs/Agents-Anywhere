// 进程内的假 Pi（@openma/pi-acp 补丁后的行为）：在 FakeAcpAgent 上加 Pi 的 `_meta.pi`（审批守卫已载入、会话文件位置）、
// 守卫的状态更新与表单请求。每个连接一个实例，记下连接时带的会话专属环境变量。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { peerConnection, type AcpConnection } from '../../src/runtime/acp/handle.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { GUARD } from '../../src/runtime/profiles/pi/dialect.js'
import { FakeAcpAgent, type Json } from './fake-acp-agent.js'

export interface PiWorld {
  /** 每次连接（= 一个 Pi 进程）一个假 Agent，按顺序。 */
  readonly agents: FakePiAgent[]
  /** 每次连接带的环境变量。 */
  readonly environments: Record<string, string>[]
  /** 新会话的原生文件写在这里（`<sessionsDir>/<id>.jsonl`）。 */
  readonly sessionsDir: string
  /** 新建的假 Agent 交给测试再配置。 */
  configure: (agent: FakePiAgent) => void
  guardLoaded: boolean
  /** 像 SDK bridge 一样在打开钉住的文件时报告写入状态（摘要一致、没有冲突）。 */
  bridgeReports: boolean
}

export class FakePiAgent extends FakeAcpAgent {
  sessionFiles = new Map<string, string>()

  constructor(readonly world: PiWorld, readonly environment: Record<string, string>) {
    super()
    this.configOptions = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'p/m1', options: [{ value: 'p/m1', name: 'M1' }, { value: 'p/m2', name: 'M2' }] },
      { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    ]
    this.initializeResult = {
      ...this.initializeResult,
      agentInfo: { name: 'openma-pi-acp', version: '0.1.8' },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} } },
    }
    const meta = (sessionFile: string | null) => ({
      pi: {
        sessionFile,
        extensions: world.guardLoaded ? [{ path: GUARD }] : [],
        aaLoadingReport: { mandatoryGuard: world.guardLoaded },
      },
    })
    this.peer.onRequest('session/new', params => {
      this.received.push({ method: 'session/new', params: params as Json })
      this.sessions += 1
      const sessionId = `native-${world.agents.length}-${this.sessions}`
      const file = join(world.sessionsDir, `${sessionId}.jsonl`)
      this.sessionFiles.set(sessionId, file)
      return { sessionId, configOptions: this.configOptions, _meta: meta(file) }
    })
    this.peer.onRequest('session/resume', params => {
      this.received.push({ method: 'session/resume', params: params as Json })
      if (world.bridgeReports && environment.AA_PI_WRITE_STATE) {
        writeFileSync(environment.AA_PI_WRITE_STATE, JSON.stringify({ revision: environment.AA_PI_SOURCE_REVISION, conflict: false }))
      }
      const pinned = environment.AA_PI_SESSION_FILE ?? null
      return { configOptions: this.configOptions, _meta: meta(pinned) }
    })
  }

  /** 守卫报告这一轮已开始（模型输出之前）。 */
  started(sessionId: string): void {
    this.update(sessionId, { sessionUpdate: 'session_info_update', _meta: { pi: { event: 'status', key: 'aa-prompt-started', text: 'started' } } })
  }

  /** 守卫请求工具审批（ctx.ui.confirm → 表单）。 */
  confirmTool(sessionId: string, tool: { id: string; name: string; input: Json }): Promise<Json> {
    return this.ask('elicitation/create', {
      mode: 'form', sessionId, message: `AA_TOOL_PERMISSION\n${JSON.stringify(tool)}\n\n`,
      requestedSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] },
    })
  }

  /** 守卫请求计划审阅（ctx.ui.input）。 */
  reviewPlan(sessionId: string, toolCallId: string, markdown: string): Promise<Json> {
    return this.ask('elicitation/create', {
      mode: 'form', sessionId, message: `AA_PLAN_REVIEW\n${toolCallId}`,
      requestedSchema: { type: 'object', properties: { value: { type: 'string', title: 'x', description: markdown } }, required: ['value'] },
    })
  }

  /** 像 Pi 一样把会话写进原生文件（版本 3 的头 + 条目）。 */
  persist(sessionId: string, cwd: string, entries: Json[]): string {
    const file = this.sessionFiles.get(sessionId) ?? this.environment.AA_PI_SESSION_FILE!
    writeHistory(file, sessionId, cwd, entries)
    return file
  }
}

export function writeHistory(file: string, nativeId: string, cwd: string, entries: Json[], version = 3): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const header = { type: 'session', version, id: nativeId, cwd, timestamp: '2026-11-01T00:00:00Z' }
  writeFileSync(file, [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
}

export function piWorld(sessionsDir: string): PiWorld & { connect: (environment: Readonly<Record<string, string>>, dialect: AcpDialect) => Promise<AcpConnection> } {
  const world: PiWorld = { agents: [], environments: [], sessionsDir, configure: () => undefined, guardLoaded: true, bridgeReports: true }
  return Object.assign(world, {
    connect: async (environment: Readonly<Record<string, string>>, dialect: AcpDialect) => {
      const agent = new FakePiAgent(world, { ...environment })
      world.agents.push(agent)
      world.environments.push({ ...environment })
      world.configure(agent)
      return peerConnection(agent.clientPeer, dialect)()
    },
  })
}
