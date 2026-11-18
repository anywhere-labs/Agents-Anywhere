// DSH-5: one DSH runtime across its routes (04-connector.md §5.6) on B's ACP engine. The direct
// route is DSH's automation ACP; plugin hosts are DSH processes with the AA plugin. They share a
// fake "disk" with DSH's per-session write lock, so the lock handoff is observable.
import { describe, expect, test } from 'vitest'
import type { RuntimeEvent } from '../../../src/application/ports/runtime-session.js'
import { RuntimeFailure } from '../../../src/runtime/acp/errors.js'
import { dshDirectDialect } from '../../../src/runtime/profiles/dsh/direct/dialect.js'
import { DshRuntime, hostProblem, type DshSession } from '../../../src/runtime/profiles/dsh/runtime.js'
import { configChangesFor, DSH_SELECTIONS, modelSelectionIdOf } from '../../../src/runtime/profiles/dsh/selections.js'
import { resolveDshLaunch, dshEnvironment, supportedDshVersion, DSH_PINNED_VERSION, DshNotInstalledError, type LaunchProbe } from '../../../src/runtime/profiles/dsh/launcher.js'
import { dshModelSelectionId, dshPermissionSelectionId } from '../../../src/domain/identity/selection.js'
import { DshDisk, fakeDirect, fakeHost } from '../../fixtures/fake-dsh-acp.js'

function collect(session: DshSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => { for await (const event of session.events) events.push(event) })()
  return events
}

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`timed out: ${label}`)
}

function setup(options: { image?: boolean } = {}) {
  const direct = fakeDirect(dshDirectDialect(), new DshDisk(), options)
  const runtime = new DshRuntime({ instanceId: 'rti_dsh', direct: direct.connect, dshHome: '/home/u/.dsh' })
  return { direct, disk: direct.disk, runtime }
}

const delivery = (id: string) => ({ deliveryId: `d-${id}`, clientMessageId: id })
const existing = (nativeSessionId: string) => ({ kind: 'existing' as const, ref: { nativeSessionId, locator: '/w' } })
const caps = (session: { capabilities: { items: readonly { id: string, supported: boolean }[] } }) =>
  new Map(session.capabilities.items.map(item => [item.id, item.supported]))
const completed = (events: RuntimeEvent[]) => events.filter(event => event.type === 'message.completed' && event.role === 'assistant')
  .map(event => event.type === 'message.completed' && event.text)

