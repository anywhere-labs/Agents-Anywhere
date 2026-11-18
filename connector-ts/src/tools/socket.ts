// The Connector's agent-tools socket (docs/agent-collaboration.md §8): a Unix socket (macOS, Linux) or a named pipe
// (Windows) the injected `aa` tool servers dial. Only processes of this OS user can open it; each call carries the
// grant secret, so a process that found the path still needs a live grant.
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

import type { AgentToolCalls } from '../application/inbound/agent-tools.js'
import { MAX_LINE_BYTES, type ToolCallLine, type ToolReplyLine } from './wire.js'

export interface AgentToolsSocketOptions {
  /** Directory of the Unix socket (`~/.agents-anywhere/agent-tools`); unused on Windows. */
  readonly dir: string
  readonly calls: AgentToolCalls
  readonly platform?: NodeJS.Platform
  readonly onError?: (error: unknown) => void
}

export class AgentToolsSocket {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  public readonly endpoint: string

  public constructor(private readonly options: AgentToolsSocketOptions) {
    const id = randomBytes(6).toString('hex')
    this.endpoint = (options.platform ?? process.platform) === 'win32'
      ? `\\\\.\\pipe\\agents-anywhere-tools-${id}`
      : join(options.dir, `tools-${id}.sock`)
  }

  public async start(): Promise<void> {
    const unix = !this.endpoint.startsWith('\\\\.\\pipe\\')
    if (unix) {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
      await rm(this.endpoint, { force: true })
    }
    const server = createServer(socket => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (unix) await chmod(this.endpoint, 0o600)
    this.server = server
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (server !== null) await new Promise<void>(resolve => server.close(() => resolve()))
    if (!this.endpoint.startsWith('\\\\.\\pipe\\')) await rm(this.endpoint, { force: true }).catch(() => undefined)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes('\n')) {
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') void this.handle(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', error => this.options.onError?.(error))
    socket.on('close', () => this.sockets.delete(socket))
  }

  private async handle(socket: Socket, line: string): Promise<void> {
    let request: Partial<ToolCallLine>
    try {
      request = JSON.parse(line) as Partial<ToolCallLine>
    } catch {
      return
    }
    const id = typeof request.id === 'number' ? request.id : 0
    let reply: ToolReplyLine
    if (typeof request.token !== 'string' || typeof request.tool !== 'string') {
      reply = { id, ok: false, code: 'invalid_argument', message: 'token and tool are required' }
    } else {
      const args = request.arguments !== null && typeof request.arguments === 'object' && !Array.isArray(request.arguments) ? request.arguments : {}
      try {
        reply = { id, ...(await this.options.calls.call(request.token, request.tool, args)) }
      } catch (error) {
        reply = { id, ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`)
  }
}
