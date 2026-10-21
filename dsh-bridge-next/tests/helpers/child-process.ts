import { spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'

/**
 * Kill a child and everything it started. On Windows a launcher (`uv run`, a venv
 * `python.exe`) does not take its own children down with it, and those keep the
 * inherited stdio pipes, so the test file could never exit.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

/**
 * Ask a child to stop and wait for it; kill its tree if it has not exited within
 * `timeoutMs`, so a test that already failed cannot also hang its file.
 */
export async function stopChild(child: ChildProcess, request: () => void, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  request()
  const timer = setTimeout(() => killTree(child), timeoutMs)
  try { await exited } finally { clearTimeout(timer) }
}
