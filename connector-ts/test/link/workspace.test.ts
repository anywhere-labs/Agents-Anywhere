import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  TERMINAL_OUTPUT_ITEM_BYTES,
  TerminalWatchers,
  uploadPreparedDownload,
  type BlobTransfer,
  type TerminalOutputItem,
  type UploadFile,
  type WorkspaceServiceDeps,
} from '../../src/link/index.js'
import { FileOps, RootPolicy, ShellOps, TERMINAL_SCROLLBACK_MAX_BYTES, Terminals, workspaceMethods, type Pty, type SpawnPty } from '../../src/workspace/index.js'

class FakePty implements Pty {
  public readonly pid = 4242
  public readonly written: Buffer[] = []
  public killed = false
  private data?: (data: string) => void
  private exit?: (event: { exitCode: number }) => void

  public onData(listener: (data: string) => void): void {
    this.data = listener
  }
  public onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener
  }
  public write(data: string | Buffer): void {
    this.written.push(Buffer.from(data))
  }
  public resize(): void {}
  public kill(): void {
    this.killed = true
  }
  public print(text: string): void {
    this.data?.(text)
  }
  public end(exitCode: number): void {
    this.exit?.({ exitCode })
  }
}

let base: string
let root: string
let spawned: FakePty[]
let terminals: Terminals
let uploads: { transfer: BlobTransfer; file: UploadFile }[]

const spawn: SpawnPty = () => {
  const pty = new FakePty()
  spawned.push(pty)
  return pty
}

type Handler = (params: Record<string, unknown>) => Promise<unknown>

/** The workspace handlers, and the upload deps of `POST fs/read`. */
function workspace(): { handlers: Record<string, Handler>; deps: WorkspaceServiceDeps } {
  const policy = new RootPolicy({ roots: [root] })
  const files = new FileOps(policy)
  return {
    handlers: workspaceMethods(files, new ShellOps(policy), terminals) as Record<string, Handler>,
    deps: {
      terminals,
      preparedFile: params => files.preparedFile(params),
      upload: async (transfer, file) => void uploads.push({ transfer, file }),
    },
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-ws-')))
  root = join(base, 'repo')
  mkdirSync(join(root, 'notes'), { recursive: true })
  spawned = []
  uploads = []
  terminals = new Terminals({ policy: new RootPolicy({ roots: [root] }), spawn, platform: 'linux', env: { SHELL: '/bin/sh', PATH: process.env.PATH ?? '/usr/bin:/bin' } })
})

afterEach(() => {
  terminals.shutdown()
  rmSync(base, { recursive: true, force: true })
})

