// `shell.exec` and the background tasks `shell.task.start` / `shell.task.wait` / `shell.task.cancel`: the command runs
// through the platform shell in its own process group (Unix) or process tree (Windows), stdin closed, output capped
// at 64,000 characters per stream, killed on timeout (TERM, then KILL after 2 s; `taskkill /T /F` on Windows).
// A task's end stays on the device until a `shell.task.wait` takes it or `retainMs` passes.
import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'

import { WorkspaceError, invalid } from './errors.js'
import { decodeOutput, requiredInt, requiredString, resolvePath, workspaceRoot, type Params } from './params.js'
import type { RootPolicy } from './roots.js'

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

/** `abandoned`: a `shell.task.wait` timed out and killed the task. */
export type ShellTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'abandoned'

/** A background task as `shell.task.*` answer it (the 2.x `ShellTaskWaitResponse` without `serverTime`). */
export interface ShellTaskView {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  timeoutMs: number
  status: ShellTaskStatus
  result: ShellResult | null
  error: { code: string; message: string } | null
}

interface Running {
  readonly child: ChildProcess
  readonly done: Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }>
}

interface Task {
  readonly view: ShellTaskView
  running?: Running
  /** Resolves once `view.status` is final. */
  readonly ended: Promise<void>
  readonly end: () => void
  expiry?: NodeJS.Timeout
}

export interface ShellOpsOptions {
  readonly platform?: NodeJS.Platform
  /** How long an ended task waits to be taken by `shell.task.wait`; default 5 minutes. */
  readonly retainMs?: number
}

export const SHELL_TASK_RETAIN_MS = 5 * 60_000
/** Running and unclaimed tasks one device keeps at once. */
export const MAX_SHELL_TASKS = 64

const KILL_GRACE_MS = 2000

export class ShellOps {
  private readonly tasks = new Map<string, Task>()
  private readonly platform: NodeJS.Platform
  private readonly retainMs: number

  public constructor(private readonly policy: RootPolicy, options: ShellOpsOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.retainMs = options.retainMs ?? SHELL_TASK_RETAIN_MS
  }

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

  /** `shell.task.start`: runs the command in the background and answers at once with the running task. */
  public async taskStart(params: Params): Promise<ShellTaskView> {
    const cwd = await this.cwdOf(params)
    const taskId = requiredString(params, 'taskId')
    const sessionId = requiredString(params, 'sessionId')
    const command = requiredString(params, 'command')
    const timeoutMs = positiveTimeout(params)
    if (this.tasks.has(taskId)) throw invalid(`shell task already exists: ${taskId}`)
    if (this.tasks.size >= MAX_SHELL_TASKS) throw new WorkspaceError('resource_exhausted', `at most ${MAX_SHELL_TASKS} shell tasks at once`, { reason: 'shell_tasks' })
    let end = (): void => undefined
    const ended = new Promise<void>(resolve => {
      end = resolve
    })
    const task: Task = { view: { taskId, sessionId, command, cwd, timeoutMs, status: 'running', result: null, error: null }, ended, end }
    this.tasks.set(taskId, task)
    void this.run(cwd, command, timeoutMs, running => {
      task.running = running
    }).then(
      result => this.settle(task, 'completed', result, null),
      (error: unknown) => this.settle(task, 'failed', null, { code: (error as { code?: string }).code ?? 'shell_failed', message: (error as Error).message }),
    )
    return { ...task.view }
  }

  /**
   * `shell.task.wait`: the task once it ended, taken off the device (a second wait finds nothing). A task still
   * running after `timeoutMs` is killed and the wait fails with `shell_task_wait_timeout`, as 2.x did.
   */
  public async taskWait(params: Params): Promise<ShellTaskView> {
    const task = this.taskOf(params)
    const timeoutMs = positiveTimeout(params)
    if (task.view.status === 'running') {
      let timer: NodeJS.Timeout | undefined
      const timedOut = await Promise.race([
        task.ended.then(() => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(true), timeoutMs)
        }),
      ])
      clearTimeout(timer)
      if (timedOut && task.view.status === 'running') {
        await this.stop(task, 'abandoned')
        throw new WorkspaceError('shell_task_wait_timeout', 'shell task wait timed out', { taskId: task.view.taskId })
      }
    }
    this.forget(task)
    return { ...task.view }
  }

  /** `shell.task.cancel`: kills a running task's process tree; an ended task is answered as it ended. */
  public async taskCancel(params: Params): Promise<ShellTaskView & { cancelled: boolean }> {
    const task = this.taskOf(params)
    if (task.view.status !== 'running') return { ...task.view, cancelled: false }
    await this.stop(task, 'cancelled')
    return { ...task.view, cancelled: true }
  }

  /** The task of `taskId` in the caller's `sessionId`; another scope's task is not found either. */
  private taskOf(params: Params): Task {
    const taskId = requiredString(params, 'taskId')
    const sessionId = requiredString(params, 'sessionId')
    const task = this.tasks.get(taskId)
    if (task === undefined || task.view.sessionId !== sessionId) throw new WorkspaceError('shell_task_not_found', 'shell task not found', { taskId })
    return task
  }

  private settle(task: Task, status: ShellTaskStatus, result: ShellResult | null, error: ShellTaskView['error']): void {
    if (task.view.status !== 'running') return
    task.view.status = status
    task.view.result = result
    task.view.error = error
    task.end()
    if (this.tasks.get(task.view.taskId) === task) {
      task.expiry = setTimeout(() => this.forget(task), this.retainMs)
      task.expiry.unref()
    }
  }

  private async stop(task: Task, status: 'cancelled' | 'abandoned'): Promise<void> {
    this.settle(task, status, null, null)
    if (status === 'abandoned') this.forget(task)
    await this.terminate(task.running)
  }

  private forget(task: Task): void {
    clearTimeout(task.expiry)
    if (this.tasks.get(task.view.taskId) === task) this.tasks.delete(task.view.taskId)
  }

  /** Kills every background task (shutdown). */
  public async close(): Promise<void> {
    const tasks = [...this.tasks.values()]
    for (const task of tasks) {
      this.settle(task, 'cancelled', null, null)
      this.forget(task)
    }
    await Promise.all(tasks.map(task => this.terminate(task.running)))
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
