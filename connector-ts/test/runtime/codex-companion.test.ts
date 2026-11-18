// Codex companion: auto-follow, deeplink handover, the two-step quit-the-App flow, rollout permissions, the Windows write-lock fallback, attachments.
// Never touches real processes or the real App: the process table, signals, URL opener and write-lock directory are injected stand-ins.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeHandleEvent } from '../../src/application/ports/runtime-session.js'
import { codexPermissionSelectionId } from '../../src/domain/identity/index.js'
import { RuntimeFailure } from '../../src/runtime/acp/errors.js'
import { AcpRuntimeHandle, peerConnection } from '../../src/runtime/acp/handle.js'
import { JsonRpcError } from '../../src/runtime/acp/jsonrpc.js'
import { promptBlocks } from '../../src/runtime/acp/session.js'
import {
  CodexAppQuitter,
  CodexAutoFollow,
  CodexRuntimeHandle,
  descendants,
  desktopAppProcesses,
  findRollout,
  openerCommand,
  parseInspection,
  parsePsListing,
  parseWindowsListing,
  permissionSelectionFromSettings,
  resolveCodexHome,
  rolloutPermissionSettings,
  threadCreatedAt,
  threadDeeplink,
  type CodexInspection,
  type CodexOpenRoute,
  type LockDirectory,
  type LockEntry,
  type ProcessInfo,
  type ProcessSignaller,
  type ProcessTable,
} from '../../src/runtime/companions/codex/index.js'
import type { AgentInfo } from '../../src/runtime/acp/client.js'
import { CODEX, codexDialect, codexLocalImageLinks } from '../../src/runtime/profiles/codex/index.js'
import { checkDefinition, validateSettings } from '../../src/runtime/profiles/definition.js'
import { FakeAcpAgent, tick, type Json } from '../support/fake-acp-agent.js'

const T1 = '01a1e508-69f1-70e0-9472-2f2180265141'
const T2 = '01a1e4c8-5f17-7421-a95b-54744b0399e9'

const follow: CodexInspection = { ownership: 'external', execution: 'idle', control: 'ipc', route: 'follow' }
const running: CodexInspection = { ...follow, execution: 'running' }
const blockedHeld: CodexInspection = { ownership: 'external', execution: 'unknown', control: 'unavailable', route: 'blocked', writerLock: { state: 'held', reason: 'contended' } }
const resumable: CodexInspection = { ownership: 'unowned', execution: 'unknown', control: 'localAppServer', route: 'resume', writerLock: { state: 'unheld', reason: 'missing' } }
const windowsUnknown: CodexInspection = { ownership: 'unknown', execution: 'unknown', control: 'unavailable', route: 'blocked', writerLock: { state: 'unknown', reason: 'unsupported-platform' } }

