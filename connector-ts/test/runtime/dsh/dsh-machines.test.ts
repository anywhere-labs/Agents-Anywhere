// DSH-6: the DSH runtime on the three kinds of machine (04-connector.md §5.6) — DSH Desktop, a
// machine running `dsh web`, and one without DSH — from discovery to the route each session
// takes, with the plugin host coming and going. DSH itself is the ACP stand-in (fake-dsh-acp);
// the real automation ACP and the real plugin are covered by direct-acp.e2e and
// dsh-bridge-next/tests/integration/acp-ts-connector.
import { describe, expect, test } from 'vitest'
import type { RuntimeEvent } from '../../../src/application/ports/runtime-session.js'
import { dshDirectDialect } from '../../../src/runtime/profiles/dsh/direct/dialect.js'
import type { LaunchProbe } from '../../../src/runtime/profiles/dsh/launcher.js'
import { DSH_PINNED_VERSION } from '../../../src/runtime/profiles/dsh/launcher.js'
import { DshProvider } from '../../../src/runtime/profiles/dsh/provider.js'
import type { DshSession } from '../../../src/runtime/profiles/dsh/runtime.js'
import { DshDisk, fakeDirect, fakeHost } from '../../fixtures/fake-dsh-acp.js'

const DESKTOP_DSH = '/Applications/DSH.app/Contents/Resources/bin/dsh'

interface Machine {
  name: string
  /** Executables and versions on the machine, and what PATH finds. */
  files: Record<string, string>
  path: Record<string, string>
  desktopExecutables?: string[]
  /** The DSH that runs the plugin, if any. */
  host?: 'desktop' | 'web'
  /** What the direct route starts, if anything. */
  direct: 'desktop' | 'installed' | 'npx' | 'none'
}

const machines: Machine[] = [
  { name: 'DSH Desktop (bundled dsh, plugin installed)', files: { [DESKTOP_DSH]: '0.2.2-rc.3' }, path: {},
    desktopExecutables: [DESKTOP_DSH], host: 'desktop', direct: 'desktop' },
  { name: 'dsh web (dsh on PATH, plugin installed)', files: { '/usr/local/bin/dsh': '0.2.2-rc.3' }, path: { dsh: '/usr/local/bin/dsh' },
    host: 'web', direct: 'installed' },
  { name: 'no DSH, npx available', files: {}, path: { npx: '/usr/local/bin/npx' }, direct: 'npx' },
  { name: 'no DSH, no npx', files: {}, path: {}, direct: 'none' },
]

function probeOf(machine: Machine): LaunchProbe {
  return { which: async name => machine.path[name], version: async command => machine.files[command], exists: async file => file in machine.files }
}

async function until(check: () => boolean, label: string) {
  for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`timed out: ${label}`)
}

function collect(session: DshSession): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => { for await (const event of session.events) events.push(event) })()
  return events
}

const route = (runtime: { capabilities(): { items: readonly { id: string, parameters?: unknown }[] } }) =>
  runtime.capabilities().items.find(item => item.id === 'runtime.route')?.parameters as Record<string, unknown>
const replies = (events: RuntimeEvent[]) => events.filter(event => event.type === 'message.completed' && event.role === 'assistant')
  .map(event => event.type === 'message.completed' && event.text)

describe.each(machines)('DSH on $name', machine => {
  async function setup() {
    const disk = new DshDisk()
    const launches: string[] = []
    const provider = new DshProvider({ probe: probeOf(machine), env: { PATH: '/usr/bin' }, ...(machine.desktopExecutables ? { desktopExecutables: machine.desktopExecutables } : {}),
      connect: plan => { launches.push(plan.source); return fakeDirect(dshDirectDialect(), disk).connect } })
    const runtime = await provider.start({ runtimeId: 'rti_dsh', settings: {} })
    return { disk, provider, runtime, launches }
  }

  test('discovery reports the direct route this machine can start', async () => {
    const { provider } = await setup()
    const facts = await provider.discover()
    if (machine.direct === 'none') {
      expect(facts).toMatchObject({ installed: false, detail: { route: 'direct' } })
    } else {
      expect(facts).toMatchObject({ installed: true, detail: { route: 'direct', source: machine.direct } })
      if (machine.direct === 'npx') expect(facts.version).toBe(DSH_PINNED_VERSION)
    }
  })

  test('sessions run on the direct route until a plugin host connects, then on the host, then back', async () => {
    const { disk, runtime, launches } = await setup()
    expect(route(runtime)).toMatchObject({ route: 'direct', available: machine.direct !== 'none' })
    if (machine.direct === 'none') {
      await expect(runtime.open({ kind: 'existing', ref: { nativeSessionId: 'cold-1', locator: '/w' } }, { sessionId: 'sess_1', replay: 'none' }))
        .rejects.toMatchObject({ error: { code: 'runtime_unavailable' } })
      expect((await runtime.listNativeSessions()).sessions).toEqual([])
      expect(launches).toEqual([])
      return
    }
    const session = await runtime.open({ kind: 'existing', ref: { nativeSessionId: 'cold-1', locator: '/w' } }, { sessionId: 'sess_1', replay: 'none' })
    const events = collect(session)
    expect(launches).toEqual([machine.direct])
    await session.prompt({ text: 'one' }, { deliveryId: 'd1', clientMessageId: 'c1' })
    await until(() => events.some(event => event.type === 'turn.ended'), 'direct turn')
    if (!machine.host) {
      expect(replies(events)).toEqual(['direct replies to one'])
      return
    }
    const host = fakeHost(disk, { hostInstance: `${machine.host}-1`, hostKind: machine.host })
    expect(runtime.attachHost(host.route)).toBeUndefined()
    await until(() => session.routeKind === 'plugin', 'moved to the host')
    expect(route(runtime)).toMatchObject({ route: 'plugin', hostKind: machine.host })
    await session.prompt({ text: 'two' }, { deliveryId: 'd2', clientMessageId: 'c2' })
    await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'host turn')
    host.disconnect()
    await until(() => session.routeKind === 'direct', 'back on the direct route')
    await session.prompt({ text: 'three' }, { deliveryId: 'd3', clientMessageId: 'c3' })
    await until(() => events.filter(event => event.type === 'turn.ended').length === 3, 'direct again')
    expect(replies(events)).toEqual(['direct replies to one', `${machine.host}-1 replies to two`, 'direct replies to three'])
    expect(events.some(event => event.type === 'session.lost')).toBe(false)
  })

  test('a plugin host alone serves the machine even when the direct route cannot start', async () => {
    const { disk, runtime } = await setup()
    const host = fakeHost(disk, { hostInstance: 'host-1', hostKind: machine.host ?? 'headless' })
    runtime.attachHost(host.route)
    const session = await runtime.open({ kind: 'new', spec: { cwd: '/w', preferredNativeSessionId: 'aa_1_new' } }, { sessionId: 'sess_new', replay: 'none' })
    expect([session.routeKind, session.nativeSessionId]).toEqual(['plugin', 'aa_1_new'])
    expect((await runtime.listNativeSessions()).sessions.map(item => item.nativeSessionId)).toContain('aa_1_new')
    await runtime.stop()
  })
})
