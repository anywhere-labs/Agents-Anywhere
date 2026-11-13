import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectDesktop } from '../../src/host/desktop/detect.js'
import { matchesDesktopProcess, parseWindowsProcesses } from '../../src/host/desktop/process.js'
import { localRuntimePath } from '../../src/host/desktop/local-runtime.js'
import { writeJson } from '../../src/host/storage/files.js'

test('matches only the installed Desktop main process, including development arguments', () => {
  const packaged = { executablePath: '/Applications/Agents Anywhere.app/Contents/MacOS/Agents Anywhere', launchArgs: [], packaged: true }
  assert.equal(matchesDesktopProcess(packaged, {
    executablePath: packaged.executablePath, commandLine: `${packaged.executablePath} --some-flag`,
  }, 'darwin'), true)
  assert.equal(matchesDesktopProcess(packaged, {
    executablePath: packaged.executablePath, commandLine: `${packaged.executablePath} --type=renderer`,
  }, 'darwin'), false)
  assert.equal(matchesDesktopProcess(packaged, {
    executablePath: `${packaged.executablePath}-helper`, commandLine: `${packaged.executablePath}-helper`,
  }, 'darwin'), false)
  assert.equal(matchesDesktopProcess(packaged, {
    executablePath: packaged.executablePath, commandLine: `${packaged.executablePath} /Applications/Agents Anywhere.app/Contents/Resources/app/backend/index.js payload`,
  }, 'darwin'), false)

  const dev = { executablePath: '/usr/bin/electron', launchArgs: ['/repo/desktop-workbench'], packaged: false }
  assert.equal(matchesDesktopProcess(dev, {
    executablePath: dev.executablePath, commandLine: '/usr/bin/electron /repo/desktop-workbench',
  }, 'linux'), true)
  assert.equal(matchesDesktopProcess(dev, {
    executablePath: dev.executablePath, commandLine: '/usr/bin/electron .',
  }, 'linux'), false)
  assert.equal(matchesDesktopProcess(dev, {
    executablePath: dev.executablePath, commandLine: '/usr/bin/electron /repo/other-app',
  }, 'linux'), false)
  assert.equal(matchesDesktopProcess(dev, {
    executablePath: dev.executablePath, commandLine: '/usr/bin/electron /repo/desktop-workbench --type=gpu-process',
  }, 'linux'), false)

  const localDev = {
    executablePath: '/repo/desktop-workbench/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    launchArgs: ['/repo/desktop-workbench'],
    packaged: false,
  }
  assert.equal(matchesDesktopProcess(localDev, {
    executablePath: localDev.executablePath,
    commandLine: `${localDev.executablePath} .`,
  }, 'darwin'), true)
  assert.equal(matchesDesktopProcess(localDev, {
    executablePath: localDev.executablePath,
    commandLine: `${localDev.executablePath} . --type=renderer`,
  }, 'darwin'), false)

  assert.equal(matchesDesktopProcess({ executablePath: 'C:\\Program Files\\Agents Anywhere\\Agents Anywhere.exe', launchArgs: [], packaged: true }, {
    executablePath: 'c:\\program files\\agents anywhere\\agents anywhere.exe',
    commandLine: '"C:\\Program Files\\Agents Anywhere\\Agents Anywhere.exe"',
  }, 'win32'), true)
  assert.equal(matchesDesktopProcess({ executablePath: '/home/user/Agents Anywhere.AppImage', launchArgs: [], packaged: true }, {
    executablePath: '/tmp/.mount_agents/AppRun', appImagePath: '/home/user/Agents Anywhere.AppImage', appDir: '/tmp/.mount_agents',
    commandLine: '/tmp/.mount_agents/AppRun',
  }, 'linux'), true)
  assert.equal(matchesDesktopProcess({ executablePath: '/home/user/Agents Anywhere.AppImage', launchArgs: [], packaged: true }, {
    executablePath: '/usr/bin/python', appImagePath: '/home/user/Agents Anywhere.AppImage', appDir: '/tmp/.mount_agents',
    commandLine: '/usr/bin/python -m connector',
  }, 'linux'), false)
  assert.equal(matchesDesktopProcess({ executablePath: '/home/user/Agents Anywhere.AppImage', launchArgs: [], packaged: true }, {
    executablePath: '/tmp/.mount_agents/AppRun', appImagePath: '/home/user/Agents Anywhere.AppImage', appDir: '/tmp/.mount_agents',
    electronRunAsNode: true, commandLine: '/tmp/.mount_agents/AppRun /app/backend/index.js',
  }, 'linux'), false)
})

test('an empty Windows process query means no Desktop process, while unreadable output still fails', () => {
  const path = 'C:\\Program Files\\Agents Anywhere\\Agents Anywhere.exe'
  assert.deepEqual(parseWindowsProcesses(''), [], 'ConvertTo-Json prints nothing when no process matches')
  assert.deepEqual(parseWindowsProcesses('\uFEFF\r\n'), [])
  assert.deepEqual(parseWindowsProcesses(`\uFEFF${JSON.stringify({ ExecutablePath: path, CommandLine: `"${path}"` })}\r\n`),
    [{ executablePath: path, commandLine: `"${path}"` }])
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([
    { ExecutablePath: null, CommandLine: null },
    { ExecutablePath: path, CommandLine: `"${path}" --flag` },
  ])), [{ executablePath: path, commandLine: `"${path}" --flag` }])
  assert.throws(() => parseWindowsProcesses('Get-CimInstance : Access denied'), SyntaxError)
})

test('an installed Desktop is absent when no process has its executable name', { timeout: 12_000 }, async t => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) return t.skip('process inspection is not supported on this platform')
  const home = await mkdtemp(join(tmpdir(), 'aa-desktop-stopped-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  // On Windows the unique name makes the real PowerShell query match nothing and print nothing.
  const executablePath = join(home, `aa-desktop-stopped-${process.pid}-${Date.now()}${process.platform === 'win32' ? '.exe' : ''}`)
  await writeFile(executablePath, '', { mode: 0o755 })
  await writeJson(localRuntimePath(home), {
    version: 2, connectorIds: [], legacyMachineMigrated: true,
    desktop: { platform: process.platform, executablePath, packaged: true },
  })
  const detected = await detectDesktop(home)
  assert.equal(detected.status, 'absent', detected.message)
})

test('the installed process appears and disappears without changing its installation record', { timeout: 12_000 }, async t => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) return t.skip('process inspection is not supported on this platform')
  const home = await mkdtemp(join(tmpdir(), 'aa-desktop-process-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const marker = `aa-desktop-test-${process.pid}-${Date.now()}`
  await writeJson(localRuntimePath(home), {
    version: 2, connectorIds: [], legacyMachineMigrated: true,
    desktop: { platform: process.platform, executablePath: process.execPath, appPath: home, packaged: false, launchArgs: [home, marker] },
  })
  assert.equal((await detectDesktop(home)).status, 'absent')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', home, marker], { stdio: 'ignore' })
  const ended = once(child, 'exit')
  try {
    await once(child, 'spawn')
    assert.equal((await detectDesktop(home)).status, 'installed')
  } finally {
    child.kill()
    await ended
  }
  assert.equal((await detectDesktop(home)).status, 'absent')
})
