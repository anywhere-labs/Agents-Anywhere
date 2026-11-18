// Agent collaboration adapters: the tool socket and the MCP relay a Runtime starts, ACP tool injection, tool item
// normalization, the agent route allowlist and the peer keyring.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collabToolOf } from '../../src/application/projection.js'
import { parseCollabSettings, effectiveFor } from '../../src/application/collab/index.js'
import { FileAgentPeers } from '../../src/keystore/agent-peers.js'
import { stdioMcpServer, withToolParams } from '../../src/runtime/acp/handle.js'
import { autoApproval } from '../../src/runtime/acp/session.js'
import { agentRouteAllowed } from '../../src/sync/client-api/agent-routes.js'
import { runAgentToolsRelay } from '../../src/tools/mcp-relay.js'
import { AgentToolsSocket } from '../../src/tools/socket.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-tools-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function rpc(input: PassThrough, output: PassThrough, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = new Promise<Record<string, unknown>>(resolve => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n').slice(0, -1)) {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.id === message.id) {
          output.off('data', onData)
          resolve(parsed)
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
    }
    output.on('data', onData)
  })
  input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  return reply
}

describe('the aa tool server relay and the agent-tools socket', () => {
  it('lists the tools, relays calls with the grant secret, and refuses MCP discovery', async () => {
    const seen: { secret: string; tool: string; args: Record<string, unknown> }[] = []
    const socket = new AgentToolsSocket({
      dir,
      calls: {
        call: async (secret, tool, args) => {
          seen.push({ secret, tool, args })
          return secret === 'tok' ? { ok: true, value: { sessionId: 'sess_1' } } : { ok: false, code: 'agent_grant_revoked', message: 'revoked' }
        },
      },
    })
    await socket.start()
    if (process.platform !== 'win32') expect(statSync(socket.endpoint).mode & 0o777).toBe(0o600)
    const input = new PassThrough()
    const output = new PassThrough()
    const done = runAgentToolsRelay({ input, output, env: { AA_AGENT_TOOLS_ENDPOINT: socket.endpoint, AA_AGENT_TOOLS_TOKEN: 'tok' }, version: '9.9.9' })
    expect(await rpc(input, output, { id: 1, method: 'server/discover', params: {} })).toMatchObject({ error: { code: -32601 } })
    expect(await rpc(input, output, { id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toMatchObject({ result: { serverInfo: { name: 'aa', version: '9.9.9' }, capabilities: { tools: {} } } })
    const listed = await rpc(input, output, { id: 3, method: 'tools/list', params: {} })
    const names = ((listed.result as { tools: { name: string }[] }).tools).map(tool => tool.name)
    expect(names).toContain('aa_spawn')
    expect(names).toHaveLength(14)
    const called = await rpc(input, output, { id: 4, method: 'tools/call', params: { name: 'aa_status', arguments: { sessionId: 'sess_1' } } })
    expect(called).toMatchObject({ result: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'sess_1' }) }] } })
    expect(seen).toEqual([{ secret: 'tok', tool: 'aa_status', args: { sessionId: 'sess_1' } }])
    expect(await rpc(input, output, { id: 5, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } })).toMatchObject({ error: { code: -32602 } })
    input.end()
    await done
    await socket.close()
  })

  it('answers every call with agent_tools_unavailable when the session was given no tools', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const done = runAgentToolsRelay({ input, output, env: {}, version: '1' })
    const called = await rpc(input, output, { id: 1, method: 'tools/call', params: { name: 'aa_targets', arguments: {} } })
    expect(called).toMatchObject({ result: { isError: true } })
    expect(JSON.stringify(called)).toContain('agent_tools_unavailable')
    input.end()
    await done
  })
})

