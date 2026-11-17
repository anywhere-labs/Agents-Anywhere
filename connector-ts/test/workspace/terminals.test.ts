import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileOps, RootPolicy, ShellOps, TERMINAL_SCROLLBACK_MAX_BYTES, Terminals, nodePtySpawner, workspaceMethods, type Pty, type SpawnPty } from '../../src/workspace/index.js'

class FakePty implements Pty {
  public readonly pid = 4242
  public readonly written: Buffer[] = []
  public readonly sizes: [number, number][] = []
  public killed = false
  private data?: (data: string) => void
  private exit?: (event: { exitCode: number }) => void

  public constructor(public readonly file: string, public readonly args: readonly string[], public readonly options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) {}
  public onData(listener: (data: string) => void): void {
    this.data = listener
  }
  public onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener
  }
  public write(data: string | Buffer): void {
    this.written.push(Buffer.from(data))
  }
  public resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }
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
let home: string
let now: number
let spawned: FakePty[]
let events: { method: string; params: Record<string, unknown> }[]
let terminals: Terminals

const spawn: SpawnPty = (file, args, options) => {
  const pty = new FakePty(file, args, options)
  spawned.push(pty)
  return pty
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-term-')))
  home = join(base, 'home')
  mkdirSync(join(home, 'project'), { recursive: true })
  now = Date.UTC(2026, 10, 16)
  spawned = []
  events = []
  terminals = new Terminals({
    policy: new RootPolicy({ roots: [home] }),
    spawn,
    notify: (method, params) => events.push({ method, params }),
    now: () => now,
    platform: 'linux',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
  })
})

afterEach(() => {
  terminals.shutdown()
  rmSync(base, { recursive: true, force: true })
})

const create = (extra: Record<string, unknown> = {}) => terminals.create({ root: home, terminalId: 'term_1', sessionId: 'sess_1', ...extra })

