// The session's native desktop app as slash commands, against a fake app and a fake owner release: which commands
// are offered, the open outcomes, and the two-step quit (plan, then confirm/force/cancel from the same session).

import { describe, expect, it } from 'vitest'

import type { Capability, NativeAppOpenOutcome, OwnerReleaseOutcome, OwnerReleasePrepareResult, RuntimeHandle } from '../../src/application/ports/index.js'
import { NativeAppCommands, type NativeAppSession } from '../../src/application/runtimes/native-app.js'

const PLAN = 'plan_1'
const EXPIRES = Date.UTC(2026, 10, 18, 12, 0, 0)

class FakeApp {
  capabilities: Capability[] = [
    { id: 'runtime.app_open', supported: true, parameters: { appName: 'Desk App' } },
    { id: 'runtime.owner_release', supported: true, parameters: { appName: 'Desk App' } },
  ]
  openOutcome: NativeAppOpenOutcome = { status: 'opened' }
  prepareResult: OwnerReleasePrepareResult = {
    status: 'plan',
    plan: { planId: PLAN, sessionId: 's1', nativeSessionId: 'n1', expiresAt: EXPIRES, owner: { displayName: 'Desk App', processCount: 2 }, releasesOtherSessions: true, gracePeriodMs: 5000 },
  }
  executeOutcome: OwnerReleaseOutcome = { status: 'released' }
  readonly calls: string[] = []

  handle(): RuntimeHandle {
    return {
      type: 'desk',
      instanceId: 'desk',
      capabilities: () => ({ revision: 1, items: this.capabilities }),
      catalogs: async () => ({}),
      listNativeSessions: async () => ({ sessions: [] }),
      readNativeHistory: async () => ({ items: [] }),
      open: async () => { throw new Error('not used') },
      events: (async function* () {})(),
      stop: async () => undefined,
      nativeApp: {
        appName: 'Desk App',
        commands: {
          open: { id: 'open-in-desk', aliases: ['desk'], title: 'Open in Desk App', description: 'Open it there.' },
          release: { id: 'quit-desk', aliases: ['kill-desk'], title: 'Quit Desk App', description: 'Quit it.' },
        },
        open: async ref => {
          this.calls.push(`open ${ref.nativeSessionId}`)
          return this.openOutcome
        },
      },
      ownerRelease: {
        prepare: async (ref, context) => {
          this.calls.push(`prepare ${ref.nativeSessionId} ${context.sessionId}`)
          return this.prepareResult
        },
        execute: async (planId, consent) => {
          this.calls.push(`execute ${planId}${consent.force ? ' force' : ''}`)
          return this.executeOutcome
        },
        discard: planId => { this.calls.push(`discard ${planId}`) },
      },
    }
  }
}

function commands(app: FakeApp, sessions: Record<string, NativeAppSession> = { s1: { runtimeId: 'desk', externalSessionId: 'n1', cwd: '/w' }, s2: { runtimeId: 'desk', externalSessionId: 'n2', cwd: null } }) {
  return new NativeAppCommands({
    session: async id => sessions[id] ?? null,
    handle: async runtimeId => (runtimeId === 'desk' ? app.handle() : null),
  })
}

const takeover = { takeover: true }

