// S7 direct route: drive DSH's own automation ACP (`dsh --profile acp`) with a scripted model.
// Needs a DSH build, so it only runs when asked:
//   AA_DSH_ACP_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js corepack yarn test   (a local install)
//   AA_DSH_ACP_E2E=1 corepack yarn test                                      (npx @deepseek-ai/dsh@0.2.2-rc.3)
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { startMockMessagesLlm, type MockMessagesLlm } from '../../fixtures/mock-messages-llm.js'
import { DshProvider } from '../../../src/runtime/profiles/dsh/provider.js'
import type { RuntimeEvent } from '../../../src/application/ports/runtime-session.js'

const DSH_VERSION = '0.2.2-rc.3'
const bin = process.env.AA_DSH_ACP_BIN
const enabled = Boolean(bin) || process.env.AA_DSH_ACP_E2E === '1'

interface Peer { child: ChildProcess, conn: acp.ClientSideConnection, updates: acp.SessionNotification[] }

describe.skipIf(!enabled)('S7 direct route: dsh --profile acp', () => {
  let home: string
  let workspace: string
  let llm: MockMessagesLlm
  const peers: Peer[] = []

  function start(): Peer {
    const command = bin ? process.execPath : 'npx'
    const args = bin ? [bin, '--profile', 'acp'] : ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', 'acp']
    const child = spawn(command, args, {
      // Credentials come from the launching environment; a key stored in $DSH_HOME would win (S7 finding).
      env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: llm.url },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const updates: acp.SessionNotification[] = []
    const conn = new acp.ClientSideConnection(() => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async params => { updates.push(params) },
    }), acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>))
    const peer = { child, conn, updates }
    peers.push(peer)
    return peer
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'aa-dsh-acp-home-'))
    workspace = await mkdtemp(join(tmpdir(), 'aa-dsh-acp-ws-'))
    llm = await startMockMessagesLlm(() => ({ text: 'pong from mock' }))
  })

  afterAll(async () => {
    for (const peer of peers) peer.child.kill('SIGKILL')
    await llm.close()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  test('advertises the automation-only surface', { timeout: 120_000 }, async () => {
    const { conn } = start()
    const init = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(1)
    expect(init.agentInfo?.name).toBe('deepseek-harness-acp')
    expect(init.agentCapabilities?.loadSession ?? false).toBe(false)
    expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({ close: {}, list: {}, resume: {} })
    expect(init.authMethods).toEqual([])
    const session = await conn.newSession({ cwd: workspace, mcpServers: [] })
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(session.configOptions?.map(option => option.id)).toEqual(['model', 'reasoning_effort'])
  })

  test('runs a prompt, rejects empty and concurrent prompts, and hides its own active sessions', { timeout: 120_000 }, async () => {
    const { conn, updates } = start()
    await conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await conn.newSession({ cwd: workspace, mcpServers: [] })
    const result = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'ping' }] })
    expect(result.stopReason).toBe('end_turn')
    // Whole committed message, not token deltas.
    const chunks = updates.filter(item => item.sessionId === sessionId && item.update.sessionUpdate === 'agent_message_chunk')
    expect(chunks.map(item => (item.update as { content: { text: string } }).content.text)).toEqual(['pong from mock'])
    expect(llm.requests.at(-1)?.url).toMatch(/\/v1\/messages$/)

    await expect(conn.prompt({ sessionId, prompt: [] })).rejects.toMatchObject({ code: -32602 })
    const release = llm.hold()
    const running = conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'slow' }] })
    await expect(conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] })).rejects.toMatchObject({ code: -32602 })
    release()
    await expect(running).resolves.toMatchObject({ stopReason: 'end_turn' })
    const listed = await conn.listSessions({})
    expect(listed.sessions.some(item => item.sessionId === sessionId)).toBe(false)
  })

  test('one writer per session: another process cannot resume until the holder closes it', { timeout: 120_000 }, async () => {
    const a = start()
    const b = start()
    await a.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await b.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await a.conn.newSession({ cwd: workspace, mcpServers: [] })
    await a.conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'hold' }] })
    expect((await b.conn.listSessions({})).sessions.some(item => item.sessionId === sessionId)).toBe(true)
    // No distinguishing code: the write lock surfaces as a generic internal error.
    await expect(b.conn.resumeSession({ sessionId, cwd: workspace, mcpServers: [] })).rejects.toMatchObject({ code: -32603 })
    await a.conn.closeSession({ sessionId })
    await b.conn.resumeSession({ sessionId, cwd: workspace, mcpServers: [] })
    const before = llm.requests.length
    await b.conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] })
    // Resume keeps the model history even though it replays nothing to the client.
    const messages = llm.requests[before]!.body.messages as unknown[]
    expect(messages.length).toBeGreaterThanOrEqual(3)
    expect(b.updates.filter(item => item.sessionId === sessionId && item.update.sessionUpdate === 'user_message_chunk')).toEqual([])
    // A killed holder releases the lock.
    b.child.kill('SIGKILL')
    await new Promise(resolve => b.child.once('exit', resolve))
    await a.conn.resumeSession({ sessionId, cwd: workspace, mcpServers: [] })
  })

  test('the provider runs DSH on B\'s ACP engine: one turn at a time, and the lock is released on close', { timeout: 180_000 }, async () => {
    const provider = new DshProvider({ env: { ...process.env, DSH_HOME: home }, cwd: workspace })
    const settings = bin ? { command: process.execPath, args: [bin], model: { apiKey: 'sk-test', baseUrl: llm.url } }
      : { model: { apiKey: 'sk-test', baseUrl: llm.url } }
    const facts = await provider.discover(settings)
    expect(facts.installed).toBe(true)
    const runtime = await provider.start({ runtimeId: 'dsh', settings })
    try {
      const session = await runtime.open({ kind: 'new', spec: { cwd: workspace } }, { sessionId: 'sess_e2e', replay: 'none' })
      expect(session.routeKind).toBe('direct')
      const events: RuntimeEvent[] = []
      void (async () => { for await (const event of session.events) events.push(event) })()
      const release = llm.hold()
      // DSH confirms a prompt only by working on it: acceptance waits for the held model.
      const first = session.prompt({ text: 'one' }, { deliveryId: 'd1', clientMessageId: 'c1' })
      for (let n = 0; n < 100 && !events.some(event => event.type === 'turn.started'); n++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(await session.prompt({ text: 'two' }, { deliveryId: 'd2', clientMessageId: 'c2' })).toMatchObject({ outcome: 'rejected', error: { code: 'session_busy' } })
      release()
      expect((await first).outcome).toBe('accepted')
      for (let n = 0; n < 600 && !events.some(event => event.type === 'turn.ended'); n++) await new Promise(resolve => setTimeout(resolve, 50))
      expect(events.filter(event => event.type === 'message.completed' && event.role === 'assistant').map(event => event.type === 'message.completed' && event.text))
        .toEqual(['pong from mock'])
      const id = session.nativeSessionId
      await session.close()
      // Another process can take the session once the direct route closed it.
      const other = start()
      await other.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })
      await other.conn.resumeSession({ sessionId: id, cwd: workspace, mcpServers: [] })
    } finally { await runtime.stop() }
  })
})