describe('terminals-v2', () => {
  it('starts a login shell in the nearest existing directory', async () => {
    const result = await create({ cwd: 'project/gone', cols: 100, rows: 30, env: { FOO: 'bar' } })
    expect(result).toMatchObject({ terminalId: 'term_1', sessionId: 'sess_1', label: 'Shell', purpose: 'user', pid: 4242, cwd: join(home, 'project'), cols: 100, rows: 30, shell: '/bin/zsh', status: 'running', persistent: false })
    expect(spawned[0]).toMatchObject({ file: '/bin/zsh', args: ['-l'], options: { cwd: join(home, 'project'), cols: 100, rows: 30 } })
    expect(spawned[0]!.options.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', FOO: 'bar', PATH: '/usr/bin' })
    await expect(create()).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(terminals.create({ root: home, cwd: base, terminalId: 'term_2', sessionId: 's' })).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('writes, resizes within limits, renames, and streams numbered output', async () => {
    await create()
    const pty = spawned[0]!
    expect(await terminals.write({ terminalId: 'term_1', dataBase64: Buffer.from('ls\r').toString('base64') })).toEqual({ terminalId: 'term_1', bytesWritten: 3 })
    expect(pty.written[0]!.toString()).toBe('ls\r')
    await expect(terminals.write({ terminalId: 'term_1', dataBase64: '***' })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(await terminals.resize({ terminalId: 'term_1', cols: 9999, rows: 0 })).toEqual({ terminalId: 'term_1', cols: 500, rows: 24 })
    expect(pty.sizes).toEqual([[500, 24]])
    expect(await terminals.resize({ terminalId: 'nope', cols: 10 })).toEqual({ terminalId: 'nope', closed: true })
    expect(await terminals.rename({ terminalId: 'term_1', label: ' build ' })).toMatchObject({ label: 'build' })
    pty.print('a')
    pty.print('你好')
    expect(events).toEqual([
      { method: 'terminal.output', params: { terminalId: 'term_1', sessionId: 'sess_1', seq: 1, dataBase64: Buffer.from('a').toString('base64') } },
      { method: 'terminal.output', params: { terminalId: 'term_1', sessionId: 'sess_1', seq: 2, dataBase64: Buffer.from('你好').toString('base64') } },
    ])
    const snapshot = await terminals.snapshot({ terminalId: 'term_1', fromSeq: 1 })
    expect(snapshot).toMatchObject({ baseSeq: 0, seq: 2, dataBase64: Buffer.from('a你好').toString('base64'), outputs: [{ seq: 2 }] })
    expect(await terminals.snapshot({ terminalId: 'term_1', fromSeq: 1 }, false)).toMatchObject({ dataBase64: '' })
  })

  it('keeps 512 KiB of scrollback and asks for a full replay when the cursor fell out of it', async () => {
    await create()
    const pty = spawned[0]!
    const block = 'x'.repeat(200 * 1024)
    for (let i = 0; i < 4; i++) pty.print(block)
    const snapshot = await terminals.snapshot({ terminalId: 'term_1', fromSeq: 1 }, false)
    expect(Buffer.from(snapshot.dataBase64 as string, 'base64').length).toBe(TERMINAL_SCROLLBACK_MAX_BYTES)
    expect(snapshot.baseSeq).toBe(2)
    expect((snapshot.outputs as unknown[]).length).toBe(2)
  })

  it('reports the exit, keeps the closed record for a while, then forgets it', async () => {
    await create()
    spawned[0]!.end(7)
    expect(events.at(-1)).toEqual({ method: 'terminal.exited', params: { terminalId: 'term_1', sessionId: 'sess_1', exitCode: 7, reason: 'exit' } })
    expect((await terminals.list({ sessionId: 'sess_1' })).terminals).toMatchObject([{ closed: true, status: 'exited', exitCode: 7, pid: null }])
    await expect(terminals.write({ terminalId: 'term_1', dataBase64: 'YQ==' })).rejects.toMatchObject({ code: 'invalid_argument' })
    now += 16 * 60_000
    terminals.reap()
    expect((await terminals.list({})).terminals).toEqual([])
    await expect(terminals.snapshot({ terminalId: 'term_1' })).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('expires idle terminals after 30 minutes and persistent ones at the end of their lease', async () => {
    await create()
    await create({ terminalId: 'term_p', persistent: true })
    now += 31 * 60_000
    terminals.reap()
    expect(events.filter(e => e.method === 'terminal.exited').map(e => e.params)).toEqual([{ terminalId: 'term_1', sessionId: 'sess_1', exitCode: null, reason: 'idle_timeout' }])
    expect(spawned[0]!.killed).toBe(true)
    expect(spawned[1]!.killed).toBe(false)
    now += 24 * 60 * 60_000
    terminals.reap()
    expect(events.at(-1)?.params).toMatchObject({ terminalId: 'term_p', reason: 'persistent_lease_expired' })
    await expect(terminals.setPersistent({ terminalId: 'term_p', persistent: true })).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it('sends a relayed terminal only to its relay, and a replaced relay never detaches the new one', async () => {
    await create()
    const first: string[] = []
    const second: string[] = []
    const relayA = (method: string) => first.push(method)
    const relayB = (method: string) => second.push(method)
    expect(await terminals.attach({ terminalId: 'term_1', sessionId: 'sess_1' }, relayA)).toMatchObject({ seq: 0 })
    await expect(terminals.attach({ terminalId: 'term_1', sessionId: 'other' }, relayA)).rejects.toMatchObject({ code: 'terminal_not_found' })
    await terminals.attach({ terminalId: 'term_1', sessionId: 'sess_1' }, relayB)
    await terminals.release({ terminalId: 'term_1' }, relayA)
    spawned[0]!.print('x')
    expect(second).toEqual(['terminal.output'])
    await terminals.release({ terminalId: 'term_1' }, relayB)
    spawned[0]!.print('y')
    expect(first).toEqual([])
    expect(events).toEqual([])
    expect(await terminals.close({ terminalId: 'term_1' })).toEqual({ terminalId: 'term_1', closed: true })
    expect(spawned[0]!.killed).toBe(true)
  })

  it('registers the v2 terminal methods', () => {
    const policy = new RootPolicy({ roots: [home] })
    expect(Object.keys(workspaceMethods(new FileOps(policy), new ShellOps(policy), terminals)).filter(name => name.startsWith('terminal.')).sort()).toEqual([
      'terminal.close', 'terminal.create', 'terminal.list', 'terminal.release', 'terminal.rename', 'terminal.resize', 'terminal.setPersistent', 'terminal.snapshot', 'terminal.write',
    ])
  })
})

describe.skipIf(process.platform === 'win32')('node-pty', () => {
  it('runs a real shell (spawn-helper execute bit restored)', async () => {
    const real = new Terminals({ policy: new RootPolicy({ roots: [home] }), spawn: await nodePtySpawner(), notify: (method, params) => events.push({ method, params }) })
    try {
      await real.create({ root: home, terminalId: 't', sessionId: 's', command: '/bin/sh', args: ['-c', 'printf ready; exit 3'] })
      await expect.poll(() => events.find(e => e.method === 'terminal.exited'), { timeout: 5000 }).toBeTruthy()
      const output = events.filter(e => e.method === 'terminal.output').map(e => Buffer.from(e.params.dataBase64 as string, 'base64').toString()).join('')
      expect(output).toContain('ready')
      expect(events.find(e => e.method === 'terminal.exited')?.params).toMatchObject({ exitCode: 3, reason: 'exit' })
    } finally {
      real.shutdown()
    }
  })
})
