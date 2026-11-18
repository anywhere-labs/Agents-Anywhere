import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AttachmentCache,
  FileOps,
  MAX_SHELL_TASKS,
  PortWatcher,
  RootPolicy,
  ShellOps,
  mergeByPort,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  parseTasklist,
  rootsFromEnv,
  safeFileName,
  workspaceMethods,
  type ListeningPort,
} from '../../src/workspace/index.js'

let base: string
let home: string
let outside: string

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aa-ws-')))
  home = join(base, 'home')
  outside = join(base, 'outside')
  mkdirSync(join(home, 'project', 'src'), { recursive: true })
  mkdirSync(outside)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const files = (roots: readonly string[] | 'any' = [join(base, 'home')], extra: string[] = []) => new FileOps(new RootPolicy({ roots, extra: () => extra }), 'linux')

describe('allowed roots', () => {
  it('defaults to the home, takes a list or `*` from the environment', () => {
    expect(rootsFromEnv({}, '/h')).toEqual(['/h'])
    expect(rootsFromEnv({ AGENT_CONNECTOR_WORKSPACE_ROOTS: '*' }, '/h')).toBe('any')
    expect(rootsFromEnv({ AGENT_CONNECTOR_WORKSPACE_ROOTS: `~/code${delimiter}/srv` }, '/h')).toEqual([join('/h', 'code'), '/srv'])
  })

  it('refuses paths outside the roots, including through a symlink, and admits extra roots', async () => {
    const policy = new RootPolicy({ roots: [home], platform: 'linux' })
    expect(await policy.allows(join(home, 'project', 'missing', 'deep'))).toBe(true)
    expect(await policy.allows(outside)).toBe(false)
    expect(await policy.allows(`${home}-evil`)).toBe(false)
    symlinkSync(outside, join(home, 'escape'))
    expect(await policy.allows(join(home, 'escape', 'secret.txt'))).toBe(false)
    await expect(policy.check(join(home, 'escape'))).rejects.toMatchObject({ code: 'permission_denied', details: { reason: 'outside_allowed_roots' } })
    const withExtra = new RootPolicy({ roots: [home], extra: () => [outside], platform: 'linux' })
    expect(await withExtra.allows(join(outside, 'x'))).toBe(true)
    expect(await new RootPolicy({ roots: 'any' }).allows('/')).toBe(true)
  })
})