describe('DSH direct route on the ACP engine', () => {
  test('capabilities: approvals only; no steer, forms, plan or commands; images when DSH advertises them', async () => {
    const { runtime } = setup()
    const session = await runtime.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'sess_1', replay: 'none' })
    expect(session.nativeSessionId).toBe('uuid-1')
    expect(session.routeKind).toBe('direct')
    const map = caps(session)
    for (const id of ['session.send_message', 'session.interrupt', 'session.interaction.approval', 'catalog.model']) expect(map.get(id), id).toBe(true)
    for (const id of ['session.steer', 'session.interaction.form', 'session.plan_review', 'session.commands', 'catalog.permission', 'runtime.attachment']) {
      expect(map.get(id), id).toBe(false)
    }
    expect(runtime.capabilities().items.find(item => item.id === 'runtime.route')?.parameters).toMatchObject({ route: 'direct' })
    const withImages = setup({ image: true })
    expect(caps(await withImages.runtime.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'sess_2', replay: 'none' })).get('runtime.attachment')).toBe(true)
  })

  test('a prompt: the engine writes the user message and the turn; one at a time; empty or file prompts are refused before sending', async () => {
    const { runtime, direct } = setup()
    const session = await runtime.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'sess_1', replay: 'none' })
    const events = collect(session)
    let release!: () => void
    direct.fake.gate = new Promise(resolve => { release = resolve })
    // DSH confirms a prompt only by working on it or answering: acceptance waits for the gate.
    const first = session.prompt({ text: 'hello' }, delivery('c1'))
    await until(() => events.some(event => event.type === 'turn.started'), 'turn started')
    expect(events.find(event => event.type === 'message.completed' && event.role === 'user')).toMatchObject({ text: 'hello', clientMessageId: 'c1' })
    const busy = await session.prompt({ text: 'second' }, delivery('c2'))
    expect(busy).toMatchObject({ outcome: 'rejected', error: { code: 'session_busy' } })
    release()
    expect((await first).outcome).toBe('accepted')
    await until(() => events.some(event => event.type === 'turn.ended'), 'turn ended')
    expect(completed(events)).toEqual(['direct replies to hello'])
    expect(await session.prompt({ text: '  ' }, delivery('c3'))).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_argument' } })
    expect(await session.prompt({ text: 'read', attachments: [{ kind: 'file', path: '/w/a.txt', mimeType: 'text/plain' }] }, delivery('c4')))
      .toMatchObject({ outcome: 'rejected', error: { code: 'runtime_unsupported' } })
    expect(direct.fake.prompts.map(prompt => prompt.text)).toEqual(['hello'])
  })

  test('approvals are answered once through respond; cancel ends the turn as cancelled', async () => {
    const { runtime, direct } = setup()
    const session = await runtime.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'sess_1', replay: 'none' })
    const events = collect(session)
    await session.prompt({ text: 'needs approval' }, delivery('c1'))
    await until(() => events.some(event => event.type === 'interaction.opened'), 'approval')
    const opened = events.find(event => event.type === 'interaction.opened')!
    await session.respond(opened.type === 'interaction.opened' ? opened.interactionId : '', { kind: 'option', optionId: 'allow-once' })
    await until(() => events.some(event => event.type === 'turn.ended'), 'turn ended')
    expect(completed(events)).toEqual(['allow-once'])
    let never!: () => void
    direct.fake.gate = new Promise(resolve => { never = resolve })
    void session.prompt({ text: 'long' }, delivery('c2'))
    await until(() => events.filter(event => event.type === 'turn.started').length === 2, 'second turn started')
    await session.cancel()
    await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'cancelled turn')
    expect(events.filter(event => event.type === 'turn.ended').at(-1)).toMatchObject({ reason: 'cancelled' })
    never()
  })

  test('DSH Desktop has the session open and no plugin: writer_held with the install hint; close releases the lock', async () => {
    const { runtime, disk, direct } = setup()
    disk.holdExternally('held-1')
    const refused = await runtime.open(existing('held-1'), { sessionId: 'sess_h', replay: 'none' }).catch(error => error)
    expect(refused).toBeInstanceOf(RuntimeFailure)
    expect((refused as RuntimeFailure).error).toMatchObject({ code: 'writer_held', retryable: true, details: { hint: 'install_dsh_plugin' } })
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'full' })
    expect(disk.locks.get('cold-1')).toBe(direct.fake)
    await session.close()
    expect(direct.fake.closed).toEqual(['cold-1'])
    expect(disk.locks.has('cold-1')).toBe(false)
  })

  test('AA selection IDs map onto DSH config options and back', async () => {
    const { runtime } = setup()
    const session = await runtime.open({ kind: 'new', spec: { cwd: '/w' } }, { sessionId: 'sess_1', replay: 'none' })
    const selection = dshModelSelectionId('deepseek-official', 'deepseek-v4-flash', 'low')
    expect(configChangesFor(selection)).toEqual([{ configId: 'model', value: '["deepseek-official","deepseek-v4-flash"]' },
      { configId: 'reasoning_effort', value: 'low' }])
    expect(configChangesFor(dshPermissionSelectionId('workspace-write'))).toEqual([{ configId: 'permission', value: 'workspace-write' }])
    expect(configChangesFor('dsh:model:not-base64!')).toBeUndefined()
    expect(modelSelectionIdOf('["deepseek-official","deepseek-v4-flash"]', 'low')).toBe(selection)
    expect(DSH_SELECTIONS.modelSelectionId('["deepseek-official","deepseek-v4-flash"]', 'low')).toBe(selection)
    const result = await session.configure({ optionId: 'reasoning_effort', value: 'low' })
    expect(result.options.find(option => option.id === 'reasoning_effort')?.currentValue).toBe('low')
    const catalogs = await runtime.catalogs()
    expect(catalogs.models?.models?.[0]?.selectionId).toBe(dshModelSelectionId('deepseek-official', 'deepseek-v4-flash', null))
  })
})

