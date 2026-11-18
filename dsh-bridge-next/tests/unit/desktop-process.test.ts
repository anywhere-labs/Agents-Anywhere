import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectDesktop } from '../../src/host/desktop/detect.js'
import {
  matchesDesktopProcess, parseTasklistPids, parseWindowsProcesses, windowsDesktopProbe,
  type DesktopProcessCandidate, type WindowsProcessQueries,
} from '../../src/host/desktop/process.js'
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

test('the Windows process id survives parsing for the cheap follow-up checks', () => {
  const path = 'C:\\Program Files\\Agents Anywhere\\Agents Anywhere.exe'
  assert.deepEqual(parseWindowsProcesses(JSON.stringify({ ProcessId: 4242, ExecutablePath: path, CommandLine: `"${path}"` })),
    [{ pid: 4242, executablePath: path, commandLine: `"${path}"` }])
})

test('tasklist rows give process ids, whatever language the empty answer is printed in', () => {
  assert.deepEqual(parseTasklistPids('"Agents Anywhere.exe","4242","Console","1","182,340 K"\r\n"Agents Anywhere.exe","4300","Console","1","91,002 K"\r\n'), [4242, 4300])
  assert.deepEqual(parseTasklistPids('INFO: No tasks are running which match the specified criteria.\r\n'), [])
  assert.deepEqual(parseTasklistPids('\u4FE1\u606F: \u6CA1\u6709\u8FD0\u884C\u7684\u4EFB\u52A1\u5339\u914D\u6307\u5B9A\u6807\u51C6\u3002\r\n'), [])
  assert.deepEqual(parseTasklistPids('', 'INFO: No tasks are running which match the specified criteria.\r\n'), [],
    'some Windows versions print the notice on stderr')
  assert.throws(() => parseTasklistPids('  \r\n'), /printed nothing/, 'no output at all is not an answer')
})

const windowsTarget = { executablePath: 'C:\\Apps\\Agents Anywhere\\Agents Anywhere.exe', launchArgs: [], packaged: true }
const windowsMain = (pid: number): DesktopProcessCandidate => ({ pid, executablePath: windowsTarget.executablePath, commandLine: `"${windowsTarget.executablePath}"` })
const windowsHelper = (pid: number): DesktopProcessCandidate => ({ ...windowsMain(pid), commandLine: `"${windowsTarget.executablePath}" --type=renderer` })

/** A scripted machine that counts how often each query runs. */
function windowsMachine() {
  const machine = {
    clock: 0, pids: [] as number[], candidates: [] as DesktopProcessCandidate[], dead: new Set<number>(),
    imagePidCalls: 0, fullQueries: 0, tasklistError: null as Error | null, fullQueryError: null as Error | null,
  }
  const queries: WindowsProcessQueries = {
    imagePids: async () => { machine.imagePidCalls++; if (machine.tasklistError) throw machine.tasklistError; return machine.pids },
    candidates: async () => { machine.fullQueries++; if (machine.fullQueryError) throw machine.fullQueryError; return machine.candidates },
    alive: pid => !machine.dead.has(pid),
  }
  return { machine, probe: windowsDesktopProbe(queries, () => machine.clock) }
}

test('an idle Windows poll never starts PowerShell', async () => {
  const { machine, probe } = windowsMachine()
  for (let poll = 0; poll < 40; poll++) assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.imagePidCalls, 40)
  assert.equal(machine.fullQueries, 0)
})

test('Windows identifies Desktop once on the first poll that sees it, then only watches its process', async () => {
  const { machine, probe } = windowsMachine()
  assert.equal(await probe(windowsTarget), false)
  machine.pids = [100, 101]
  machine.candidates = [windowsMain(100), windowsHelper(101)]
  assert.equal(await probe(windowsTarget), true, 'the first poll after Desktop starts already reports it')
  assert.equal(machine.fullQueries, 1)
  const listed = machine.imagePidCalls
  for (let poll = 0; poll < 20; poll++) assert.equal(await probe(windowsTarget), true)
  assert.equal(machine.fullQueries, 1, 'a running Desktop is not queried again')
  assert.equal(machine.imagePidCalls, listed, 'nor listed, while its main process is alive')
})