describe('fs.readDir', () => {
  it('lists sorted entries with types and sizes', async () => {
    writeFileSync(join(home, 'project', 'b.txt'), 'bb')
    writeFileSync(join(home, 'project', 'a.txt'), 'a')
    const result = await files().readDir({ root: join(home, 'project') })
    expect(result).toMatchObject({ path: join(home, 'project'), truncated: false, targetType: 'directory' })
    expect(result.entries).toEqual([
      { name: 'a.txt', path: join(home, 'project', 'a.txt'), type: 'file', size: 1 },
      { name: 'b.txt', path: join(home, 'project', 'b.txt'), type: 'file', size: 2 },
      { name: 'src', path: join(home, 'project', 'src'), type: 'directory', size: null },
    ])
  })

  it('caps at 500 entries but keeps a file target visible', async () => {
    const dir = join(home, 'many')
    mkdirSync(dir)
    for (let i = 0; i < 510; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}`), '')
    const result = await files().readDir({ root: home, path: 'many/f509' })
    expect(result).toMatchObject({ path: dir, truncated: true, targetType: 'file', targetPath: join(dir, 'f509') })
    expect(result.entries).toHaveLength(500)
    expect(result.entries.at(-1)?.name).toBe('f509')
  })

  it('falls back to the nearest existing parent of a missing path', async () => {
    const result = await files().readDir({ root: home, path: 'project/gone/deeper' })
    expect(result).toMatchObject({ path: join(home, 'project'), targetType: 'missing' })
  })

  it('refuses a directory outside the allowed roots', async () => {
    await expect(files().readDir({ root: home, path: outside })).rejects.toMatchObject({ code: 'permission_denied' })
    expect((await files('any').readDir({ root: home, path: outside })).path).toBe(outside)
  })

  it('lists the allowed roots for the Windows drive view when restricted', async () => {
    const ops = new FileOps(new RootPolicy({ roots: [home], platform: 'win32' }), 'win32')
    expect(await ops.readDir({ root: home, path: '' })).toMatchObject({ path: '', entries: [{ path: home, type: 'directory' }], targetType: 'directory' })
  })
})

describe('fs.readText', () => {
  it('reads up to maxBytes and hashes the whole file', async () => {
    const path = join(home, 'project', 'big.txt')
    writeFileSync(path, 'hello world')
    const result = await files().readText({ root: home, path: 'project/big.txt', maxBytes: 5 })
    expect(result).toEqual({ path, name: 'big.txt', size: 11, sha256: sha('hello world'), encoding: 'utf8', content: 'hello', truncated: true, binary: false })
    await expect(files().readText({ root: home, path: 'project/big.txt', maxBytes: 1.5 })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(files().readText({ root: home, path: 'project/none.txt' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports binary content without returning it', async () => {
    writeFileSync(join(home, 'bin'), Buffer.from([1, 0, 2]))
    expect(await files().readText({ root: home, path: 'bin' })).toMatchObject({ binary: true, content: '', size: 3 })
  })
})

describe('fs.writeFile', () => {
  it('writes atomically, keeps the mode and writes through a symlink', async () => {
    const path = join(home, 'project', 'run.sh')
    writeFileSync(path, 'old')
    chmodSync(path, 0o755)
    symlinkSync(path, join(home, 'link.sh'))
    const result = await files().writeFile({ root: home, path: 'link.sh', content: 'new', ifMatch: sha('old') })
    expect(result).toEqual({ path: join(home, 'link.sh'), encoding: 'utf8', bytesWritten: 3, sha256: sha('new') })
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).mode & 0o777).toBe(0o755)
  })

  it('refuses a stale ifMatch as v2 did', async () => {
    const path = join(home, 'f.txt')
    writeFileSync(path, 'disk')
    await expect(files().writeFile({ root: home, path: 'f.txt', content: 'x', ifMatch: sha('editor') })).rejects.toMatchObject({ code: 'stale' })
    await expect(files().writeFile({ root: home, path: 'gone.txt', content: 'x', ifMatch: sha('editor') })).rejects.toMatchObject({ code: 'stale' })
    // An empty ifMatch accepts both a new and an existing file.
    await files().writeFile({ root: home, path: 'new.txt', content: 'n', ifMatch: '' })
    await files().writeFile({ root: home, path: 'f.txt', content: 'y', ifMatch: '' })
    expect(readFileSync(path, 'utf8')).toBe('y')
    await expect(files().writeFile({ root: home, path: 'nodir/x.txt', content: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(files().writeFile({ root: home, path: join(outside, 'x.txt'), content: 'x' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(files().writeFile({ root: home, path: 'f.txt', content: 'x', encoding: 'latin1' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('downloads', () => {
  it('prepares and streams a file', async () => {
    const data = Buffer.alloc(600 * 1024, 7)
    writeFileSync(join(home, 'photo.png'), data)
    expect(await files().prepareDownload({ root: home, path: 'photo.png' })).toEqual({ path: join(home, 'photo.png'), name: 'photo.png', size: data.length, sha256: sha(data), mediaType: 'image/png' })
    const chunks: Buffer[] = []
    for await (const chunk of await files().openDownload({ root: home, path: 'photo.png' })) chunks.push(chunk)
    expect(chunks.length).toBe(3)
    expect(Buffer.concat(chunks).equals(data)).toBe(true)
    await expect(files().openDownload({ root: home, path: 'none' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('shell', () => {
  const shell = (retainMs?: number) => new ShellOps(new RootPolicy({ roots: [home] }), retainMs === undefined ? {} : { retainMs })

  it('runs a command and returns its output', async () => {
    const result = await shell().exec({ root: home, cwd: 'project', command: 'pwd; echo err 1>&2; exit 3', timeoutMs: 10_000 })
    expect(result).toMatchObject({ cwd: join(home, 'project'), exitCode: 3, timedOut: false, stdout: `${join(home, 'project')}\n`, stderr: 'err\n', stdoutTruncated: false })
  })

  it('truncates long output and kills the process group on timeout', async () => {
    const long = await shell().exec({ root: home, cwd: '.', command: 'head -c 70000 /dev/zero | tr "\\0" a', timeoutMs: 10_000 })
    expect(long).toMatchObject({ stdoutTruncated: true })
    expect(long.stdout).toHaveLength(64_000)
    const slow = await shell().exec({ root: home, cwd: '.', command: 'sleep 30 & sleep 30', timeoutMs: 200 })
    expect(slow).toMatchObject({ timedOut: true })
    expect(slow.durationMs).toBeLessThan(5000)
  })

  it('refuses a bad cwd or timeout', async () => {
    await expect(shell().exec({ root: home, cwd: 'nope', command: 'true', timeoutMs: 100 })).rejects.toMatchObject({ code: 'not_found' })
    await expect(shell().exec({ root: home, cwd: outside, command: 'true', timeoutMs: 100 })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(shell().exec({ root: home, cwd: '.', command: 'true', timeoutMs: 0 })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('runs a background task and answers the wait with its output once it ends', async () => {
    const ops = shell()
    const started = await ops.taskStart({ root: home, cwd: 'project', taskId: 't1', sessionId: 's1', command: 'sleep 0.3; echo done; exit 4', timeoutMs: 10_000 })
    expect(started).toEqual({ taskId: 't1', sessionId: 's1', command: 'sleep 0.3; echo done; exit 4', cwd: join(home, 'project'), timeoutMs: 10_000, status: 'running', result: null, error: null })
    const waited = await ops.taskWait({ taskId: 't1', sessionId: 's1', timeoutMs: 10_000 })
    expect(waited).toMatchObject({ taskId: 't1', status: 'completed', error: null, result: { stdout: 'done\n', exitCode: 4, timedOut: false } })
    // The wait took the task: a second one finds nothing, and the id may be used again.
    await expect(ops.taskWait({ taskId: 't1', sessionId: 's1', timeoutMs: 100 })).rejects.toMatchObject({ code: 'shell_task_not_found' })
    await ops.taskStart({ root: home, cwd: '.', taskId: 't1', sessionId: 's1', command: 'true', timeoutMs: 10_000 })
    await ops.close()
  })

  it('keeps an ended task for a later wait, then forgets it', async () => {
    const ops = shell(300)
    await ops.taskStart({ root: home, cwd: '.', taskId: 'kept', sessionId: 's1', command: 'echo early', timeoutMs: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await ops.taskWait({ taskId: 'kept', sessionId: 's1', timeoutMs: 10 })).toMatchObject({ status: 'completed', result: { stdout: 'early\n' } })
    await ops.taskStart({ root: home, cwd: '.', taskId: 'gone', sessionId: 's1', command: 'true', timeoutMs: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 600))
    await expect(ops.taskWait({ taskId: 'gone', sessionId: 's1', timeoutMs: 10 })).rejects.toMatchObject({ code: 'shell_task_not_found' })
  })

  it('cancels a running task; the wait reports it cancelled', async () => {
    const ops = shell()
    await ops.taskStart({ root: home, cwd: '.', taskId: 't2', sessionId: 's1', command: 'sleep 30', timeoutMs: 60_000 })
    // A task id still in use is refused.
    await expect(ops.taskStart({ root: home, cwd: '.', taskId: 't2', sessionId: 's1', command: 'true', timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'invalid_argument' })
    // Another scope does not see it.
    await expect(ops.taskCancel({ taskId: 't2', sessionId: 's2' })).rejects.toMatchObject({ code: 'shell_task_not_found' })
    const waiting = ops.taskWait({ taskId: 't2', sessionId: 's1', timeoutMs: 20_000 })
    const startedAt = Date.now()
    expect(await ops.taskCancel({ taskId: 't2', sessionId: 's1' })).toMatchObject({ taskId: 't2', status: 'cancelled', cancelled: true })
    expect(Date.now() - startedAt).toBeLessThan(5000)
    expect(await waiting).toMatchObject({ taskId: 't2', status: 'cancelled', result: null })
    await expect(ops.taskCancel({ taskId: 'nope', sessionId: 's1' })).rejects.toMatchObject({ code: 'shell_task_not_found' })
    await ops.close()
  })

  it('answers a cancel of an ended task as it ended', async () => {
    const ops = shell()
    await ops.taskStart({ root: home, cwd: '.', taskId: 't3', sessionId: 's1', command: 'echo ok', timeoutMs: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await ops.taskCancel({ taskId: 't3', sessionId: 's1' })).toMatchObject({ status: 'completed', cancelled: false, result: { stdout: 'ok\n' } })
    await ops.close()
  })

  it('kills the task when a wait times out', async () => {
    const ops = shell()
    const marker = join(home, 'abandoned-marker')
    await ops.taskStart({ root: home, cwd: '.', taskId: 't4', sessionId: 's1', command: `sleep 1; touch ${JSON.stringify(marker)}`, timeoutMs: 60_000 })
    await expect(ops.taskWait({ taskId: 't4', sessionId: 's1', timeoutMs: 100 })).rejects.toMatchObject({ code: 'shell_task_wait_timeout' })
    await expect(ops.taskWait({ taskId: 't4', sessionId: 's1', timeoutMs: 100 })).rejects.toMatchObject({ code: 'shell_task_not_found' })
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(() => statSync(marker)).toThrow()
  })

  it('reports a task that ran out of its own timeout as completed and timed out', async () => {
    const ops = shell()
    await ops.taskStart({ root: home, cwd: '.', taskId: 't5', sessionId: 's1', command: 'sleep 30', timeoutMs: 200 })
    expect(await ops.taskWait({ taskId: 't5', sessionId: 's1', timeoutMs: 10_000 })).toMatchObject({ status: 'completed', result: { timedOut: true } })
  })

  it('refuses tasks beyond the limit and kills every task on close', async () => {
    const ops = shell()
    for (let i = 0; i < MAX_SHELL_TASKS; i += 1) await ops.taskStart({ root: home, cwd: '.', taskId: `many${i}`, sessionId: 's1', command: 'sleep 30', timeoutMs: 60_000 })
    await expect(ops.taskStart({ root: home, cwd: '.', taskId: 'one-more', sessionId: 's1', command: 'true', timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'resource_exhausted' })
    const waiting = ops.taskWait({ taskId: 'many0', sessionId: 's1', timeoutMs: 20_000 })
    await ops.close()
    expect(await waiting).toMatchObject({ status: 'cancelled' })
  })

  it('exposes the v2 method names', () => {
    expect(Object.keys(workspaceMethods(files(), shell())).sort()).toEqual(['fs.prepareDownload', 'fs.readDir', 'fs.readRange', 'fs.readText', 'fs.writeFile', 'shell.exec', 'shell.task.cancel', 'shell.task.start', 'shell.task.wait'])
  })
})

describe('port discovery', () => {
  it('parses /proc/net/tcp, lsof, netstat and tasklist', () => {
    const proc = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0',
      '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0',
      '   2: 0100007F:1F91 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0',
    ].join('\n')
    expect(parseProcNetTcp(proc, false)).toEqual([{ port: 3000, address: '0.0.0.0', inode: '111' }, { port: 8080, address: '127.0.0.1', inode: '222' }])
    expect(parseProcNetTcp('h\n 0: 00000000000000000000000001000000:1F90 0 0A 0 0 0 0 0 444\n', true)[0]).toEqual({ port: 8080, address: '::1', inode: '444' })
    expect(parseLsof('p42\ncnode\nn*:3000\nn[::1]:3001\np7\ncpython\nn127.0.0.1:8000\n')).toEqual([
      { port: 3000, address: '0.0.0.0', pid: 42, process: 'node' },
      { port: 3001, address: '::1', pid: 42, process: 'node' },
      { port: 8000, address: '127.0.0.1', pid: 7, process: 'python' },
    ])
    expect(parseNetstat('  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   42\r\n  TCP    [::]:3000   [::]:0   LISTENING   42\r\n  TCP 1.2.3.4:5 6.7.8.9:10 ESTABLISHED 1')).toEqual([
      { port: 3000, address: '0.0.0.0', pid: 42 },
      { port: 3000, address: '::', pid: 42 },
    ])
    expect(parseTasklist('"node.exe","42","Console","1","10,000 K"\r\n')).toEqual(new Map([[42, 'node.exe']]))
  })

  it('keeps one entry per port, preferring the wildcard binding, without our own sockets', () => {
    const ports: ListeningPort[] = [
      { port: 3000, address: '127.0.0.1', pid: 1, process: '' },
      { port: 3000, address: '0.0.0.0', pid: 1, process: 'node' },
      { port: 4000, address: '0.0.0.0', pid: 99, process: 'connector' },
      { port: 5000, address: '0.0.0.0', pid: 2, process: 'x' },
    ]
    expect(mergeByPort(ports, new Set([5000]), 99)).toEqual([{ port: 3000, address: '0.0.0.0', pid: 1, process: 'node' }])
  })

  it('reports listening and closed ports on change only', async () => {
    let list: ListeningPort[] = [{ port: 3000, address: '0.0.0.0', pid: 1, process: 'node' }]
    const events: { method: string; payload: Record<string, unknown> }[] = []
    const watcher = new PortWatcher({ deviceId: 'dev_1', list: async () => list, emit: (method, payload) => events.push({ method, payload }) })
    await watcher.poll()
    await watcher.poll()
    expect(events).toEqual([{ method: 'port.listening', payload: { deviceId: 'dev_1', ports: [{ port: 3000, pid: 1, processName: 'node' }] } }])
    list = [{ port: 5173, address: '::', pid: 2, process: '' }]
    await watcher.poll()
    expect(events.slice(1)).toEqual([
      { method: 'port.closed', payload: { deviceId: 'dev_1', port: 3000 } },
      { method: 'port.listening', payload: { deviceId: 'dev_1', ports: [{ port: 5173, pid: 2, processName: null }] } },
    ])
    list = []
    await watcher.poll()
    expect(events.at(-1)).toEqual({ method: 'port.closed', payload: { deviceId: 'dev_1', port: 5173 } })
    expect(watcher.current()).toEqual({ deviceId: 'dev_1', ports: [] })
  })
})

describe('attachments', () => {
  it('downloads once, verifies size and sha256, and shares concurrent downloads', async () => {
    let fetches = 0
    const body = Buffer.from('image-bytes')
    const cache = new AttachmentCache(join(base, 'attachments'), async () => {
      fetches++
      return (async function* () {
        yield body.subarray(0, 5)
        yield body.subarray(5)
      })()
    })
    const source = { fileId: 'file_1', name: '../shot.png', mediaType: 'image/png', size: body.length, sha256: `sha256:${sha(body)}` }
    const [a, b] = await Promise.all([cache.resolve('sess_1', source), cache.resolve('sess_1', source)])
    expect(a).toEqual(b)
    expect(a.path.startsWith(join(base, 'attachments'))).toBe(true)
    expect(a.path.endsWith('_.shot.png') || a.path.endsWith('_shot.png')).toBe(true)
    expect(readFileSync(a.path)).toEqual(body)
    await cache.resolve('sess_1', source)
    expect(fetches).toBe(1)
    await expect(cache.resolve('sess_1', { ...source, fileId: 'file_2', size: 99 })).rejects.toMatchObject({ code: 'attachment_corrupt' })
    await expect(cache.resolve('sess_1', { ...source, fileId: 'file_3', sha256: 'sha256:00' })).rejects.toMatchObject({ code: 'attachment_corrupt' })
    await cache.forget('sess_1')
    expect(() => statSync(a.path)).toThrow()
    expect(safeFileName('a/b:c')).toBe('a_b_c')
  })
})