describe('DSH route switching and write-lock handoff (04 §5.6)', () => {
  test('a host appears: idle direct sessions move to it at once, the lock passes, new sessions go there', async () => {
    const { runtime, disk, direct } = setup()
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    const events = collect(session)
    const host = fakeHost(disk)
    expect(runtime.attachHost(host.route)).toBeUndefined()
    await until(() => session.routeKind === 'plugin', 'moved to the host')
    expect(direct.fake.closed).toEqual(['cold-1'])
    expect(disk.locks.get('cold-1')).toBe(host.fake)
    expect(events.some(event => event.type === 'capabilities.changed')).toBe(true)
    expect(caps(session).get('session.steer')).toBe(true)
    await session.prompt({ text: 'after' }, delivery('c1'))
    await until(() => events.some(event => event.type === 'turn.ended'), 'turn on the host')
    expect(completed(events)).toEqual(['host-1 replies to after'])
    expect(runtime.capabilities().items.find(item => item.id === 'runtime.route')?.parameters).toMatchObject({ route: 'plugin', hostInstance: 'host-1' })
    const created = await runtime.open({ kind: 'new', spec: { cwd: '/w', preferredNativeSessionId: 'aa_1_x' } }, { sessionId: 'sess_n', replay: 'none' })
    expect([created.routeKind, created.nativeSessionId]).toEqual(['plugin', 'aa_1_x'])
  })

  test('a host appears mid-turn: the turn finishes on the direct route, then the session moves; a prompt sent meanwhile waits and runs on the host', async () => {
    const { runtime, disk, direct } = setup()
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    const events = collect(session)
    let release!: () => void
    direct.fake.gate = new Promise(resolve => { release = resolve })
    const first = session.prompt({ text: 'first' }, delivery('c1'))
    await until(() => events.some(event => event.type === 'turn.started'), 'first turn started')
    const host = fakeHost(disk)
    runtime.attachHost(host.route)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(session.routeKind).toBe('direct')
    expect(disk.locks.get('cold-1')).toBe(direct.fake)
    release()
    expect((await first).outcome).toBe('accepted')
    await until(() => events.some(event => event.type === 'turn.ended'), 'first turn ended')
    const second = await session.prompt({ text: 'second' }, delivery('c2'))
    expect(second.outcome).toBe('accepted')
    await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'second turn ended')
    expect(completed(events)).toEqual(['direct replies to first', 'host-1 replies to second'])
    expect(host.fake.prompts.map(prompt => prompt.text)).toEqual(['second'])
  })

  test('a host appears while a direct turn waits for approval: respond and cancel still reach the direct session, then it moves', async () => {
    const within = <T>(promise: Promise<T>, label: string) => Promise.race([promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`deadlocked: ${label}`)), 1000))])
    const { runtime, disk } = setup()
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    const events = collect(session)
    await session.prompt({ text: 'needs approval' }, delivery('c1'))
    await until(() => events.some(event => event.type === 'interaction.opened'), 'approval')
    runtime.attachHost(fakeHost(disk).route)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(session.routeKind).toBe('direct')
    const opened = events.find(event => event.type === 'interaction.opened')!
    await within(session.respond(opened.type === 'interaction.opened' ? opened.interactionId : '', { kind: 'option', optionId: 'allow-once' }), 'respond')
    await until(() => events.some(event => event.type === 'turn.ended'), 'turn ended')
    expect(completed(events)).toEqual(['allow-once'])
    await until(() => session.routeKind === 'plugin', 'moved to the host')

    const second = setup()
    const running = await second.runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    const runningEvents = collect(running)
    let never!: () => void
    second.direct.fake.gate = new Promise(resolve => { never = resolve })
    void running.prompt({ text: 'long' }, delivery('c2'))
    await until(() => runningEvents.some(event => event.type === 'turn.started'), 'turn started')
    second.runtime.attachHost(fakeHost(second.disk).route)
    await new Promise(resolve => setTimeout(resolve, 30))
    await within(running.cancel(), 'cancel')
    await until(() => runningEvents.some(event => event.type === 'turn.ended'), 'cancelled turn')
    expect(runningEvents.find(event => event.type === 'turn.ended')).toMatchObject({ reason: 'cancelled' })
    await until(() => running.routeKind === 'plugin', 'moved after the cancel')
    never()
  })

  test('the host quits mid-turn: the turn ends with an unknown result (not resent) and the session falls back to the direct route', async () => {
    const { runtime, disk } = setup()
    const host = fakeHost(disk)
    runtime.attachHost(host.route)
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    const events = collect(session)
    host.fake.hangPrompts = true
    await session.prompt({ text: 'doomed' }, delivery('c1'))
    await until(() => events.some(event => event.type === 'message.completed' && event.role === 'assistant'), 'turn started on the host')
    host.disconnect()
    await until(() => events.some(event => event.type === 'turn.ended'), 'turn ended')
    const ended = events.find(event => event.type === 'turn.ended')!
    expect(ended).toMatchObject({ reason: 'failed', error: { retryable: false, details: { outcome: 'unknown' } } })
    await until(() => session.routeKind === 'direct', 'fell back to direct')
    expect(events.some(event => event.type === 'session.lost')).toBe(false)
    await session.prompt({ text: 'again' }, delivery('c2'))
    await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'direct turn')
    expect(completed(events).at(-1)).toBe('direct replies to again')
    expect(host.fake.prompts.map(prompt => prompt.text)).toEqual(['doomed'])
  })

  test('the direct DSH crashes: the session reopens on a fresh process; with nowhere to go it is lost', async () => {
    const { runtime, direct } = setup()
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    const events = collect(session)
    direct.kill()
    await until(() => direct.state.starts === 2 && direct.fake.resumed.includes('cold-1'), 'reopened on a new process')
    expect(events.some(event => event.type === 'session.lost')).toBe(false)

    const hostOnly = new DshRuntime({ instanceId: 'rti_dsh' })
    const host = fakeHost(new DshDisk())
    hostOnly.attachHost(host.route)
    const lonely = await hostOnly.open(existing('cold-1'), { sessionId: 'sess_l', replay: 'none' })
    const lonelyEvents = collect(lonely)
    host.disconnect()
    await until(() => lonelyEvents.some(event => event.type === 'session.lost'), 'lost')
    await expect(hostOnly.open(existing('cold-1'), { sessionId: 'sess_l', replay: 'none' })).rejects.toMatchObject({ error: { code: 'runtime_unavailable' } })
  })

  test('hosts the Connector cannot use are refused and reported; the direct route keeps serving', async () => {
    const { runtime, disk } = setup()
    const reports: string[] = []
    void (async () => {
      for await (const event of runtime.events) {
        if (event.type === 'status' && event.error) reports.push(event.error.code)
      }
    })()
    expect(runtime.attachHost(fakeHost(disk, { dshVersion: '0.3.0' }).route)).toMatchObject({ code: 'agent_version_unsupported' })
    expect(runtime.attachHost(fakeHost(disk, { dshHome: '/other/.dsh' }).route)).toMatchObject({ code: 'dsh_home_mismatch' })
    expect(hostProblem({ hostInstance: 'h', hostKind: 'web', dshVersion: '0.2.2', pluginVersion: '3.1.0', dshHome: '/home/u/.dsh' }, '/home/u/.dsh')).toBeUndefined()
    expect(runtime.activeRoute).toBe('direct')
    expect((await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })).routeKind).toBe('direct')
    await until(() => reports.length === 2, 'refusals reported')
    expect(reports).toEqual(['agent_version_unsupported', 'dsh_home_mismatch'])
  })

  test('several hosts: the newest serves; one that holds the lock elsewhere passes the session to the other; a reload replaces its host', async () => {
    const { runtime, disk } = setup()
    const desktop = fakeHost(disk, { hostInstance: 'desktop', hostKind: 'desktop' })
    const web = fakeHost(disk, { hostInstance: 'web', hostKind: 'web' })
    runtime.attachHost(desktop.route)
    runtime.attachHost(web.route)
    // DSH Desktop's own window has `cold-1` open: the web host refuses it, Desktop's plugin serves it.
    disk.locks.set('cold-1', desktop.fake)
    const session = await runtime.open(existing('cold-1'), { sessionId: 'sess_c', replay: 'none' })
    expect(session.hostInstance).toBe('desktop')
    disk.persisted.push({ sessionId: 'free-1', cwd: '/w' })
    expect((await runtime.open(existing('free-1'), { sessionId: 'sess_f', replay: 'none' })).hostInstance).toBe('web')
    disk.holdExternally('held-1')
    await expect(runtime.open(existing('held-1'), { sessionId: 'sess_h', replay: 'none' })).rejects.toMatchObject({ error: { code: 'writer_held' } })
    const reloaded = fakeHost(disk, { hostInstance: 'web', hostKind: 'web' })
    runtime.attachHost(reloaded.route)
    expect(runtime.connectedHosts.map(hello => hello.hostInstance)).toEqual(['desktop', 'web'])
  })
})