test('Windows reports Desktop gone as soon as its main process exits, without PowerShell', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [100]
  machine.candidates = [windowsMain(100)]
  assert.equal(await probe(windowsTarget), true)
  machine.dead.add(100)
  machine.pids = []
  machine.candidates = []
  assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, 1)
})

test('helpers left behind by Desktop are identified once and do not count as Desktop', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [100, 101]
  machine.candidates = [windowsMain(100), windowsHelper(101)]
  assert.equal(await probe(windowsTarget), true)
  machine.dead.add(100)
  machine.pids = [101]
  machine.candidates = [windowsHelper(101)]
  assert.equal(await probe(windowsTarget), false, 'a helper alone is not a running Desktop')
  const queries = machine.fullQueries
  for (let poll = 0; poll < 10; poll++) assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, queries, 'the same helper is not identified again')
})

test('a new process next to known helpers is identified right away', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [101]
  machine.candidates = [windowsHelper(101)]
  assert.equal(await probe(windowsTarget), false)
  machine.pids = [101, 200]
  machine.candidates = [windowsHelper(101), windowsMain(200)]
  assert.equal(await probe(windowsTarget), true)
  assert.equal(machine.fullQueries, 2)
})

test('a process the full query cannot read is retried soon, not on every poll', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [300]
  assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, 1)
  machine.clock += 1_500
  assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, 1, 'another user\'s process must not bring back a query per poll')
  machine.clock += 3_500
  machine.candidates = [windowsMain(300)]
  assert.equal(await probe(windowsTarget), true, 'a process that was still starting is found within seconds')
  assert.equal(machine.fullQueries, 2)
})

test('a running Desktop is confirmed by its image name every minute, not by PowerShell', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [100, 101]
  machine.candidates = [windowsMain(100), windowsHelper(101)]
  assert.equal(await probe(windowsTarget), true)
  const listed = machine.imagePidCalls
  machine.clock += 59_999
  assert.equal(await probe(windowsTarget), true)
  assert.equal(machine.imagePidCalls, listed, 'a PID that is alive is trusted for a minute')
  machine.clock += 1
  assert.equal(await probe(windowsTarget), true)
  assert.equal(machine.imagePidCalls, listed + 1)
  machine.clock += 30_000
  assert.equal(await probe(windowsTarget), true)
  assert.equal(machine.imagePidCalls, listed + 1, 'the confirmation starts another minute')
  assert.equal(machine.fullQueries, 1)
})

test('a process id another program reused stops counting as Desktop within a minute', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [100]
  machine.candidates = [windowsMain(100)]
  assert.equal(await probe(windowsTarget), true)
  // Desktop exited and an unrelated program now runs with PID 100.
  machine.pids = []
  machine.candidates = []
  assert.equal(await probe(windowsTarget), true, 'between two image checks only the PID is looked at')
  machine.clock += 60_000
  assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, 1)
})

test('a changed installation record is checked against the running processes again', async () => {
  const { machine, probe } = windowsMachine()
  const moved = { ...windowsTarget, executablePath: 'D:\\Apps\\Agents Anywhere.exe' }
  machine.pids = [100]
  machine.candidates = [{ pid: 100, executablePath: moved.executablePath, commandLine: `"${moved.executablePath}"` }]
  assert.equal(await probe(windowsTarget), false, 'the old record does not describe this process')
  assert.equal(await probe(moved), true, 'Desktop publishing its new location is picked up on the next poll')
  assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, 3)
})

test('without tasklist every Windows poll falls back to the full query', async () => {
  const { machine, probe } = windowsMachine()
  machine.tasklistError = new Error('spawn tasklist.exe ENOENT')
  assert.equal(await probe(windowsTarget), false)
  assert.equal(await probe(windowsTarget), false)
  assert.equal(machine.fullQueries, 2)
  machine.candidates = [windowsMain(100)]
  assert.equal(await probe(windowsTarget), true)
})

test('a failed full query is reported instead of being read as "not running"', async () => {
  const { machine, probe } = windowsMachine()
  machine.pids = [100]
  machine.fullQueryError = new Error('powershell.exe timed out')
  await assert.rejects(() => probe(windowsTarget), /timed out/)
  machine.fullQueryError = null
  machine.candidates = [windowsMain(100)]
  assert.equal(await probe(windowsTarget), true, 'the failed attempt leaves nothing behind')
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