const APP: ProcessInfo = { pid: 54846, ppid: 1, uid: 501, startedAt: 'Mon Nov 16 18:19:54 2026', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }
const APP_SERVER: ProcessInfo = { pid: 12512, ppid: 54846, uid: 501, startedAt: 'Mon Nov 16 22:33:36 2026', executable: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' }

/** Controllable process table: the test decides whether a signal makes a process exit. */
class FakeProcesses implements ProcessTable, ProcessSignaller {
  table: ProcessInfo[] = []
  readonly signals: string[] = []
  exitOnTerm = true
  exitOnKill = true
  async list() {
    return [...this.table]
  }
  async terminate(p: ProcessInfo) {
    this.signals.push(`TERM ${p.pid}`)
    if (this.exitOnTerm) this.table = this.table.filter(x => x.pid !== p.pid && x.ppid !== p.pid)
  }
  async kill(p: ProcessInfo) {
    this.signals.push(`KILL ${p.pid}`)
    if (this.exitOnKill) this.table = this.table.filter(x => x.pid !== p.pid && x.ppid !== p.pid)
  }
}

class FakeLocks implements LockDirectory {
  entries: LockEntry[] = []
  onChange: (() => void) | undefined
  async list() {
    return [...this.entries]
  }
  watch(onChange: () => void) {
    this.onChange = onChange
    return () => { this.onChange = undefined }
  }
}

describe('Codex inspect parsing', () => {
  it('reads the codex-acp response shape and never guesses optimistically', () => {
    // response from a real codex-acp 2.6.0 (held by the ChatGPT App, nobody answering).
    const blocked = parseInspection({ ownership: 'external', execution: 'unknown', control: 'unavailable', route: 'blocked', publication: 'withdrawn', archiveReceipt: null, writerLock: 'held', writerLockObservation: { state: 'held', reason: 'contended', observedAt: 1794845016416, fileIdentity: '16777234:98305753' } })
    expect(blocked).toEqual({ ownership: 'external', execution: 'unknown', control: 'unavailable', route: 'blocked', writerLock: { state: 'held', reason: 'contended', observedAt: 1794845016416, fileIdentity: '16777234:98305753' } })
    expect(parseInspection({ ownership: 'external', execution: 'idle', control: 'ipc', route: 'follow' })).toEqual(follow)
    expect(parseInspection({ route: 'teleport', ownership: 'mine' })).toMatchObject({ route: 'blocked', ownership: 'unknown', control: 'unavailable' })
  })
})

describe('Codex deeplink', () => {
  it('builds codex://threads/<id> only for UUID thread ids and opens it in the background', () => {
    expect(threadDeeplink(T1.toUpperCase())).toBe(`codex://threads/${T1}`)
    expect(() => threadDeeplink('../etc')).toThrow()
    expect(openerCommand('codex://threads/x', 'darwin')).toEqual(['open', '-g', 'codex://threads/x'])
    expect(openerCommand('codex://threads/x', 'linux')).toEqual(['xdg-open', 'codex://threads/x'])
    expect(openerCommand('codex://threads/x', 'win32')).toEqual(['rundll32.exe', 'url.dll,FileProtocolHandler', 'codex://threads/x'])
    expect(openerCommand('codex://threads/x', 'aix')).toBeUndefined()
  })
})

describe('Codex App processes', () => {
  it('parses ps output with lstart and finds the main process of this user only', () => {
    const table = parsePsListing([
      '54846     1   501 Mon Nov 16 18:19:54 2026     /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      '12512 54846   501 Mon Nov 16 22:33:36 2026     /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '  777     1   502 Mon Nov 16 09:00:00 2026     /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    ].join('\n'))
    expect(table[0]).toEqual(APP)
    expect(desktopAppProcesses(table, 'darwin', 501)).toEqual([APP])
    expect(descendants(table, APP)).toEqual([APP_SERVER])
  })

  it('picks the root ChatGPT.exe of the Codex package on Windows', () => {
    const exe = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.0_x64__abc\\app\\ChatGPT.exe'
    const table = parseWindowsListing(JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, CreationDate: '2026-11-16T10:00:00.0000000+08:00', ExecutablePath: exe },
      { ProcessId: 11, ParentProcessId: 10, CreationDate: '2026-11-16T10:00:01.0000000+08:00', ExecutablePath: exe },
      { ProcessId: 12, ParentProcessId: 4, CreationDate: '2026-11-16T10:00:00.0000000+08:00', ExecutablePath: 'C:\\Other\\ChatGPT.exe' },
    ]))
    expect(desktopAppProcesses(table, 'win32').map(p => p.pid)).toEqual([10])
    expect(parseWindowsListing('{"ProcessId":3,"ParentProcessId":1,"CreationDate":"x","ExecutablePath":"C:\\\\a.exe"}')).toHaveLength(1)
  })
})