describe('DSH failed turns (contracts/dsh-bridge/3.0 §7)', () => {
  test('a failed turn leaves a card; "continue" runs DSH\'s continuation once; a stale card is closed; the direct route keeps it', async () => {
    const { runtime, disk } = setup()
    const host = fakeHost(disk)
    runtime.attachHost(host.route)
    const session = await runtime.open({ kind: 'new', spec: { cwd: '/w', preferredNativeSessionId: 'aa_1_fail' } }, { sessionId: 'sess_f', replay: 'none' })
    const events = collect(session)
    expect((await session.prompt({ text: 'this fails' }, delivery('f1'))).outcome).toBe('accepted')
    await until(() => events.some(event => event.type === 'interaction.opened'), 'failure card opened')
    const card = events.find(event => event.type === 'interaction.opened') as Extract<RuntimeEvent, { type: 'interaction.opened' }>
    expect(card).toMatchObject({ kind: 'execution_error', title: 'DSH 本轮执行失败', body: 'upstream unavailable',
      options: [{ id: 'continue', label: '继续' }], metadata: { source: 'dsh.turn.failed', turnEndSeq: host.fake.continuable.get('aa_1_fail') } })
    await until(() => events.some(event => event.type === 'turn.ended'), 'failed turn ended')

    expect(await session.respond(card.interactionId, { kind: 'option', optionId: 'continue' })).toBeUndefined()
    expect(host.fake.continued).toEqual([{ sessionId: 'aa_1_fail', turnEndSeq: card.metadata!.turnEndSeq }])
    expect(events).toContainEqual(expect.objectContaining({ type: 'interaction.resolved', interactionId: card.interactionId, resolution: 'answered' }))
    // The continuation is DSH's own turn: its reply streams in with no new user message.
    await until(() => completed(events).includes('continued'), 'continuation replied')
    expect(events.filter(event => event.type === 'message.completed' && event.role === 'user')).toHaveLength(1)
    // DSH no longer continues that turn: the card closes with the reason.
    expect(await session.respond(card.interactionId, { kind: 'option', optionId: 'continue' }))
      .toEqual({ refused: { code: 'dsh_continue_unavailable', message: '这一轮已无法继续生成，请重新发送消息。' }, closes: true })
    expect(await session.respond(card.interactionId, { kind: 'cancelled' })).toMatchObject({ refused: { code: 'invalid_argument' }, closes: false })

    // The host goes away: the direct route cannot continue, and keeps the card for when a host returns.
    host.disconnect()
    await until(() => session.routeKind === 'direct', 'back on the direct route')
    expect(await session.respond(card.interactionId, { kind: 'option', optionId: 'continue' })).toMatchObject({ refused: { code: 'dsh_continue_unavailable' }, closes: false })
    await runtime.stop()
  })
})

