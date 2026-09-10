import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { detectDesktop } from '../../src/host/desktop/detect.js'
import { localRuntimePath } from '../../src/host/desktop/local-runtime.js'
import { desktopOnboardingUrl, newDesktopFlowId, type DesktopLaunchTarget } from '../../src/host/desktop/launch.js'
import { localMachineRegistry } from '../../src/host/desktop/machine-state.js'
import { OnboardingManager } from '../../src/host/onboarding/manager.js'
import type { DesktopDetection } from '../../src/contracts/index.js'

async function writeDesktopRecord(home: string, desktop: Record<string, unknown>): Promise<void> {
  const file = localRuntimePath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 2, connectorIds: [], desktop }))
}

function managerAt(home: string, desktop: DesktopDetection, launched: DesktopLaunchTarget[]) {
  return new OnboardingManager({
    stateRoot: join(home, 'plugin'), apiBaseUrl: 'https://api.example.test', connectorSourceDir: home, uvPath: 'uv',
  }, {
    detect: async () => desktop,
    launchDesktop: async (target) => { launched.push(target) },
    connector: { onState: () => () => {}, prepare: async () => {}, start: async () => {}, stop: async () => {}, assertHealthy: async () => {} },
    checkServer: async () => {}, machineState: localMachineRegistry(home),
  })
}

test('desktop detection carries the recorded launch arguments', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-desktop-detect-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeDesktopRecord(home, {
    platform: process.platform, executablePath: process.execPath, launchArgs: ['/repo/desktop-workbench'],
    packaged: false, appPath: home,
  })
  const detected = await detectDesktop(home, process.platform)
  assert.equal(detected.status, 'installed')
  assert.equal(detected.status === 'installed' && detected.executablePath, process.execPath)
  assert.deepEqual(detected.status === 'installed' && detected.launchArgs, ['/repo/desktop-workbench'])
  assert.equal(detected.status === 'installed' && detected.packaged, false)

  await writeDesktopRecord(home, { platform: process.platform, executablePath: process.execPath, launchArgs: [''] })
  assert.equal((await detectDesktop(home, process.platform)).status, 'error')
  await writeDesktopRecord(home, { platform: process.platform, executablePath: process.execPath, packaged: 'yes' })
  assert.equal((await detectDesktop(home, process.platform)).status, 'error')
});

test('the onboarding URL carries only a validated flow id', () => {
  const flowId = newDesktopFlowId()
  assert.match(flowId, /^[A-Za-z0-9_-]{16,100}$/)
  assert.equal(desktopOnboardingUrl(flowId), `agents-anywhere-desktop://onboarding?source=dsh-plugin&flowId=${flowId}`)
});

test('an installed Desktop is opened on its own onboarding entry', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-desktop-open-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const launched: DesktopLaunchTarget[] = []
  const manager = managerAt(home, {
    status: 'installed', message: 'installed', executablePath: '/example/Desktop', launchArgs: ['/repo/desktop'], packaged: false,
  }, launched)
  try {
    const first = await manager.openDesktop()
    const second = await manager.openDesktop()
    assert.match(first.url, /^agents-anywhere-desktop:\/\/onboarding\?source=dsh-plugin&flowId=/)
    assert.notEqual(first.flowId, second.flowId, 'every request starts a new flow')
    assert.deepEqual(launched, [
      { executablePath: '/example/Desktop', launchArgs: ['/repo/desktop'], packaged: false },
      { executablePath: '/example/Desktop', launchArgs: ['/repo/desktop'], packaged: false },
    ])
  } finally {
    await manager.dispose()
  }
});

test('opening Desktop fails with the detection message when it is not installed', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-desktop-absent-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const launched: DesktopLaunchTarget[] = []
  const manager = managerAt(home, { status: 'absent', message: '未找到桌面端安装记录。' }, launched)
  try {
    await assert.rejects(() => manager.openDesktop(), /未找到桌面端安装记录/)
    assert.deepEqual(launched, [])
  } finally {
    await manager.dispose()
  }
});

test('a launch failure is reported without leaking the command', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'aa-desktop-fail-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const manager = new OnboardingManager({
    stateRoot: join(home, 'plugin'), apiBaseUrl: 'https://api.example.test', connectorSourceDir: home, uvPath: 'uv',
  }, {
    detect: async () => ({ status: 'installed', message: 'installed', executablePath: '/example/Desktop', launchArgs: [], packaged: true }),
    launchDesktop: async () => { throw new Error('spawn failed') },
    connector: { onState: () => () => {}, prepare: async () => {}, start: async () => {}, stop: async () => {}, assertHealthy: async () => {} },
    checkServer: async () => {}, machineState: localMachineRegistry(home),
  })
  try {
    await assert.rejects(() => manager.openDesktop(), /无法打开 Agents Anywhere 桌面端：spawn failed/)
  } finally {
    await manager.dispose()
  }
});
