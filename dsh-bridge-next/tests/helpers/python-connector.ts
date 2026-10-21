import { mkdirSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mesh, MeshCallError, Router } from 'meshcall'
import { ControlServiceClient } from '../../src/host/generated/connector-control.js'

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
  let buffer = '', stderr = ''
  let mesh: Mesh | undefined
  let resolveReady!: (client: ControlServiceClient) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<ControlServiceClient>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Direct-CLI launches (`start`) never use the control channel; do not let its
  // expected rejection surface as an unhandled rejection.
  void ready.catch(() => undefined)
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let value: { kind?: string, endpoint?: { unixPath?: string, pipe?: string }, key?: string }
      try { value = JSON.parse(line) } catch { continue }
      if (value.kind !== 'connector.ready' || !value.endpoint || typeof value.key !== 'string') continue
      const endpoint = value.endpoint.unixPath ? { unixPath: value.endpoint.unixPath } : { pipe: value.endpoint.pipe ?? '' }
      void (async () => {
        mesh = new Mesh(new Router(endpoint), { token: value.key! })
        await mesh.connect()
        return new ControlServiceClient(mesh)
      })().then(resolveReady, rejectReady)
    }
  })
  const fail = (error: Error) => {
    rejectReady(error)
  }
  child.on('error', fail)
  child.on('exit', () => fail(new Error(`Connector exited: ${stderr}`)))
  return {
    child,
    get stderr() { return stderr },
    async request(method: string, params?: unknown): Promise<any> {
      const client = await ready
      try {
        switch (method) {
          case 'connector.getState': return await client.getState({ timeoutMs: 10_000 })
          case 'connector.acquireOwnership': return await client.acquireOwnership({ timeoutMs: 10_000 })
          case 'connector.start': return await client.start(params as never ?? null, { timeoutMs: 10_000 })
          case 'connector.stop': return await client.stop({ timeoutMs: 10_000 })
          default: throw new Error(`Unsupported Connector method: ${method}`)
        }
      } catch (error) {
        if (error instanceof MeshCallError) throw Object.assign(new Error(error.message), { code: error.code, details: error.details })
        throw error
      }
    },
    async close(crash = false) {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      if (crash || mode === 'start') child.kill(crash ? 'SIGKILL' : 'SIGINT')
      else child.stdin.end()
      await exited
      await mesh?.close().catch(() => undefined)
    },
  }
}
