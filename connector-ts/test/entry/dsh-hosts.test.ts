// The production wiring of DSH plugin hosts: the local socket (contracts/dsh-bridge/3.0), the registry's DSH
// instance and the provider's installation facts, over a real socket with a fake DSH host on the other end.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeRegistry, type RuntimeInstanceSpec } from '../../src/application/runtimes/index.js'
import { DshHosts, dshInstanceFor } from '../../src/entry/dsh-hosts.js'
import type { Rendezvous } from '../../src/host/index.js'
import { DshRuntime, dshProvider, type LaunchProbe } from '../../src/runtime/profiles/dsh/index.js'
import { DshDisk, FakeDshAcp } from '../fixtures/fake-dsh-acp.js'

/** A machine without any `dsh`: only plugin hosts can serve. */
const noDsh: LaunchProbe = { which: async () => undefined, version: async () => undefined, exists: async () => false }

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out: ${label}`)
}

/** Dials the rendezvous as the plugin does and serves `fake` as the ACP Agent once welcomed. */
async function dialHost(rendezvous: Rendezvous, fake: FakeDshAcp, hello: Record<string, unknown> = {}): Promise<{ socket: Socket; welcome: Record<string, unknown> }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const dialled = connect((rendezvous.endpoint as { unixPath: string }).unixPath, () => resolve(dialled))
    dialled.once('error', reject)
  })
  socket.write(`${JSON.stringify({ t: 'hello', bridgeProtocol: '3.0', key: rendezvous.key, hostInstance: 'host_desktop1', hostKind: 'desktop', dshVersion: '0.2.2-rc.3', pluginVersion: '3.0.0', ...hello })}\n`)
  const welcome = await new Promise<Record<string, unknown>>(resolve => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline < 0) return
      socket.off('data', onData)
      socket.pause()
      if (newline + 1 < text.length) socket.unshift(Buffer.from(text.slice(newline + 1)))
      resolve(JSON.parse(text.slice(0, newline)) as Record<string, unknown>)
    }
    socket.on('data', onData)
  })
  if (welcome.t === 'welcome') {
    new acp.AgentSideConnection(conn => {
      fake.conn = conn
      return fake
    }, acp.ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>))
  }
  return { socket, welcome }
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  // Short: Unix socket paths are limited to about 104 bytes.
  const dir = mkdtempSync(join(tmpdir(), 'aah-'))
  let hosts: DshHosts | null = null
  const provider = dshProvider({ probe: noDsh, env: { PATH: '' }, hostsConnected: () => hosts?.connected() ?? false })
  const registry = new RuntimeRegistry({ connectorId: 'conn_1', providers: [provider], log: () => undefined })
  const attached: RuntimeInstanceSpec[] = []
  hosts = new DshHosts({ dir, instanceId: 'inst1', connectorVersion: '3.0.0-test', registry, log: () => undefined, onAttached: spec => attached.push(spec), env: { HOME: '/home/u' } })
  const started = hosts
  cleanups.push(async () => {
    await started.stop()
    await registry.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, hosts: started, registry, provider, attached }
}

describe('DSH plugin hosts on a running Connector', () => {
  it('a host that dials in serves the DSH instance: its sessions are listed and DSH counts as installed while it is connected', async () => {
    const { dir, hosts, registry, provider, attached } = setup()
    expect((await provider.discover()).installed).toBe(false)
    await hosts.start()
    const rendezvous = JSON.parse(readFileSync(join(dir, 'connector-acp.json'), 'utf8')) as Rendezvous
    expect(rendezvous).toMatchObject({ version: 3, protocol: 'acp', instanceId: 'inst1' })

    const disk = new DshDisk()
    disk.persisted = [{ sessionId: 'native-main', cwd: '/w' }, { sessionId: 'persisted-only', cwd: '/w' }]
    const host = new FakeDshAcp(disk, { plugin: true, name: 'host-1' })
    const { socket, welcome } = await dialHost(rendezvous, host)
    expect(welcome).toMatchObject({ t: 'welcome', connectorInstance: 'inst1', connectorVersion: '3.0.0-test' })
    await until(() => attached.length === 1, 'the host is attached')
    expect(attached[0]).toMatchObject({ runtimeId: 'dsh', runtimeType: 'dsh' })

    const handle = await registry.handle('dsh')
    expect(handle).toBeInstanceOf(DshRuntime)
    const runtime = handle as DshRuntime
    expect(runtime.activeRoute).toBe('plugin')
    expect(runtime.connectedHosts.map(item => item.hostInstance)).toEqual(['host_desktop1'])
    const page = await runtime.listNativeSessions()
    expect(page.sessions.map(session => session.nativeSessionId).sort()).toEqual(['native-main', 'persisted-only'])
    expect(await provider.discover()).toMatchObject({ type: 'dsh', installed: true, problems: [] })

    socket.destroy()
    await until(() => !hosts.connected(), 'the host disconnects')
    await until(() => runtime.connectedHosts.length === 0, 'the instance drops the host')
    expect((await provider.discover()).installed).toBe(false)
  })

  it('stopping removes the rendezvous file, so plugins stop dialling this Connector', async () => {
    const { dir, hosts } = setup()
    await hosts.start()
    await hosts.stop()
    expect(() => readFileSync(join(dir, 'connector-acp.json'))).toThrow()
  })

  it('picks the instance whose DSH home is the host\'s, else the default instance', () => {
    const spec = (runtimeId: string, settings: Record<string, string> = {}, enabled = true): RuntimeInstanceSpec => ({ runtimeId, runtimeType: 'dsh', settings, sourceKey: null, enabled })
    const instances = [spec('dsh'), spec('rti_work', { dshHome: '/work/.dsh' }), spec('rti_off', { dshHome: '/off/.dsh' }, false),
      { runtimeId: 'codex', runtimeType: 'codex', settings: {}, sourceKey: null, enabled: true }]
    const env = { HOME: '/home/u' }
    expect(dshInstanceFor(instances, '/work/.dsh', env)?.runtimeId).toBe('rti_work')
    expect(dshInstanceFor(instances, undefined, env)?.runtimeId).toBe('dsh')
    // A disabled instance is never used; the default one then reports the home mismatch itself.
    expect(dshInstanceFor(instances, '/off/.dsh', env)?.runtimeId).toBe('dsh')
    expect(dshInstanceFor(instances.filter(item => item.runtimeType !== 'dsh'), '/work/.dsh', env)).toBeNull()
  })
})
