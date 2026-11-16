// `shell.exec`, `shell.task.start`, `shell.task.cancel` with the behaviour of v2 connector/local/shell.py: the command
// runs through the platform shell in its own process group (Unix) or process tree (Windows), stdin closed, output
// capped at 64,000 characters per stream, killed on timeout (TERM, then KILL after 2 s; `taskkill /T /F` on Windows).
import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'

import { WorkspaceError, invalid } from './errors.js'
import { decodeOutput, requiredInt, requiredString, resolvePath, workspaceRoot, type Params } from './params.js'
import type { RootPolicy } from './roots.js'

export type Notify = (method: string, params: Record<string, unknown>) => void

export interface ShellResult {
  cwd: string
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

interface Running {
  readonly child: ChildProcess
  readonly done: Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>
}

const KILL_GRACE_MS = 2000

export class ShellOps {
  private readonly tasks = new Map<string, { cancelled: boolean; running?: Running }>()

  public constructor(
    private readonly policy: RootPolicy,
    private readonly notify: Notify = () => undefined,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private async cwdOf(params: Params): Promise<string> {
    const cwd = resolvePath(workspaceRoot(params), requiredString(params, 'cwd'))
    await this.policy.check(cwd)
    if ((await stat(cwd).catch(() => undefined))?.isDirectory() !== true) throw new WorkspaceError('not_found', `cwd not found: ${cwd}`)
    return cwd
  }

  private start(cwd: string, command: string): Running {
    const windows = this.platform === 'win32'
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      windowsHide: true,
    })
    const done = new Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
      child.once('error', reject)
      child.once('close', code => resolve({ exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }))
    })
    return { child, done }
  }

  private async terminate(running: Running | undefined): Promise<void> {
    if (running === undefined || running.child.exitCode !== null || running.child.signalCode !== null) return
    const pid = running.child.pid
    const exited = running.done.then(() => true, () => true)
    if (this.platform === 'win32') {
      if (pid !== undefined) {
        await new Promise<void>(resolve => {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
          killer.once('error', () => resolve())
          killer.once('close', () => resolve())
        })
      } else running.child.kill()
      if (await Promise.race([exited, delay(5000).then(() => false)])) return
      running.child.kill('SIGKILL')
      await exited
      return
    }
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (pid !== undefined) process.kill(-pid, signal)
        else running.child.kill(signal)
      } catch {
        running.child.kill(signal)
      }
    }
    signalGroup('SIGTERM')
    if (await Promise.race([exited, delay(KILL_GRACE_MS).then(() => false)])) return
    signalGroup('SIGKILL')
    await exited
  }

  private async run(cwd: string, command: string, timeoutMs: number, onStart?: (running: Running) => void): Promise<ShellResult> {
    const startedAt = performance.now()
    const running = this.start(cwd, command)
    onStart?.(running)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void this.terminate(running)
    }, timeoutMs)
    try {
      const { exitCode, stdout, stderr } = await running.done
      const out = decodeOutput(stdout)
      const err = decodeOutput(stderr)
      return {
        cwd,
        command,
        exitCode,
        timedOut,
        durationMs: Math.trunc(performance.now() - startedAt),
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** `shell.exec`: runs to completion (or the timeout) and returns the output. */
  public async exec(params: Params): Promise<ShellResult> {
    const cwd = await this.cwdOf(params)
    const command = requiredString(params, 'command')
    const timeoutMs = positiveTimeout(params)
    return this.run(cwd, command, timeoutMs)
  }

  /** `shell.task.start`: runs in the background; `shell.task.started` now, `shell.task.completed` at the end. */
  public async taskStart(params: Params): Promise<{ taskId: string; sessionId: string; status: 'running' }> {
    const cwd = await this.cwdOf(params)
    const taskId = requiredString(params, 'taskId')
    const sessionId = requiredString(params, 'sessionId')
    const command = requiredString(params, 'command')
    const timeoutMs = positiveTimeout(params)
    if (this.tasks.has(taskId)) throw invalid(`shell task already exists: ${taskId}`)
    const record: { cancelled: boolean; running?: Running } = { cancelled: false }
    this.tasks.set(taskId, record)
    void this.run(cwd, command, timeoutMs, running => {
      record.running = running
    }).then(
      result => {
        if (!record.cancelled) this.notify('shell.task.completed', { taskId, sessionId, status: 'completed', result })
      },
      (error: unknown) => {
        if (!record.cancelled) {
          this.notify('shell.task.completed', { taskId, sessionId, status: 'failed', error: { code: (error as { code?: string }).code ?? 'shell_failed', message: (error as Error).message } })
        }
      },
    ).finally(() => {
      if (this.tasks.get(taskId) === record) this.tasks.delete(taskId)
    })
    this.notify('shell.task.started', { taskId, sessionId, status: 'running' })
    return { taskId, sessionId, status: 'running' }
  }

  /** `shell.task.cancel`: kills the task's process tree; `cancelled: false` when it already ended. */
  public async taskCancel(params: Params): Promise<{ taskId: string; sessionId: string; cancelled: boolean }> {
    const taskId = requiredString(params, 'taskId')
    const sessionId = requiredString(params, 'sessionId')
    const record = this.tasks.get(taskId)
    if (record === undefined) return { taskId, sessionId, cancelled: false }
    record.cancelled = true
    this.tasks.delete(taskId)
    await this.terminate(record.running)
    this.notify('shell.task.completed', { taskId, sessionId, status: 'cancelled' })
    return { taskId, sessionId, cancelled: true }
  }

  /** Kills every background task (shutdown). */
  public async close(): Promise<void> {
    const records = [...this.tasks.values()]
    this.tasks.clear()
    for (const record of records) record.cancelled = true
    await Promise.all(records.map(record => this.terminate(record.running)))
  }
}

function positiveTimeout(params: Params): number {
  const timeoutMs = requiredInt(params, 'timeoutMs')
  if (timeoutMs <= 0) throw invalid('timeoutMs must be positive')
  return timeoutMs
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}