describe('Quitting the Codex App (two steps, explicit consent)', () => {
  function quitter(states: Map<string, CodexInspection>, processes: FakeProcesses, now = { t: 1_000 }) {
    return new CodexAppQuitter({
      table: processes,
      signaller: processes,
      inspect: async id => states.get(id) ?? resumable,
      platform: 'darwin',
      uid: 501,
      gracePeriodMs: 50,
      pollMs: 5,
      planTtlMs: 1_000,
      now: () => now.t,
      sleep: async ms => { now.t += ms },
    })
  }

  it('does not plan a termination when the thread can be followed or is free', async () => {
    const processes = new FakeProcesses()
    processes.table = [APP]
    expect((await quitter(new Map([[T1, follow]]), processes).prepare([T1])).status).toBe('not_needed')
    expect((await quitter(new Map([[T1, resumable]]), processes).prepare([T1])).status).toBe('not_needed')
    expect(processes.signals).toEqual([])
  })

  it('reports a missing App and an unsupported platform', async () => {
    const processes = new FakeProcesses()
    expect((await quitter(new Map([[T1, blockedHeld]]), processes).prepare([T1])).status).toBe('app_not_running')
    const unsupported = new CodexAppQuitter({ table: processes, signaller: processes, inspect: async () => blockedHeld, platform: 'aix' })
    expect((await unsupported.prepare([T1])).status).toBe('platform_unsupported')
  })

  it('plans first, signals only after consent, then confirms exit and lock release', async () => {
    const states = new Map([[T1, blockedHeld]])
    const processes = new FakeProcesses()
    processes.table = [APP, APP_SERVER]
    const q = quitter(states, processes)
    const prepared = await q.prepare([T1])
    if (prepared.status !== 'plan') throw new Error(prepared.status)
    expect(prepared.plan.processes).toEqual([APP])
    expect(prepared.plan.children).toEqual([APP_SERVER])
    expect(prepared.plan.threads).toEqual([{ threadId: T1, route: 'blocked', writerLock: 'held' }])
    expect(processes.signals).toEqual([])
    const terminate = processes.terminate.bind(processes)
    processes.terminate = async p => {
      await terminate(p)
      states.set(T1, resumable)
    }
    const outcome = await q.execute(prepared.plan.planId, { force: false })
    expect(outcome).toMatchObject({ status: 'completed', terminated: [APP.pid], killed: [], survivors: [], childSurvivors: [] })
    expect(outcome.threads).toEqual([{ threadId: T1, route: 'resume', writerLock: 'unheld' }])
    expect(processes.signals).toEqual([`TERM ${APP.pid}`])
    // a plan can be used only once.
    expect((await q.execute(prepared.plan.planId, { force: false })).status).toBe('unknown_plan')
  })

  it('refuses a stale plan: expired, PID reused, or another App instance appeared', async () => {
    const states = new Map([[T1, blockedHeld]])
    const processes = new FakeProcesses()
    processes.table = [APP]
    const now = { t: 1_000 }
    const q = quitter(states, processes, now)

    const expired = await q.prepare([T1])
    if (expired.status !== 'plan') throw new Error(expired.status)
    now.t += 5_000
    expect((await q.execute(expired.plan.planId, { force: true })).status).toBe('plan_expired')

    const reused = await q.prepare([T1])
    if (reused.status !== 'plan') throw new Error(reused.status)
    processes.table = [{ ...APP, startedAt: 'Tue Nov 17 08:00:00 2026' }]
    expect((await q.execute(reused.plan.planId, { force: true })).status).toBe('plan_changed')

    processes.table = [APP]
    const grown = await q.prepare([T1])
    if (grown.status !== 'plan') throw new Error(grown.status)
    processes.table = [APP, { ...APP, pid: 999, startedAt: 'Tue Nov 17 09:00:00 2026' }]
    expect((await q.execute(grown.plan.planId, { force: true })).status).toBe('plan_changed')
    expect(processes.signals).toEqual([])
  })

  it('does not signal when the thread was released in the meantime', async () => {
    const states = new Map([[T1, blockedHeld]])
    const processes = new FakeProcesses()
    processes.table = [APP]
    const q = quitter(states, processes)
    const prepared = await q.prepare([T1])
    if (prepared.status !== 'plan') throw new Error(prepared.status)
    states.set(T1, follow)
    expect((await q.execute(prepared.plan.planId, { force: true })).status).toBe('already_released')
    expect(processes.signals).toEqual([])
  })

  it('escalates to a forced kill only with consent for it', async () => {
    const states = new Map([[T1, blockedHeld]])
    const processes = new FakeProcesses()
    processes.exitOnTerm = false
    processes.table = [APP]
    const q = quitter(states, processes)
    const first = await q.prepare([T1])
    if (first.status !== 'plan') throw new Error(first.status)
    expect(await q.execute(first.plan.planId, { force: false })).toMatchObject({ status: 'survivors', survivors: [APP.pid], killed: [] })
    expect(processes.signals).toEqual([`TERM ${APP.pid}`])

    const second = await q.prepare([T1])
    if (second.status !== 'plan') throw new Error(second.status)
    const kill = processes.kill.bind(processes)
    processes.kill = async p => {
      await kill(p)
      states.set(T1, resumable)
    }
    expect(await q.execute(second.plan.planId, { force: true })).toMatchObject({ status: 'completed', killed: [APP.pid], survivors: [] })
  })

  it('reports a writer lock that is still held after the App exited', async () => {
    const states = new Map([[T1, blockedHeld]])
    const processes = new FakeProcesses()
    processes.table = [APP]
    const q = quitter(states, processes)
    const prepared = await q.prepare([T1])
    if (prepared.status !== 'plan') throw new Error(prepared.status)
    expect((await q.execute(prepared.plan.planId, { force: false })).status).toBe('lock_still_held')
  })
})

