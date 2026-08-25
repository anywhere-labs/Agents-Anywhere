import { chmod, mkdtemp, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareStateLayout } from '../src/security/paths.js'
import { ProcessLock } from '../src/security/process-lock.js'

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'aa-dsh-bridge-'))
  if (process.platform !== 'win32') await chmod(path, 0o700)
  return path
}

describe('DSH_HOME security', () => {
  it('canonicalizes an owner-only state root below DSH_HOME', async () => {
    const home = await temporaryHome()
    const layout = await prepareStateLayout(home, join(home, 'agents-anywhere', 'bridge'))
    const canonicalHome = await realpath(home)
    expect(layout.dshHome).toBe(canonicalHome)
    expect(layout.stateRoot).toBe(join(canonicalHome, 'agents-anywhere', 'bridge'))
    expect(layout.endpointPath).toBe(join(layout.stateRoot, 'endpoint.json'))
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink state root', async () => {
    const home = await temporaryHome()
    const target = join(home, 'target')
    const stateRoot = join(home, 'bridge')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, stateRoot)
    await expect(prepareStateLayout(home, stateRoot)).rejects.toThrow(/symbolic link/u)
  })

  it('allows only one Bridge process lock for one DSH_HOME', async () => {
    const home = await temporaryHome()
    const firstLayout = await prepareStateLayout(home, join(home, 'agents-anywhere', 'bridge'))
    const secondLayout = await prepareStateLayout(home, join(home, 'another-bridge-state'))
    expect(firstLayout.lockPath).toBe(secondLayout.lockPath)
    const first = new ProcessLock(firstLayout.lockPath, firstLayout.dshHome)
    const second = new ProcessLock(secondLayout.lockPath, secondLayout.dshHome)
    await first.acquire()
    await expect(second.acquire()).rejects.toThrow(/already running|owns this DSH_HOME/u)
    await first.release()
    await second.acquire()
    expect(JSON.parse(await readFile(secondLayout.lockPath, 'utf8'))).toMatchObject({
      version: 1,
      pid: process.pid,
      dshHome: await realpath(home),
    })
    await second.release()
  })
})
