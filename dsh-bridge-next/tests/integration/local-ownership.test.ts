import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LocalRuntimeLease, localRuntimePath, readLocalState } from '../../src/host/desktop/local-runtime.js'

const project = fileURLToPath(new URL('../../../connector', import.meta.url))
// Tests run the checked-out Python package without contacting a server or changing user data.
const python = process.env.AA_TEST_PYTHON ?? join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '', error = ''
    child.stderr?.on('data', chunk => { error += chunk })
    child.stdout?.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]!) })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`child exited ${code}: ${error}`)))
  })
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, 'exit')
  child.kill('SIGKILL')
  await ended
}

test('Python CLI and TypeScript host race for exactly one owner, and a crash allows retry', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-cross-runtime-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = localRuntimePath(home)
  const module = new URL('../../src/host/desktop/local-runtime.ts', import.meta.url).href
  const py = spawn(python, ['-c', `import sys\nfrom connector.core.runtime_owner import RuntimeLease, ConnectorAlreadyRunningError\nl=RuntimeLease(sys.argv[1])\ntry:\n l.claim(); print('owned', flush=True); sys.stdin.readline(); l.release()\nexcept ConnectorAlreadyRunningError:\n print('conflict', flush=True)`, file], { cwd: project, stdio: 'pipe' })
  const ts = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `import {LocalRuntimeLease} from ${JSON.stringify(module)}; const l=new LocalRuntimeLease('desktop-workbench',process.argv[1]); const s=await l.claim(); console.log(s.status); if(s.status==='owned'){process.stdin.resume();process.stdin.once('data',async()=>{await l.release();process.exit(0)})}`, file], { stdio: 'pipe' })
  t.after(async () => { await stop(py); await stop(ts) })
  const results = await Promise.all([firstLine(py), firstLine(ts)])
  assert.deepEqual(results.toSorted(), ['conflict', 'owned'])
  await stop(results[0] === 'owned' ? py : ts)
  const next = new LocalRuntimeLease('dsh-plugin', file)
  assert.equal((await next.claim()).status, 'owned')
  await next.release()
  assert.equal(readLocalState(file).runtime, undefined)
});

test('actual Python RPC attaches its PID to the host and stop retains the host lease', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'aa-rpc-owner-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = localRuntimePath(home), host = new LocalRuntimeLease('desktop-workbench', file)
  await host.require()
  const code = `import sys\nfrom pathlib import Path\nfrom connector.core import runtime_owner\nruntime_owner.system_home=lambda:Path(sys.argv[1])\nfrom connector.cli import main\nmain(['rpc','--config',str(Path(sys.argv[1])/'private/connector.json')])`
  const child = spawn(python, ['-c', code, home], { cwd: project, env: { ...process.env, ...host.environment() }, stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.resume()
  t.after(async () => { await stop(child); await host.release() })
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"connector.getState"}\n')
  for (let i = 0; !output.includes('"id":1') && !output.includes('"id": 1'); i++) {
    assert.ok(i < 200, output)
    assert.equal(child.exitCode, null)
    await delay(20)
  }
  assert.equal(readLocalState(file).runtime?.childPid, child.pid)
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"connector.stop"}\n')
  for (let i = 0; !output.includes('"id":2') && !output.includes('"id": 2'); i++) { assert.ok(i < 200); await delay(20) }
  assert.equal((await new LocalRuntimeLease('cli', file).claim()).status, 'conflict')
  const ended = once(child, 'exit')
  child.stdin.end()
  await ended
  assert.equal(readLocalState(file).runtime?.childPid, undefined)
  assert.equal(readLocalState(file).runtime?.instanceId, host.instanceId)
  await host.release()
  assert.equal(readLocalState(file).runtime, undefined)
});

test('Desktop and plugin ship the same shared ownership protocol implementation', async () => {
  const desktop = await readFile(new URL('../../../desktop-workbench/electron/local-runtime.ts', import.meta.url), 'utf8')
  const plugin = await readFile(new URL('../../src/host/desktop/local-runtime.ts', import.meta.url), 'utf8')
  assert.equal(desktop, plugin)
})