describe('DSH launch resolution', () => {
  const probe = (files: Record<string, string | undefined>, path: Record<string, string>): LaunchProbe => ({
    which: async name => path[name],
    version: async command => files[command],
    exists: async file => file in files,
  })

  test('prefers a configured command, then Desktop, then an installed dsh in range, then pinned npx', async () => {
    expect(await resolveDshLaunch({ configured: { command: '/x/dsh' } }, probe({}, {}))).toEqual({ command: '/x/dsh', args: ['--profile', 'acp'], source: 'configured' })
    expect(await resolveDshLaunch({ desktopExecutables: ['/app/dsh'] }, probe({ '/app/dsh': '0.2.2-rc.3', '/bin/dsh': '0.2.1' }, { dsh: '/bin/dsh' })))
      .toMatchObject({ command: '/app/dsh', source: 'desktop', version: '0.2.2-rc.3' })
    expect(await resolveDshLaunch({}, probe({ '/bin/dsh': '0.2.1-rc.2' }, { dsh: '/bin/dsh' }))).toMatchObject({ command: '/bin/dsh', source: 'installed' })
    expect(await resolveDshLaunch({}, probe({ '/bin/dsh': '0.3.0' }, { dsh: '/bin/dsh', npx: '/bin/npx' })))
      .toEqual({ command: '/bin/npx', args: ['-y', `@deepseek-ai/dsh@${DSH_PINNED_VERSION}`, '--profile', 'acp'], source: 'npx', version: DSH_PINNED_VERSION })
    await expect(resolveDshLaunch({ allowNpx: false }, probe({}, { npx: '/bin/npx' }))).rejects.toBeInstanceOf(DshNotInstalledError)
  })

  test('version range and environment', () => {
    expect(supportedDshVersion('0.2.2-rc.3')).toBe(true)
    expect(supportedDshVersion('0.2.0')).toBe(true)
    expect(supportedDshVersion('0.3.0-rc.1')).toBe(false)
    const env = dshEnvironment({ PATH: '/bin', AGENT_SERVER_TOKEN: 'secret', DEEPSEEK_API_KEY: 'user' },
      { dshHome: '/h', model: { apiKey: 'aa-key', baseUrl: 'https://gw/anthropic' } })
    expect(env).toEqual({ PATH: '/bin', DSH_HOME: '/h', DEEPSEEK_API_KEY: 'aa-key', DEEPSEEK_BASE_URL: 'https://gw/anthropic' })
    expect(dshEnvironment({ DEEPSEEK_API_KEY: 'user' }, {})).toEqual({ DEEPSEEK_API_KEY: 'user' })
  })
})