describe('Codex auto-follow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(answers: (id: string, call: number) => CodexInspection) {
    const locks = new FakeLocks()
    const calls = new Map<string, number>()
    const suggested: string[] = []
    const attached = new Set<string>()
    const auto = new CodexAutoFollow({
      locks,
      inspect: async id => {
        const n = (calls.get(id) ?? 0) + 1
        calls.set(id, n)
        return answers(id, n)
      },
      isAttached: id => attached.has(id),
      suggest: (id, reason) => suggested.push(`${id}:${reason}`),
      raceRetryDelayMs: 1,
      raceRetryAttempts: 2,
      debounceMs: 1,
    })
    return { locks, calls, suggested, attached, auto }
  }

  it('suggests a followable thread once per holding period', async () => {
    const { locks, suggested, auto } = setup(id => (id === T1 ? running : resumable))
    locks.entries = [{ threadId: T1, mtimeMs: 1 }, { threadId: T2, mtimeMs: 2 }]
    await auto.scan()
    await auto.scan()
    expect(suggested).toEqual([`${T1}:external_owner_running`])
    // the lock file disappears and reappears: a new holding period, suggested again.
    locks.entries = []
    await auto.scan()
    locks.entries = [{ threadId: T1, mtimeMs: 3 }]
    await auto.scan()
    expect(suggested).toEqual([`${T1}:external_owner_running`, `${T1}:external_owner_running`])
    auto.stop()
  })

  it('retries a new thread whose owner registers after the lock appears (bounded)', async () => {
    vi.useFakeTimers()
    const { locks, calls, suggested, auto } = setup((_id, call) => (call < 3 ? blockedHeld : follow))
    locks.entries = [{ threadId: T1, mtimeMs: 1 }]
    await auto.scan()
    // Each retry is a timer that leads to a scan: run them, and the ones they schedule, until none is left.
    await vi.runAllTimersAsync()
    expect(suggested).toEqual([`${T1}:external_owner`])
    expect(calls.get(T1)).toBe(3)
    auto.stop()
  })

  it('stops retrying after the bound and does not touch threads AA already has open', async () => {
    vi.useFakeTimers()
    const { locks, calls, suggested, attached, auto } = setup(() => blockedHeld)
    locks.entries = [{ threadId: T1, mtimeMs: 1 }, { threadId: T2, mtimeMs: 1 }]
    attached.add(T2)
    await auto.scan()
    // Runs every retry until none is scheduled; retries that never stopped would exhaust the loop limit instead.
    await vi.runAllTimersAsync()
    expect(vi.getTimerCount()).toBe(0)
    expect(calls.get(T1)).toBe(3) // 1 call + 2 retries
    expect(calls.get(T2)).toBeUndefined()
    expect(suggested).toEqual([])
    auto.stop()
  })

  it('rescans when the lock directory changes', async () => {
    vi.useFakeTimers()
    const { locks, suggested, auto } = setup(() => follow)
    auto.start()
    // The first scan runs at once; the change is debounced by 1 ms. The 30 s poll never fires here.
    await vi.advanceTimersByTimeAsync(0)
    locks.entries = [{ threadId: T1, mtimeMs: 1 }]
    locks.onChange?.()
    await vi.advanceTimersByTimeAsync(1)
    expect(suggested).toEqual([`${T1}:external_owner`])
    auto.stop()
  })
})

