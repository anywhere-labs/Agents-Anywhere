import { describe, expect, test } from 'vitest'
import { DshSessionBusyError } from '../../../src/runtime/profiles/dsh/direct/route.js'
import { startFake } from '../../fixtures/fake-dsh-acp.js'
import { DIRECT_QUEUE_LIMIT, QueueFullError, type DshDirectSession } from '../../../src/runtime/profiles/dsh/direct/session.js'
import { resolveDshLaunch, dshEnvironment, supportedDshVersion, DSH_PINNED_VERSION, DshNotInstalledError, type LaunchProbe } from '../../../src/runtime/profiles/dsh/launcher.js'
import { configChangesFor, modelSelectionIdOf } from '../../../src/runtime/profiles/dsh/selections.js'
import { dshModelSelectionId, dshPermissionSelectionId } from '../../../src/domain/identity/selection.js'
import type { RuntimeEvent } from '../../../src/runtime/profiles/dsh/port.js'

function collect(session: DshDirectSession) {
  const events: RuntimeEvent[] = []
  void (async () => { for await (const event of session.events) events.push(event) })()
  return events
}

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`timed out: ${label}`)
}

const delivery = (id: string) => ({ clientMessageId: id, nativeRequestId: `native-${id}` })

describe('DSH direct route', () => {
  test('capabilities follow DSH automation ACP: local queue, no continue, plan, questions or steer', async () => {
    const { route } = await startFake()
    const session = await route.open({ cwd: '/w' })
    expect(session.externalSessionId).toBe('uuid-1')
    const caps = session.capabilities
    expect(caps['session.send_message']?.supported).toBe(true)
    expect(caps['session.queue']).toMatchObject({ supported: true, metadata: { owner: 'connector' } })
    for (const id of ['session.steer', 'session.continue', 'session.planning', 'session.interaction.question', 'catalog.permission', 'runtime.attachment']) {
      expect(caps[id]?.supported, id).toBe(false)
    }
    expect(caps['catalog.model']?.supported).toBe(true)
    expect(caps['catalog.effort']?.supported).toBe(true)
    expect((await route.catalogs()).entries.map(entry => entry.id)).toEqual(['model', 'reasoning_effort'])
  })

  test('synthesizes turns and the user message, and queues later inputs locally', async () => {
    const { fake, route } = await startFake()
    let release!: () => void
    fake.gate = new Promise(resolve => { release = resolve })
    const session = await route.open({ cwd: '/w' })
    const events = collect(session)
    expect(await session.prompt({ text: 'first' }, delivery('a'))).toEqual({ status: 'accepted' })
    expect(await session.prompt({ text: 'second' }, delivery('b'))).toEqual({ status: 'queued', position: 1 })
    expect(await session.prompt({ text: 'second' }, delivery('b'))).toEqual({ status: 'duplicate' })
    await until(() => fake.prompts.length === 1, 'first prompt sent')
    release()
    fake.gate = undefined
    await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'both turns ended')
    expect(fake.prompts.map(prompt => prompt.text)).toEqual(['first', 'second'])
    const kinds = events.map(event => event.type)
    expect(kinds.slice(0, 6)).toEqual(['turn.started', 'message.delta', 'tool.started', 'tool.updated', 'message.committed', 'turn.ended'])
    expect(events[1]).toMatchObject({ type: 'message.delta', role: 'user', text: 'first', nativeRequestId: 'native-a', transient: false })
    expect(events.find(event => event.type === 'message.committed')).toMatchObject({ role: 'assistant', messageId: 'm-1', text: 'reply to first' })
    expect(events.filter(event => event.type === 'turn.ended').map(event => event.type === 'turn.ended' && event.deliveries)).toEqual([['native-a'], ['native-b']])
  })

  test('rejects empty prompts before queueing and bounds the queue', async () => {
    const { fake, route } = await startFake()
    fake.gate = new Promise(() => {})
    const session = await route.open({ cwd: '/w' })
    await expect(session.prompt({ text: '   ' }, delivery('empty'))).rejects.toThrow(/text or an image/)
    await expect(session.prompt({ text: 'x', files: [{ path: '/f', name: 'f', size: 1 }] }, delivery('file'))).rejects.toThrow(/file attachments/)
    await session.prompt({ text: 'running' }, delivery('r'))
    for (let i = 0; i < DIRECT_QUEUE_LIMIT; i++) await session.prompt({ text: `q${i}` }, delivery(`q${i}`))
    await expect(session.prompt({ text: 'overflow' }, delivery('overflow'))).rejects.toBeInstanceOf(QueueFullError)
    expect(session.removeQueued('native-q0')).toBe(true)
    expect(session.queued).toBe(DIRECT_QUEUE_LIMIT - 1)
  })

  test('cancel ends the running turn as cancelled and the next queued input runs', async () => {
    const { fake, route } = await startFake()
    fake.gate = new Promise(() => {})
    const session = await route.open({ cwd: '/w' })
    const events = collect(session)
    await session.prompt({ text: 'long' }, delivery('long'))
    await session.prompt({ text: 'next' }, delivery('next'))
    await until(() => fake.prompts.length === 1, 'sent')
    fake.gate = undefined
    await session.cancel()
    await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'cancelled then next')
    const ended = events.filter(event => event.type === 'turn.ended')
    expect(ended[0]).toMatchObject({ stopReason: 'cancelled', reason: { kind: 'interrupted' } })
    expect(ended[1]).toMatchObject({ stopReason: 'end_turn', deliveries: ['native-next'] })
  })

  test('approvals are answered once through respond', async () => {
    const { route } = await startFake()
    const session = await route.open({ cwd: '/w' })
    const events = collect(session)
    await session.prompt({ text: 'needs approval' }, delivery('p'))
    await until(() => events.some(event => event.type === 'interaction.opened'), 'permission asked')
    const opened = events.find(event => event.type === 'interaction.opened')!
    expect(opened).toMatchObject({ interactionId: 'call-1', interactionType: 'approval', title: 'bash' })
    await session.respond('call-1', { kind: 'option', optionId: 'allow-once' })
    await expect(session.respond('call-1', { kind: 'option', optionId: 'allow-once' })).rejects.toThrow(/no longer pending/)
    await until(() => events.some(event => event.type === 'turn.ended'), 'turn ended')
    expect(events.find(event => event.type === 'message.committed')).toMatchObject({ text: 'allow-once' })
  })

  test('a session held by another DSH process is reported as busy; close releases the lock', async () => {
    const { fake, route } = await startFake()
    fake.held.add('held-1')
    await expect(route.open({ externalSessionId: 'held-1', cwd: '/w' })).rejects.toBeInstanceOf(DshSessionBusyError)
    const session = await route.open({ externalSessionId: 'cold-1', cwd: '/w' })
    expect(route.isOpen('cold-1')).toBe(true)
    expect((await route.listNativeSessions()).sessions).toEqual([{ externalSessionId: 'cold-1', cwd: '/w', title: null, updatedAt: null }])
    await session.close()
    expect(fake.closed).toEqual(['cold-1'])
    expect(route.isOpen('cold-1')).toBe(false)
  })

  test('AA selection IDs map onto DSH config options and back', async () => {
    const { route } = await startFake()
    const session = await route.open({ cwd: '/w' })
    const selection = dshModelSelectionId('deepseek-official', 'deepseek-v4-flash', 'low')
    expect(configChangesFor(selection)).toEqual([{ configId: 'model', value: '["deepseek-official","deepseek-v4-flash"]' },
      { configId: 'reasoning_effort', value: 'low' }])
    expect(configChangesFor(dshPermissionSelectionId('workspace-write'))).toEqual([{ configId: 'permission', value: 'workspace-write' }])
    expect(configChangesFor('dsh:model:not-base64!')).toBeUndefined()
    expect(modelSelectionIdOf('["deepseek-official","deepseek-v4-flash"]', 'low')).toBe(selection)
    let result
    for (const change of configChangesFor(selection)!) result = await session.configure(change)
    expect(result!.catalogs.entries.find(entry => entry.id === 'reasoning_effort')?.current).toBe('low')
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
