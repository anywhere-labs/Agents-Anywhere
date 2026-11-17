// In-process fake Pi (behaviour of the patched @openma/pi-acp): adds Pi's `_meta.pi` (approval guard loaded, session file location),
// guard status updates and form requests on top of FakeAcpAgent. One instance per connection, recording the session-specific environment it connected with.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { peerConnection, type AcpConnection } from '../../src/runtime/acp/handle.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { GUARD } from '../../src/runtime/profiles/pi/dialect.js'
import { FakeAcpAgent, type Json } from './fake-acp-agent.js'

export interface PiWorld {
  /** One fake Agent per connection (= one Pi process), in order. */
  readonly agents: FakePiAgent[]
  /** Environment variables of each connection. */
  readonly environments: Record<string, string>[]
  /** Native files of new sessions are written here (`<sessionsDir>/<id>.jsonl`). */
  readonly sessionsDir: string
  /** Newly created fake Agents are handed to the test for further setup. */
  configure: (agent: FakePiAgent) => void
  guardLoaded: boolean
  /** Like the SDK bridge, reports the write status when opening the pinned file (digest matches, no conflict). */
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

  /** The guard reports that this turn has started (before model output). */
  started(sessionId: string): void {
    this.update(sessionId, { sessionUpdate: 'session_info_update', _meta: { pi: { event: 'status', key: 'aa-prompt-started', text: 'started' } } })
  }

  /** The guard requests tool approval (ctx.ui.confirm -> form). */
  confirmTool(sessionId: string, tool: { id: string; name: string; input: Json }): Promise<Json> {
    return this.ask('elicitation/create', {
      mode: 'form', sessionId, message: `AA_TOOL_PERMISSION\n${JSON.stringify(tool)}\n\n`,
      requestedSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] },
    })
  }

  /** The guard requests plan review (ctx.ui.input). */
  reviewPlan(sessionId: string, toolCallId: string, markdown: string): Promise<Json> {
    return this.ask('elicitation/create', {
      mode: 'form', sessionId, message: `AA_PLAN_REVIEW\n${toolCallId}`,
      requestedSchema: { type: 'object', properties: { value: { type: 'string', title: 'x', description: markdown } }, required: ['value'] },
    })
  }

  /** Writes the session to a native file like Pi does (version 3 header + entries). */
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