describe('terminal readers and prepared downloads', () => {
  const signal = () => new AbortController().signal

  function setup(): { call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>; watchers: TerminalWatchers; deps: WorkspaceServiceDeps } {
    const { handlers, deps } = workspace()
    return {
      call: async (method, params) => (await handlers[method]!(params)) as Record<string, unknown>,
      watchers: new TerminalWatchers(terminals),
      deps,
    }
  }

  it('prepares a download and sends it to the Server path in the background', async () => {
    const { call, deps } = setup()
    const scope = { sessionId: 'browse_dev_1', root, path: 'big.bin' }
    await call('fs.writeFile', { ...scope, content: 'x'.repeat(5000) })
    expect(await call('fs.prepareDownload', scope)).toMatchObject({ name: 'big.bin', size: 5000 })
    const answer = await uploadPreparedDownload(deps, { ...scope, transferId: 'tr_1', token: 'tt_1', uploadUrl: '/api/v3/device/transfers/tr_1' })
    expect(answer).toEqual({ transferId: 'tr_1', uploadStarted: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(uploads).toEqual([{ transfer: { transferId: 'tr_1', token: 'tt_1', path: '/api/v3/device/transfers/tr_1' }, file: { path: join(root, 'big.bin'), size: 5000, mediaType: 'application/octet-stream' } }])
    for (const uploadUrl of ['https://elsewhere.example/x', '//elsewhere.example/x']) {
      await expect(uploadPreparedDownload(deps, { ...scope, transferId: 'tr_2', token: 't', uploadUrl })).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    await expect(uploadPreparedDownload(deps, { ...scope, transferId: 'tr_3', token: 't', path: 'missing.bin' })).rejects.toMatchObject({ code: 'not_found' })
    expect(uploads).toHaveLength(1)
  })

  it('streams a terminal to several readers: replay, output, unsubscribe, close', async () => {
    const { call, watchers } = setup()
    const scope = { sessionId: 'browse_dev_1', terminalId: 'trm_1' }
    await call('terminal.create', { ...scope, root, cols: 100, rows: 30, outputTransport: 'relay' })
    const pty = spawned[0]!
    pty.print('$ ')
    const first = new AbortController()
    const a = watchers.stream(scope, first.signal)
    expect((await a.next()).value).toMatchObject({ m: 'terminal.replay', p: { terminalId: 'trm_1', seq: 1, dataBase64: Buffer.from('$ ').toString('base64') } })
    pty.print('ls\n')
    expect((await a.next()).value).toEqual({ m: 'terminal.output', p: { terminalId: 'trm_1', seq: 2, dataBase64: Buffer.from('ls\n').toString('base64') } })

    // A second reader gets its own replay; both see what follows.
    const second = new AbortController()
    const b = watchers.stream(scope, second.signal)
    expect((await b.next()).value).toMatchObject({ m: 'terminal.replay', p: { seq: 2, dataBase64: Buffer.from('$ ls\n').toString('base64') } })
    pty.print('a')
    pty.print('b')
    expect((await a.next()).value).toEqual({ m: 'terminal.output', p: { terminalId: 'trm_1', seq: 4, dataBase64: Buffer.from('ab').toString('base64') } })
    expect((await b.next()).value).toMatchObject({ m: 'terminal.output', p: { seq: 4 } })

    // Input goes through the workspace handlers.
    expect(await call('terminal.write', { ...scope, dataBase64: Buffer.from('pwd\n').toString('base64') })).toEqual({ terminalId: 'trm_1', bytesWritten: 4 })
    expect(pty.written.map(chunk => chunk.toString())).toEqual(['pwd\n'])

    // Cancelling the call unsubscribes that reader only.
    first.abort()
    expect((await a.next()).done).toBe(true)
    pty.print('c')
    expect((await b.next()).value).toMatchObject({ m: 'terminal.output', p: { seq: 5 } })

    // Another scope cannot read it.
    const other = watchers.stream({ ...scope, sessionId: 'browse_other' }, signal())
    await expect(other.next()).rejects.toMatchObject({ code: 'terminal_not_found' })

    // Closing the terminal ends the stream with its exit.
    expect(await call('terminal.close', scope)).toEqual({ terminalId: 'trm_1', closed: true })
    expect((await b.next()).value).toEqual({ m: 'terminal.exited', p: { terminalId: 'trm_1', exitCode: null, reason: 'closed' } })
    expect((await b.next()).done).toBe(true)
    const gone = watchers.stream(scope, signal())
    await expect(gone.next()).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('reports the exit and replays the scrollback to a reader that fell behind it', async () => {
    const { call, watchers } = setup()
    const scope = { sessionId: 'browse_dev_1', terminalId: 'trm_2' }
    await call('terminal.create', { ...scope, root, outputTransport: 'relay' })
    const pty = spawned[0]!
    const reader = watchers.stream(scope, signal())
    expect((await reader.next()).value).toMatchObject({ m: 'terminal.replay', p: { seq: 0 } })
    // More than the scrollback arrives before the reader asks again.
    const block = 'x'.repeat(64 * 1024)
    const count = TERMINAL_SCROLLBACK_MAX_BYTES / block.length + 2
    for (let i = 0; i < count; i++) pty.print(block)
    const next = (await reader.next()).value as TerminalOutputItem
    expect(next.m).toBe('terminal.replay')
    expect(next.p.seq).toBe(count)
    expect(Buffer.from(String(next.p.dataBase64), 'base64').length).toBe(TERMINAL_SCROLLBACK_MAX_BYTES)
    // Within the scrollback, the chunks a reader missed arrive merged (never above the item limit).
    for (let i = 0; i < 3; i++) pty.print(block)
    const merged = (await reader.next()).value as TerminalOutputItem
    expect(merged).toMatchObject({ m: 'terminal.output', p: { seq: count + 3 } })
    expect(Buffer.from(String(merged.p.dataBase64), 'base64').length).toBe(3 * block.length)
    expect(3 * block.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_ITEM_BYTES)
    pty.end(3)
    expect((await reader.next()).value).toEqual({ m: 'terminal.exited', p: { terminalId: 'trm_2', exitCode: 3, reason: 'exit' } })
    expect((await reader.next()).done).toBe(true)
  })

})