describe('tool injection into ACP sessions', () => {
  const server = { name: 'aa', command: '/usr/bin/node', args: ['agent-tools.js'], env: { AA_AGENT_TOOLS_TOKEN: 't' }, autoApprove: true }

  it('maps a tool server to an ACP stdio McpServer and merges dialect parameters deeply', () => {
    expect(stdioMcpServer(server)).toEqual({ name: 'aa', command: '/usr/bin/node', args: ['agent-tools.js'], env: [{ name: 'AA_AGENT_TOOLS_TOKEN', value: 't' }] })
    const merged = withToolParams(
      { cwd: '/w', mcpServers: [], _meta: { claudeCode: { options: { allowedTools: ['Read'] }, other: 1 } } },
      { _meta: { claudeCode: { options: { allowedTools: ['mcp__aa'] } } } },
    )
    expect(merged).toEqual({ cwd: '/w', mcpServers: [], _meta: { claudeCode: { options: { allowedTools: ['Read', 'mcp__aa'] }, other: 1 } } })
  })

  it('answers permission requests of an auto-approved tool server, and only those', () => {
    const options = [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }]
    const selected = { outcome: { outcome: 'selected', optionId: 'yes' } }
    expect(autoApproval({ toolCall: { title: 'mcp.aa.aa_spawn', rawInput: { serverName: 'aa' } }, options }, ['aa'])).toEqual(selected)
    expect(autoApproval({ toolCall: { title: 'x' }, _meta: { claudeCode: { mcpServer: { name: 'aa' } } }, options }, ['aa'])).toEqual(selected)
    expect(autoApproval({ toolCall: { title: 'mcp__aa__aa_send' }, options }, ['aa'])).toEqual(selected)
    expect(autoApproval({ toolCall: { title: 'mcp__aaa__aa_send' }, options }, ['aa'])).toBeUndefined()
    expect(autoApproval({ toolCall: { title: 'Bash', rawInput: { command: 'rm' } }, options }, ['aa'])).toBeUndefined()
    expect(autoApproval({ toolCall: { title: 'mcp__aa__aa_send' }, options }, [])).toBeUndefined()
  })

  it('names a collaboration tool call however the Runtime titles it', () => {
    expect(collabToolOf('mcp__aa__aa_spawn', { cwd: '/w' })).toEqual({ server: 'aa', tool: 'aa_spawn' })
    expect(collabToolOf('mcp.aa.aa_status', { sessionId: 'sess_1' })).toEqual({ server: 'aa', tool: 'aa_status', sessionId: 'sess_1' })
    expect(collabToolOf('aa: aa_read', { sessionId: 'sess_2', deviceId: 'dev_b' })).toEqual({ server: 'aa', tool: 'aa_read', sessionId: 'sess_2', deviceId: 'dev_b' })
    expect(collabToolOf('Read file', {})).toBeNull()
  })
})

describe('collaboration settings and routes', () => {
  it('turns an instance on only when the account and the instance are on', () => {
    const settings = parseCollabSettings({ agentCollaboration: { enabled: true, crossDevice: true, instances: { codex: { enabled: true, crossDevice: false, authority: { interrupt: true } } } } })
    expect(effectiveFor(settings, 'codex')).toMatchObject({ enabled: true, crossDevice: false, authority: { steer: true, interrupt: true, close: true } })
    expect(effectiveFor(settings, 'claude').enabled).toBe(false)
    expect(effectiveFor(parseCollabSettings({}), 'codex').enabled).toBe(false)
  })

  it('lets an Agent caller use only the allowlisted client API routes', () => {
    expect(agentRouteAllowed('POST', ['sessions', 'create-and-start'])).toBe(true)
    expect(agentRouteAllowed('POST', ['sessions', 's', 'runtime', 'messages'])).toBe(true)
    expect(agentRouteAllowed('POST', ['sessions', 's', 'runtime', 'notices', 'n1', 'respond'])).toBe(true)
    expect(agentRouteAllowed('GET', ['sessions', 's', 'plans', 'p1', 'markdown'])).toBe(true)
    expect(agentRouteAllowed('POST', ['runtime-workflows', 'sessions', 's', 'close'])).toBe(true)
    expect(agentRouteAllowed('PATCH', ['sessions', 's', 'runtime', 'selections'])).toBe(false)
    expect(agentRouteAllowed('POST', ['sessions', 's', 'collab', 'supervisions'])).toBe(false)
    expect(agentRouteAllowed('GET', ['connectors', 'dev', 'fs', 'read'])).toBe(false)
  })
})

describe('the collaboration peer keyring', () => {
  it('keeps one identity, pins device keys, and stores them owner-only', async () => {
    const peers = new FileAgentPeers(dir, () => '2026-11-18T00:00:00.000Z')
    const pub = await peers.identityPub()
    expect(Buffer.from(pub, 'base64url')).toHaveLength(32)
    expect(await new FileAgentPeers(dir).identityPub()).toBe(pub)
    const key = Buffer.alloc(32, 7).toString('base64url')
    const pinned = await peers.pin({ deviceId: 'dev_b', identityPub: key, label: 'Studio' })
    expect(pinned).toMatchObject({ deviceId: 'dev_b', identityPub: key, label: 'Studio', pinnedAt: '2026-11-18T00:00:00.000Z' })
    expect(await peers.pinned('dev_b')).toMatchObject({ identityPub: key })
    await expect(peers.pin({ deviceId: 'dev_c', identityPub: 'short', label: '' })).rejects.toMatchObject({ code: 'invalid_argument' })
    if (process.platform !== 'win32') expect(statSync(join(dir, 'trust', 'agent-peers.json')).mode & 0o777).toBe(0o600)
  })
})