describe('Rollout permission settings', () => {
  const settingsRecord = (approval: string, reviewer: string, writable: boolean) => JSON.stringify({
    timestamp: '2026-11-16T15:48:07.500Z', type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { approval_policy: approval, approvals_reviewer: reviewer, permission_profile: { type: 'managed', file_system: { type: 'restricted', entries: [{ access: 'read' }, ...(writable ? [{ access: 'write' }] : [])] } } } },
  })

  it('reads the newest settings record from the end and maps it to the v2 permission catalog', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-codex-home-'))
    const created = threadCreatedAt(T1)!
    const day = join(home, 'sessions', String(created.getFullYear()), String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0'))
    mkdirSync(day, { recursive: true })
    const path = join(day, `rollout-2026-11-16T23-44-56-${T1}.jsonl`)
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', payload: { id: T1 } }),
      JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } }),
      settingsRecord('on-request', 'auto_review', true),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
      '{"type":"turn_context","payload":{"approval_pol', // a half line still being appended
    ].join('\n'))
    expect(await findRollout(home, T1)).toBe(path)
    expect(await rolloutPermissionSettings(path)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' })
    expect(permissionSelectionFromSettings(await rolloutPermissionSettings(path))).toBe(codexPermissionSelectionId('auto_review', { permission_mode: 'auto_review' }))

    // threads that are not UUIDv7: search date directories newest first; the archive directory is the fallback.
    const other = '019ec9ee-060d-4e01-a46f-1a3264c0c313'
    mkdirSync(join(home, 'archived_sessions'), { recursive: true })
    writeFileSync(join(home, 'archived_sessions', `rollout-2026-06-15T14-18-00-${other}.jsonl`), JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'dangerFullAccess' } } }))
    expect(threadCreatedAt(other)).toBeUndefined()
    const archived = await findRollout(home, other)
    expect(permissionSelectionFromSettings(await rolloutPermissionSettings(archived))).toBe(codexPermissionSelectionId('full_access', { permission_mode: 'full_access' }))
    expect(await rolloutPermissionSettings(join(home, 'missing.jsonl'))).toEqual({})
  })

  it('follows the v2 matching rules and reports unknown instead of a default', () => {
    expect(permissionSelectionFromSettings({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' })).toBe(codexPermissionSelectionId('request_approval', { permission_mode: 'request_approval' }))
    // full access has no fixed reviewer, so Codex's default user also matches.
    expect(permissionSelectionFromSettings({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' })).toBe(codexPermissionSelectionId('full_access', { permission_mode: 'full_access' }))
    // on-request with an unknown reviewer: both entries fix a reviewer, so it cannot be decided.
    expect(permissionSelectionFromSettings({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })).toBeUndefined()
    expect(permissionSelectionFromSettings({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' })).toBeUndefined()
    expect(permissionSelectionFromSettings({})).toBeUndefined()
  })
})

describe('Codex companion handle', () => {
  function codexAgent(inspections: (id: string, call: number) => CodexInspection | Error) {
    const agent = new FakeAcpAgent()
    let call = 0
    agent.peer.onRequest('_codex/session/inspect', params => {
      agent.received.push({ method: '_codex/session/inspect', params: params as Json })
      const answer = inspections((params as Json).sessionId as string, ++call)
      if (answer instanceof Error) throw answer
      // codex-acp's wire shape: writerLock is a string, details are in writerLockObservation.
      const { writerLock, ...rest } = answer
      return { ...rest, publication: 'withdrawn', archiveReceipt: null, ...(writerLock ? { writerLock: writerLock.state, writerLockObservation: writerLock } : {}) }
    })
    return agent
  }

  function companion(agent: FakeAcpAgent, options: { platform?: NodeJS.Platform; app?: boolean; installed?: boolean; opens?: boolean; locks?: FakeLocks; codexHome?: string } = {}) {
    const routes = new Map<string, CodexOpenRoute>()
    const dialect = codexDialect({ openRoute: ref => routes.get(ref.nativeSessionId) ?? 'auto' })
    const inner = new AcpRuntimeHandle({ type: 'codex', instanceId: 'i1', dialect, connect: peerConnection(agent.clientPeer, dialect) })
    const processes = new FakeProcesses()
    if (options.app !== false) processes.table = [APP]
    const opened: string[] = []
    const handle = new CodexRuntimeHandle(inner, routes, {
      codexHome: options.codexHome ?? '/nonexistent',
      platform: options.platform ?? 'darwin',
      uid: 501,
      processes,
      signaller: processes,
      opener: async url => { opened.push(url); return options.opens !== false },
      appInstalled: () => options.installed !== false,
      locks: options.locks ?? new FakeLocks(),
      handoffTimeoutMs: 200,
      handoffPollMs: 1,
    })
    const events: RuntimeHandleEvent[] = []
    void (async () => {
      for await (const event of handle.events) events.push(event)
    })()
    return { handle, routes, opened, processes, events }
  }

  const loads = (agent: FakeAcpAgent) => agent.received.filter(r => r.method === 'session/load' || r.method === 'session/resume')

  it('hands a thread the App holds without answering to the App, then follows it', async () => {
    const agent = codexAgent((_id, call) => (call === 1 ? blockedHeld : follow))
    const { handle, opened } = companion(agent)
    const session = await handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_1', replay: 'none' })
    expect(opened).toEqual([`codex://threads/${T1}`])
    expect(loads(agent).at(-1)?.params._meta).toEqual({ codexIpc: { mode: 'auto' } })
    await session.close()
  })

  it('never opens the deeplink when the App is not running or the thread is free', async () => {
    const blocked = codexAgent(() => blockedHeld)
    const a = companion(blocked, { app: false })
    await a.handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_1', replay: 'none' })
    expect(a.opened).toEqual([])
    const free = codexAgent(() => resumable)
    const b = companion(free)
    await b.handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_2', replay: 'none' })
    expect(b.opened).toEqual([])
  })

  it('loads without codexIpc on Windows when only the unknown writer lock blocks the thread', async () => {
    const agent = codexAgent(() => windowsUnknown)
    const { handle, routes, opened } = companion(agent, { platform: 'win32' })
    await handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_1', replay: 'none' })
    expect(loads(agent).at(-1)?.params._meta).toBeUndefined()
    expect(opened).toEqual([]) // an unknown write lock is not handed to the App
    expect(routes.size).toBe(0)
    // on other platforms the same result still goes auto, and codex-acp reports blocked.
    const mac = codexAgent(() => windowsUnknown)
    const other = companion(mac, { platform: 'darwin' })
    await other.handle.open({ kind: 'existing', ref: { nativeSessionId: T2 } }, { sessionId: 'aa_2', replay: 'none' })
    expect(loads(mac).at(-1)?.params._meta).toEqual({ codexIpc: { mode: 'auto' } })
  })

  it('explains a blocked open so the engine can offer quitting the App', async () => {
    const agent = codexAgent(() => blockedHeld)
    agent.peer.onRequest('session/resume', () => { throw new JsonRpcError(-32603, 'codex_owner_unavailable') })
    const { handle } = companion(agent)
    const error = await handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_1', replay: 'none' }).catch(e => e)
    expect(error).toBeInstanceOf(RuntimeFailure)
    expect((error as RuntimeFailure).error.details).toMatchObject({ route: 'blocked', writerLock: 'held', handoff: 'still_blocked', ownerRelease: 'available' })
    const plan = await handle.prepareQuitCodexApp([T1])
    expect(plan.status).toBe('plan')
  })

  it('offers the App quit through the port, tied to the AA session that asked for it', async () => {
    const agent = codexAgent(() => blockedHeld)
    const { handle, processes } = companion(agent)
    expect(handle.capabilities().items.find(c => c.id === 'runtime.owner_release')?.supported).toBe(true)
    const prepared = await handle.ownerRelease.prepare({ nativeSessionId: T1 }, { sessionId: 'aa_7' })
    expect(prepared).toMatchObject({ status: 'plan', plan: { sessionId: 'aa_7', nativeSessionId: T1, owner: { displayName: 'Codex App', processCount: 1 }, releasesOtherSessions: true } })
    if (prepared.status !== 'plan') throw new Error('expected a plan')
    // drafting a plan sends no signal; after discarding, the plan cannot run
    expect(processes.signals).toEqual([])
    handle.ownerRelease.discard(prepared.plan.planId)
    expect((await handle.ownerRelease.execute(prepared.plan.planId, { force: false })).status).toBe('plan_expired')
    expect(processes.signals).toEqual([])
    const free = companion(codexAgent(() => follow))
    expect(await free.handle.ownerRelease.prepare({ nativeSessionId: T1 }, { sessionId: 'aa_8' })).toEqual({ status: 'not_needed' })
    const gone = companion(codexAgent(() => blockedHeld), { app: false })
    expect(await gone.handle.ownerRelease.prepare({ nativeSessionId: T1 }, { sessionId: 'aa_9' })).toEqual({ status: 'unavailable', reason: 'owner_not_running' })
  })

  it('declares the App actions only while the App is installed, and names them as commands', async () => {
    const installed = companion(codexAgent(() => follow))
    const item = (handle: CodexRuntimeHandle, id: string) => handle.capabilities().items.find(c => c.id === id)
    expect(item(installed.handle, 'runtime.app_open')).toEqual({ id: 'runtime.app_open', supported: true, parameters: { appName: 'Codex App' } })
    expect(item(installed.handle, 'runtime.owner_release')).toEqual({ id: 'runtime.owner_release', supported: true, parameters: { appName: 'Codex App' } })
    expect(installed.handle.nativeApp.commands.open.id).toBe('open-in-codex-app')
    expect(installed.handle.nativeApp.commands.release?.aliases).toContain('kill-chatgpt')
    const blocked = codexAgent(() => blockedHeld)
    blocked.peer.onRequest('session/resume', () => { throw new JsonRpcError(-32603, 'codex_owner_unavailable') })
    const missing = companion(blocked, { installed: false })
    expect(item(missing.handle, 'runtime.app_open')?.supported).toBe(false)
    expect(item(missing.handle, 'runtime.owner_release')?.supported).toBe(false)
    const error = await missing.handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_1', replay: 'none' }).catch(e => e)
    expect((error as RuntimeFailure).error.details).toMatchObject({ ownerRelease: 'unavailable' })
  })

  it('opens a thread in the running App on request, never starting the App', async () => {
    const running = companion(codexAgent(() => follow))
    expect(await running.handle.nativeApp.open({ nativeSessionId: T1 })).toEqual({ status: 'opened' })
    expect(running.opened).toEqual([`codex://threads/${T1}`])
    const stopped = companion(codexAgent(() => follow), { app: false })
    expect(await stopped.handle.nativeApp.open({ nativeSessionId: T1 })).toEqual({ status: 'app_not_running' })
    expect(stopped.opened).toEqual([])
    const refused = companion(codexAgent(() => follow), { opens: false })
    expect(await refused.handle.nativeApp.open({ nativeSessionId: T1 })).toEqual({ status: 'open_failed' })
    expect(await running.handle.nativeApp.open({ nativeSessionId: 'not-a-thread' })).toEqual({ status: 'unsupported' })
  })

  it('fills the permission of threads that are not open from their rollout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-codex-list-'))
    const created = threadCreatedAt(T1)!
    const day = join(home, 'sessions', String(created.getFullYear()), String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0'))
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2026-11-16T23-44-56-${T1}.jsonl`), JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } }))
    const agent = codexAgent(() => resumable)
    agent.peer.onRequest('session/list', () => ({ sessions: [{ sessionId: T1, cwd: '/w', updatedAt: '2026-11-16T15:00:00Z' }, { sessionId: T2, cwd: '/w' }, { sessionId: 'not-a-thread', cwd: '/w' }] }))
    const { handle } = companion(agent, { codexHome: home })
    const page = await handle.listNativeSessions()
    expect(page.sessions.map(s => [s.nativeSessionId, s.permission])).toEqual([
      [T1, codexPermissionSelectionId('full_access', { permission_mode: 'full_access' })],
      [T2, undefined], // rollout not found: left empty, no default filled in
      ['not-a-thread', undefined],
    ])
    // an opened thread follows the session configuration and no longer reads the rollout
    await handle.open({ kind: 'existing', ref: { nativeSessionId: T1 } }, { sessionId: 'aa_1', replay: 'none' })
    expect((await handle.listNativeSessions()).sessions.find(s => s.nativeSessionId === T1)?.permission).toBeUndefined()
  })

  it('emits follow suggestions as runtime events, skipping threads AA has open', async () => {
    const locks = new FakeLocks()
    locks.entries = [{ threadId: T1, mtimeMs: 1 }, { threadId: T2, mtimeMs: 1 }]
    const agent = codexAgent(() => follow)
    const { handle, events } = companion(agent, { locks })
    await handle.open({ kind: 'existing', ref: { nativeSessionId: T2 } }, { sessionId: 'aa_2', replay: 'none' })
    await handle.scanForFollowableThreads()
    await tick()
    expect(events.filter(e => e.type === 'native_session.follow_suggested')).toEqual([
      { type: 'native_session.follow_suggested', ref: { nativeSessionId: T1 }, reason: 'external_owner' },
    ])
    await handle.stop()
  })
})

describe('Codex profile wiring for companions', () => {
  it('adds boolean companion switches to the instance schema with safe defaults', () => {
    expect(() => checkDefinition(CODEX)).not.toThrow()
    const schema = CODEX.configSchema!
    expect(schema.defaults).toEqual({ autoFollow: true, deeplinkHandoff: true, announceNewThreads: true })
    expect(validateSettings(schema.schema, { autoFollow: false, codexHome: '~/.codex' })).toBeUndefined()
    expect(validateSettings(schema.schema, { autoFollow: 'yes' })).toBeDefined()
    expect(resolveCodexHome('~/x', {}, '/home/u')).toBe('/home/u/x')
    expect(resolveCodexHome(undefined, { CODEX_HOME: '/data/codex' }, '/home/u')).toBe('/data/codex')
    expect(resolveCodexHome(undefined, {}, '/home/u')).toBe('/home/u/.codex')
  })

  it('asks codex-acp to announce new threads unless the instance switches it off', () => {
    expect(codexDialect().initializeMeta?.()).toEqual({ codexIpc: { approvals: true, settings: true, historyReplacement: true } })
    expect(codexDialect({ announceNewThreads: true }).initializeMeta?.()).toMatchObject({ codexIpc: { announceNewThreads: true } })
    const meta = (settings: Json) => CODEX.dialect({ settings } as never).initializeMeta?.()
    expect(meta({})).toMatchObject({ codexIpc: { announceNewThreads: true } })
    expect(meta({ announceNewThreads: false })).toEqual({ codexIpc: { approvals: true, settings: true, historyReplacement: true } })
  })

  it('hides image attachments until codex-acp passes local image links to Codex', () => {
    const info = (meta: Json) => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, agentInfo: {}, authMethods: [], meta }) as unknown as AgentInfo
    const attachment = (meta: Json) => codexDialect().capabilities(info(meta)).find(c => c.id === 'runtime.attachment')
    expect(attachment({ codexIpc: {} })).toEqual({ id: 'runtime.attachment', supported: false })
    expect(codexLocalImageLinks(info({ localImageLinks: { supported: true } }))).toBe(true)
    expect(attachment({ localImageLinks: { supported: true } })).toMatchObject({ supported: true, parameters: { image: true } })
  })

  it('explains in the sidebar switch that new threads skip project groups', () => {
    const property = (CODEX.configSchema!.schema.properties as Record<string, Record<string, unknown>>).announceNewThreads
    expect(property?.description).toContain('项目分组')
  })

  it('passes local images by path, never as inline bytes', () => {
    const dialect = codexDialect()
    const blocks = (dialect.promptBlocks ?? promptBlocks)({ text: 'look', attachments: [{ kind: 'file', path: '/tmp/shot.png', mimeType: 'image/png', name: 'shot.png' }] })
    expect(blocks).toEqual([
      { type: 'text', text: 'look' },
      { type: 'resource_link', uri: 'file:///tmp/shot.png', name: 'shot.png', mimeType: 'image/png' },
    ])
    expect(JSON.stringify(blocks)).not.toContain('data:')
  })
})
