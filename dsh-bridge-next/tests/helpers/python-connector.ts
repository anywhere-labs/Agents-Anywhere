import { mkdirSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const connectorProject = fileURLToPath(new URL('../../../connector', import.meta.url))
export const python = process.env.AA_TEST_PYTHON ?? join(connectorProject, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const isolatedHome = 'import sys\nfrom pathlib import Path\nfrom connector.core import runtime_owner\nruntime_owner.system_home=lambda:Path(sys.argv[1])\n'

export async function recordConnectorId(home: string, id: string): Promise<void> {
  await promisify(execFile)(python, ['-c', isolatedHome + 'from connector.core.config import ConnectorConfig\nl=runtime_owner.RuntimeLease()\nl.claim(ConnectorConfig(server_url="https://example.test",connector_id=sys.argv[2],connector_token="fixture"))\nl.release()', home, id], { cwd: connectorProject })
}

/** Real CLI/RPC entry point with only the remote backend replaced by a wait. */
export function launchConnector(home: string, kind: string, mode: 'rpc' | 'start' = 'rpc') {
  const hook = join(home, 'test-python')
  mkdirSync(hook, { recursive: true })
  const code = `import asyncio, os, sys
from pathlib import Path
from connector.core import runtime_owner
runtime_owner.system_home=lambda:Path(os.environ['AA_TEST_CONNECTOR_HOME'])
from connector.server.client import BackendRpcClient
async def fake_backend(self):
 print('backend-ready', file=sys.stderr, flush=True)
 await asyncio.Event().wait()
BackendRpcClient.run_forever=fake_backend
`
  try { writeFileSync(join(hook, 'sitecustomize.py'), code, { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const args = ['-u', '-m', 'connector.cli', mode, '--config', join(home, 'private', kind, 'connector.json')]
  if (mode === 'start') args.push('--server-url', 'https://example.test', '--connector-id', 'cli-id', '--connector-token', 'fixture')
  const child = spawn(python, args, {
    cwd: connectorProject,
    env: { ...process.env, AA_CONNECTOR_OWNER_KIND: kind, AA_TEST_CONNECTOR_HOME: home, PYTHONPATH: [hook, connectorProject].join(delimiter) },
    stdio: 'pipe',
  })
  let buffer = '', stderr = '', id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void; timer: NodeJS.Timeout }>()
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.startsWith('{')) continue
      const frame = JSON.parse(line), call = pending.get(frame.id)
      if (!call) continue
      clearTimeout(call.timer); pending.delete(frame.id)
      if (frame.error) call.reject(Object.assign(new Error(frame.error.message), frame.error))
      else call.resolve(frame.result)
    }
  })
  const fail = (error: Error) => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error) }
    pending.clear()
  }
  child.on('error', fail)
  child.on('exit', () => fail(new Error(`Connector exited: ${stderr}`)))
  return {
    child,
    get stderr() { return stderr },
    request(method: string, params?: unknown): Promise<any> {
      const requestId = ++id
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC timeout: ${method}`)) }, 10_000)
        pending.set(requestId, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
      })
    },
    async close(crash = false) {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      if (crash || mode === 'start') child.kill(crash ? 'SIGKILL' : 'SIGINT')
      else child.stdin.end()
      await exited
    },
  }
}
