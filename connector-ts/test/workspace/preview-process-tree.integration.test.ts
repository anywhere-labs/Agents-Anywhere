// Port preview against real processes: a fake Agent process starts a dev server, an unrelated process listens too,
// and the device decides `preview.open` from this machine's real listening ports and process tree.
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CommandHandlerContext } from '../../src/application/inbound/index.js'
import { sessionHintsSource } from '../../src/entry/preview.js'
import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { PrintedUrls, previewHost, type PreviewSpec, type PreviewTransport } from '../../src/workspace/index.js'
import { FakeAcpAgent } from '../support/fake-acp-agent.js'

const SERVER = "require('http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"
// The fake Agent: starts the dev server as its child and reports its port, like a tool call running `npm run dev`.
const AGENT = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SERVER)}], { stdio: ['ignore', 'pipe', 'inherit'] }); c.stdout.pipe(process.stdout); setInterval(() => {}, 1000)`

class FakeTransport implements PreviewTransport {
  readonly previews: PreviewSpec[] = []
  async open(spec: PreviewSpec): Promise<void> { this.previews.push(spec) }
  async close(): Promise<boolean> { return false }
  async closePort(): Promise<string[]> { return [] }
  async closeAll(): Promise<void> {}
  openPreviews(): readonly PreviewSpec[] { return this.previews }
}

/** Starts `script` in its own process group and resolves with it and the first line it prints (a port). */
function start(script: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    createInterface({ input: child.stdout! }).once('line', line => resolve({ child, port: Number(line) }))
  })
}

const stopGroup = (child: ChildProcess | undefined): void => {
  try {
    if (child?.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

const dialect: AcpDialect = { runtime: 'acp:fake', clientCapabilities: () => ({}), capabilities: () => [], steer: 'none' }
const ctx = { commandId: 'c', inputDigest: null, actor: 'user' } as unknown as CommandHandlerContext

describe.skipIf(process.platform === 'win32')('port preview session association on this machine', () => {
  let agentProcess: { child: ChildProcess; port: number }
  let unrelated: { child: ChildProcess; port: number }
  let handle: AcpRuntimeHandle

  beforeAll(async () => {
    agentProcess = await start(AGENT)
    unrelated = await start(SERVER)
    // The Runtime's adapter process is the fake Agent: ACP runs in memory, the pid is the real process.
    const connect = peerConnection(new FakeAcpAgent().clientPeer, dialect)
    handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'fake', dialect, connect: async () => Object.assign(await connect(), { pid: agentProcess.child.pid! }) })
    await handle.open({ kind: 'new', spec: { cwd: process.cwd() } }, { sessionId: 'ses_agent', replay: 'none' })
  }, 30_000)

  afterAll(async () => {
    await handle?.stop()
    stopGroup(agentProcess?.child)
    stopGroup(unrelated?.child)
  })

  it('previews the port the session\'s Agent started and refuses an unrelated one', async () => {
    const transport = new FakeTransport()
    const events: Record<string, unknown>[] = []
    const host = previewHost({
      frpcPath: null,
      dataDir: '/nonexistent',
      deviceId: () => 'dev_1',
      transport,
      hints: sessionHintsSource({ agents: async () => handle.agentProcesses(), terminals: () => [], printed: new PrintedUrls(), isSession: () => true }),
      intervalMs: 60_000,
      refreshMs: 60_000,
    })
    try {
      host.onLink({ attach: { emit: (_method, payload) => events.push(payload) } })
      const open = (previewId: string, port: number) => host.commands['preview.open']!({ previewId, slug: previewId, port, frpToken: 't', tokenExpiresAt: 'z', frpsAddr: 'frps:7000' }, ctx)
      await expect(open('prv_agent', agentProcess.port)).resolves.toEqual({ previewId: 'prv_agent', port: agentProcess.port, localIP: '127.0.0.1' })
      await expect(open('prv_other', unrelated.port)).rejects.toMatchObject({ code: 'preview_port_not_allowed', details: { port: unrelated.port, reason: 'not_session' } })
      expect(transport.previews.map(preview => preview.port)).toEqual([agentProcess.port])

      for (let i = 0; i < 100 && events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50))
      const ports = (events[0]?.ports ?? []) as { port: number; sessionId: string | null }[]
      expect(ports.find(entry => entry.port === agentProcess.port)?.sessionId).toBe('ses_agent')
      expect(ports.find(entry => entry.port === unrelated.port)?.sessionId).toBeNull()
    } finally {
      await host.close()
    }
  }, 30_000)
})