describe('native app commands', () => {
  it('offers each action only while its capability is supported', async () => {
    const app = new FakeApp()
    expect((await commands(app).list('s1')).map(c => c.id)).toEqual(['open-in-desk', 'quit-desk'])
    app.capabilities = [{ id: 'runtime.app_open', supported: true }, { id: 'runtime.owner_release', supported: false }]
    expect((await commands(app).list('s1')).map(c => c.id)).toEqual(['open-in-desk'])
    app.capabilities = []
    expect(await commands(app).list('s1')).toEqual([])
    expect(await commands(app).execute('s1', 'open-in-desk', [], takeover)).toBeNull()
    expect(await commands(app).list('missing')).toEqual([])
  })

  it('opens the native session in the app by id or alias and reports why it could not', async () => {
    const app = new FakeApp()
    const api = commands(app)
    expect(await api.execute('s1', 'DESK', [], { takeover: false })).toEqual({ ok: true, code: null, message: '已在 Desk App 中打开这个会话。', result: { executionState: 'completed', status: 'opened', appName: 'Desk App' } })
    expect(app.calls).toEqual(['open n1'])
    app.openOutcome = { status: 'app_not_running' }
    expect(await api.execute('s1', 'open-in-desk', [], takeover)).toMatchObject({ ok: false, code: 'app_not_running' })
    app.openOutcome = { status: 'open_failed' }
    expect(await api.execute('s1', 'open-in-desk', [], takeover)).toMatchObject({ ok: false, code: 'app_open_failed' })
    expect(await api.execute('s1', 'open-in-desk', ['x'], takeover)).toMatchObject({ ok: false, code: 'invalid_command' })
    const unbound = commands(app, { s3: { runtimeId: 'desk', externalSessionId: null, cwd: null } })
    expect(await unbound.execute('s3', 'open-in-desk', [], takeover)).toMatchObject({ ok: false, code: 'session_not_bound' })
    expect(await api.execute('s1', 'review', [], takeover)).toBeNull()
  })

  it('asks for confirmation with the plan, then quits only on a confirmation from the same session', async () => {
    const app = new FakeApp()
    const api = commands(app)
    const first = await api.execute('s1', 'kill-desk', [], takeover)
    expect(first).toEqual({
      ok: false,
      code: 'confirmation_required',
      message: '退出 Desk App 会释放它正在使用的所有会话，需要你确认。',
      result: {
        executionState: 'completed',
        confirmation: {
          kind: 'owner_release', planId: PLAN, expiresAt: '2026-11-18T12:00:00.000Z', appName: 'Desk App', processCount: 2,
          releasesOtherSessions: true, gracePeriodMs: 5000,
          confirmArgs: ['--confirm', PLAN], forceArgs: ['--confirm', PLAN, '--force'], cancelArgs: ['--cancel', PLAN],
        },
      },
    })
    expect(app.calls).toEqual(['prepare n1 s1'])
    // Another session cannot use the plan; the plan stays usable for its own session.
    expect(await api.execute('s2', 'quit-desk', ['--confirm', PLAN], takeover)).toMatchObject({ ok: false, code: 'plan_expired' })
    expect(await api.execute('s1', 'quit-desk', ['--confirm', PLAN, '--force'], takeover)).toMatchObject({ ok: true, result: { status: 'released' } })
    expect(app.calls.at(-1)).toBe(`execute ${PLAN} force`)
    // A plan runs once.
    expect(await api.execute('s1', 'quit-desk', ['--confirm', PLAN], takeover)).toMatchObject({ ok: false, code: 'plan_expired' })
    expect(app.calls.filter(call => call.startsWith('execute'))).toHaveLength(1)
  })

  it('maps every outcome of the quit and refuses read-only sessions and bad arguments', async () => {
    const app = new FakeApp()
    const api = commands(app)
    expect(await api.execute('s1', 'quit-desk', [], { takeover: false })).toMatchObject({ ok: false, code: 'session_read_only' })
    expect(app.calls).toEqual([])
    for (const [status, ok] of [['already_released', true], ['plan_changed', false], ['survivors', false], ['still_held', false], ['plan_expired', false]] as const) {
      app.executeOutcome = { status }
      await api.execute('s1', 'quit-desk', [], takeover)
      expect(await api.execute('s1', 'quit-desk', ['--confirm', PLAN], takeover)).toMatchObject({ ok, result: { status } })
    }
    expect(await api.execute('s1', 'quit-desk', ['--confirm'], takeover)).toMatchObject({ code: 'invalid_command' })
    expect(await api.execute('s1', 'quit-desk', ['--confirm', PLAN, '--now'], takeover)).toMatchObject({ code: 'invalid_command' })
    app.prepareResult = { status: 'not_needed' }
    expect(await api.execute('s1', 'quit-desk', [], takeover)).toMatchObject({ ok: true, result: { status: 'not_needed' } })
    app.prepareResult = { status: 'unavailable', reason: 'owner_not_running' }
    expect(await api.execute('s1', 'quit-desk', [], takeover)).toMatchObject({ ok: false, code: 'app_not_running' })
    app.prepareResult = { status: 'unavailable', reason: 'process_table_unavailable' }
    expect(await api.execute('s1', 'quit-desk', [], takeover)).toMatchObject({ ok: false, code: 'command_error' })
  })

  it('drops a cancelled plan', async () => {
    const app = new FakeApp()
    const api = commands(app)
    await api.execute('s1', 'quit-desk', [], takeover)
    // Cancelling works without takeover (the session may have lost it meanwhile) and only for the plan's session.
    expect(await api.execute('s2', 'quit-desk', ['--cancel', PLAN], { takeover: false })).toMatchObject({ ok: true, result: { status: 'cancelled' } })
    expect(app.calls).not.toContain(`discard ${PLAN}`)
    expect(await api.execute('s1', 'quit-desk', ['--cancel', PLAN], { takeover: false })).toMatchObject({ ok: true, result: { status: 'cancelled' } })
    expect(app.calls).toContain(`discard ${PLAN}`)
    expect(await api.execute('s1', 'quit-desk', ['--confirm', PLAN], takeover)).toMatchObject({ ok: false, code: 'plan_expired' })
  })
})
