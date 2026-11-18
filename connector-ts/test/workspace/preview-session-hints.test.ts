import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AcpDialect } from '../../src/runtime/acp/dialect.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { PRINTED_PORTS_MAX, PrintedUrls, RootPolicy, Terminals, sessionHints, stripAnsi, type Pty, type SpawnPty } from '../../src/workspace/index.js'
import { FakeAcpAgent } from '../support/fake-acp-agent.js'

describe('PrintedUrls', () => {
  it('reads coloured dev server output and drops the query', () => {
    const printed = new PrintedUrls()
    printed.observe('ses_a', '  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n')
    printed.observe('ses_b', 'Jupyter at http://127.0.0.1:8888/lab?token=secret\n')
    expect([...printed.mentioned()]).toEqual([
      [5173, { sessionId: 'ses_a', url: 'http://localhost:5173/' }],
      [8888, { sessionId: 'ses_b', url: 'http://127.0.0.1:8888/lab' }],
    ])
  })

  it('finds a URL split between two chunks of one stream, not the cut-off part', () => {
    const printed = new PrintedUrls()
    printed.observe('ses_a', 'ready on http://localhost:51', 'term_1')
    expect(printed.mentioned().size).toBe(0)
    printed.observe('ses_a', '73/app\r\n', 'term_1')
    expect([...printed.mentioned()]).toEqual([[5173, { sessionId: 'ses_a', url: 'http://localhost:5173/app' }]])
    // Another stream's chunk does not complete this one.
    printed.observe('ses_b', 'http://localhost:30', 'term_2')
    printed.observe('ses_b', '00\n', 'term_3')
    expect(printed.mentioned().has(3000)).toBe(false)
  })

  it('lets a later mention take the port and forgets the oldest ports', () => {
    const printed = new PrintedUrls()
    printed.observe('ses_a', 'http://localhost:3000')
    printed.observe('ses_b', 'http://localhost:3000/b')
    expect(printed.mentioned().get(3000)).toEqual({ sessionId: 'ses_b', url: 'http://localhost:3000/b' })
    for (let i = 0; i < PRINTED_PORTS_MAX + 5; i++) printed.observe('ses_c', `http://localhost:${10_000 + i}`)
    expect(printed.mentioned().size).toBe(PRINTED_PORTS_MAX)
    expect(printed.mentioned().has(3000)).toBe(false)
    expect(printed.mentioned().has(10_000 + PRINTED_PORTS_MAX + 4)).toBe(true)
  })

  it('strips OSC hyperlinks and titles', () => {
    expect(stripAnsi('\u001b]8;;http://localhost:1\u0007link\u001b]8;;\u0007 \u001b]0;title\u0007ok')).toBe('link ok')
  })
})

describe('sessionHints', () => {
  it('keeps the first session of a process and skips invalid ones', () => {
    const hints = sessionHints([
      { pid: 100, sessionId: 'busy' },
      { pid: 100, sessionId: 'idle' },
      { pid: 1, sessionId: 'init' },
      { pid: 200, sessionId: '' },
      { pid: 300, sessionId: 'term' },
    ], new Map())
    expect([...hints.roots]).toEqual([[100, 'busy'], [300, 'term']])
  })
})

const dialect: AcpDialect = {
  runtime: 'acp:fake',
  clientCapabilities: () => ({}),
  capabilities: () => [{ id: 'session.send_message', supported: true }],
  steer: 'none',
}

describe('AcpRuntimeHandle.agentProcesses', () => {
  it('lists the adapter process with its sessions, the busy one first', async () => {
    const agent = new FakeAcpAgent()
    let release!: () => void
    agent.onPrompt = () => new Promise(resolve => {
      release = () => resolve({ stopReason: 'end_turn' })
    })
    const connect = peerConnection(agent.clientPeer, dialect)
    const handle = new AcpRuntimeHandle({ type: 'acp:fake', instanceId: 'i1', dialect, connect: async () => Object.assign(await connect(), { pid: 4242 }) })
    expect(handle.agentProcesses()).toEqual([])
    await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'ses_idle', replay: 'none' })
    const busy = await handle.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'ses_busy', replay: 'none' })
    expect(handle.agentProcesses()).toEqual([{ pid: 4242, sessionIds: ['ses_idle', 'ses_busy'] }])
    const turn = busy.prompt({ text: 'go' }, { deliveryId: 'd1', clientMessageId: 'm1' }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handle.agentProcesses()).toEqual([{ pid: 4242, sessionIds: ['ses_busy', 'ses_idle'] }])
    release()
    await turn
    await handle.stop()
  })
})

class FakePty implements Pty {
  public data?: (data: string) => void
  public constructor(public readonly pid: number) {}
  public onData(listener: (data: string) => void): void {
    this.data = listener
  }
  public onExit(): void {}
  public write(): void {}
  public resize(): void {}
  public kill(): void {}
}

describe('Terminals for port preview', () => {
  it('lists the shells of running terminals and passes their output on', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-term-hints-')))
    mkdirSync(join(base, 'home'))
    const ptys: FakePty[] = []
    const spawn: SpawnPty = () => {
      const pty = new FakePty(5000 + ptys.length)
      ptys.push(pty)
      return pty
    }
    const seen: [string, string, string][] = []
    const terminals = new Terminals({ policy: new RootPolicy({ roots: [join(base, 'home')] }), spawn, platform: 'linux', env: { SHELL: '/bin/sh' }, observeOutput: (sessionId, terminalId, text) => seen.push([sessionId, terminalId, text]) })
    try {
      await terminals.create({ root: join(base, 'home'), terminalId: 'term_1', sessionId: 'ses_a' })
      await terminals.create({ root: join(base, 'home'), terminalId: 'term_2', sessionId: 'ses_b' })
      expect(terminals.processes()).toEqual([{ pid: 5000, sessionId: 'ses_a' }, { pid: 5001, sessionId: 'ses_b' }])
      ptys[0]!.data?.('http://localhost:5173/\n')
      expect(seen).toEqual([['ses_a', 'term_1', 'http://localhost:5173/\n']])
      await terminals.close({ terminalId: 'term_2' })
      expect(terminals.processes()).toEqual([{ pid: 5000, sessionId: 'ses_a' }])
    } finally {
      terminals.shutdown()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
