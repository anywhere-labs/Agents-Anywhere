// The injected `aa` tool server (contracts/agent-tools/1.0): a stdio MCP server that lists the collaboration tools
// and relays each call to the Connector's agent-tools socket. It must start fast and have no side effects: Claude
// and DSH first probe it with `server/discover` and then start a second process for the real session.
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { AGENT_TOOLS } from '../generated/agent-tools/v1_0/tools.js'
import { ENDPOINT_ENV, TOKEN_ENV, type ToolCallLine, type ToolReplyLine } from './wire.js'

const PROTOCOL_VERSION = '2025-06-18'

type Json = Record<string, unknown>

export interface RelayOptions {
  readonly input: NodeJS.ReadableStream
  readonly output: NodeJS.WritableStream
  readonly env: NodeJS.ProcessEnv
  readonly version: string
  /** Opens the Connector socket; replaced in tests. */
  readonly dial?: (endpoint: string) => Socket
}

/** Runs the relay until stdin ends. */
export function runAgentToolsRelay(options: RelayOptions): Promise<void> {
  const endpoint = options.env[ENDPOINT_ENV] ?? ''
  const token = options.env[TOKEN_ENV] ?? ''
  const send = (message: Json): void => {
    options.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const pending = new Map<number, (reply: ToolReplyLine) => void>()
  let socket: Socket | null = null
  let nextId = 1
  let buffer = ''

  const connection = (): Socket => {
    if (socket !== null && !socket.destroyed) return socket
    const opened = (options.dial ?? connect)(endpoint)
    opened.setEncoding('utf8')
    opened.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const reply = JSON.parse(line) as ToolReplyLine
          pending.get(reply.id)?.(reply)
          pending.delete(reply.id)
        } catch {
          // A broken line answers nothing; its call fails when the socket closes.
        }
        newline = buffer.indexOf('\n')
      }
    })
    const failAll = (message: string): void => {
      for (const [id, resolve] of pending) resolve({ id, ok: false, code: 'agent_tools_unavailable', message })
      pending.clear()
      socket = null
      buffer = ''
    }
    opened.on('error', error => failAll(`Agents Anywhere is not reachable: ${error.message}`))
    opened.on('close', () => failAll('Agents Anywhere closed the connection.'))
    socket = opened
    return opened
  }

  const callTool = (tool: string, args: Json): Promise<ToolReplyLine> => {
    if (endpoint === '' || token === '') return Promise.resolve({ id: 0, ok: false, code: 'agent_tools_unavailable', message: 'This session was not given the Agents Anywhere tools.' })
    const id = nextId++
    return new Promise(resolve => {
      pending.set(id, resolve)
      const line: ToolCallLine = { id, token, tool, arguments: args }
      connection().write(`${JSON.stringify(line)}\n`)
    })
  }

  const handle = async (message: Json): Promise<void> => {
    const id = message.id
    if (id === undefined || id === null) return
    const params = (message.params ?? {}) as Json
    switch (message.method) {
      case 'initialize':
        send({ id, result: { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: AGENT_TOOLS.server, title: 'Agents Anywhere', version: options.version } } })
        return
      case 'ping':
        send({ id, result: {} })
        return
      case 'tools/list':
        send({ id, result: { tools: AGENT_TOOLS.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } })
        return
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!AGENT_TOOLS.tools.some(tool => tool.name === name)) {
          send({ id, error: { code: -32602, message: `Unknown tool ${name}` } })
          return
        }
        const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Json : {}
        const reply = await callTool(name, args)
        const text = reply.ok ? JSON.stringify(reply.value) : JSON.stringify({ error: { code: reply.code, message: reply.message } })
        send({ id, result: { content: [{ type: 'text', text }], ...(reply.ok ? {} : { isError: true }) } })
        return
      }
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } })
    }
  }

  return new Promise(resolve => {
    const lines = createInterface({ input: options.input })
    lines.on('line', line => {
      let message: Json
      try {
        message = JSON.parse(line) as Json
      } catch {
        return
      }
      void handle(message)
    })
    lines.on('close', () => {
      socket?.end()
      resolve()
    })
  })
}
