import { describe, expect, it } from 'vitest'

import type { ProviderFacts, RuntimeHandle, RuntimeHandleEvent, RuntimeInstanceConfig, RuntimeProvider } from '../../src/application/ports/index.js'
import { claudeStableSessionId, codexStableSessionId, piNativeSessionId, sessionNamespace } from '../../src/domain/identity/index.js'
import { builtinProviders, nativeSessionId, RuntimeRegistry, runtimeSpecFrom } from '../../src/entry/runtimes.js'
import { FakeRuntimeSession, PushQueue } from '../support/fake-runtime-session.js'

class FakeHandle implements RuntimeHandle {
  public readonly events = new PushQueue<RuntimeHandleEvent>()
  public stopped = false
  public constructor(public readonly type: string, public readonly instanceId: string, public readonly config: RuntimeInstanceConfig) {}
  capabilities = () => ({ revision: 1, items: [] })
  catalogs = async () => ({})
  listNativeSessions = async () => ({ sessions: [] })
  readNativeHistory = async () => ({ items: [] })
  open = async (_target: unknown, options: { sessionId: string }) => new FakeRuntimeSession(options.sessionId, 'native')
  stop = async () => {
    this.stopped = true
    this.events.close()
  }
}

class FakeProvider implements RuntimeProvider {
  public readonly started: FakeHandle[] = []
  public failures = 0
  public constructor(public readonly type: string) {}
  async discover(): Promise<ProviderFacts> {
    return { type: this.type, displayName: this.type, installed: true, problems: [], instancePolicy: 'multiple', processScope: 'shared' }
  }
  async start(instance: RuntimeInstanceConfig): Promise<RuntimeHandle> {
    await new Promise(resolve => setTimeout(resolve, 5))
    if (this.failures > 0) {
      this.failures--
      throw new Error('agent missing')
    }
    const handle = new FakeHandle(this.type, instance.instanceId, instance)
    this.started.push(handle)
    return handle
  }
}

const log = () => undefined

describe('RuntimeRegistry', () => {
  it('has the legacy instance of each type, starts it once on first use, and passes the v2 namespace', async () => {
    const codex = new FakeProvider('codex')
    const registry = new RuntimeRegistry({ connectorId: 'dev_1', providers: [codex, new FakeProvider('pi')], log })
    expect(registry.instances().map(spec => spec.runtimeId)).toEqual(['codex', 'pi'])
    const [a, b] = await Promise.all([registry.handle('codex'), registry.handle('codex')])
    expect(a).toBe(b)
    expect(codex.started).toHaveLength(1)
    // The legacy instance keeps the bare connector id as its namespace.
    expect(codex.started[0]!.config).toMatchObject({ instanceId: 'codex', sessionNamespace: 'dev_1', settings: {} })
    expect(await registry.handle('rti_unknown')).toBeNull()
  })

  it('applies desired instances: named ones start with their settings, a changed one restarts, unknown types are skipped', async () => {
    const pi = new FakeProvider('pi')
    const registry = new RuntimeRegistry({ connectorId: 'dev_1', providers: [pi], log })
    registry.apply([
      { runtimeId: 'rti_work', runtimeType: 'pi', settings: { model: 'a' }, sourceKey: { kind: 'pi_home', key: '/w' } },
      { runtimeId: 'rti_x', runtimeType: 'gemini' },
      { runtimeType: 'pi' },
    ])
    expect(registry.instances().map(spec => spec.runtimeId)).toEqual(['pi', 'rti_work'])
    const first = (await registry.handle('rti_work')) as FakeHandle
    expect(first.config).toMatchObject({
      instanceId: 'rti_work',
      settings: { model: 'a' },
      sessionNamespace: sessionNamespace({ connectorId: 'dev_1', runtimeType: 'pi', runtimeId: 'rti_work', sourceKey: { kind: 'pi_home', key: '/w' } }),
    })
    registry.apply([{ runtimeId: 'rti_work', runtimeType: 'pi', settings: { model: 'b' }, sourceKey: { kind: 'pi_home', key: '/w' } }])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(first.stopped).toBe(true)
    expect(((await registry.handle('rti_work')) as FakeHandle).config.settings).toEqual({ model: 'b' })
    // Same spec: nothing restarts.
    registry.apply([{ runtimeId: 'rti_work', runtimeType: 'pi', settings: { model: 'b' }, sourceKey: { kind: 'pi_home', key: '/w' } }])
    expect(pi.started).toHaveLength(2)
    // Disabled or removed: no handle, and the running one stops.
    registry.apply([{ runtimeId: 'pi', runtimeType: 'pi', enabled: false }])
    expect(await registry.handle('pi')).toBeNull()
    expect(await registry.handle('rti_work')).toBeNull()
    await registry.close()
    expect(pi.started.every(handle => handle.stopped)).toBe(true)
  })

  it('does not cache a failed start, and forwards Runtime events with the instance', async () => {
    const claude = new FakeProvider('claude')
    claude.failures = 1
    const events: string[] = []
    const registry = new RuntimeRegistry({ connectorId: 'dev_1', providers: [claude], log, onEvent: (spec, _handle, event) => events.push(`${spec.runtimeId}:${event.type}`) })
    expect(await registry.handle('claude')).toBeNull()
    const handle = (await registry.handle('claude')) as FakeHandle
    expect(handle).not.toBeNull()
    handle.events.push({ type: 'status', status: 'ready' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(['claude:status'])
    const discovered = await registry.discover()
    expect(discovered.map(entry => [entry.spec.runtimeId, entry.facts?.installed])).toEqual([['claude', true]])
    await registry.close()
  })

  it('reads desired items defensively', () => {
    expect(runtimeSpecFrom(null)).toBeNull()
    expect(runtimeSpecFrom({ runtimeId: 'r', runtimeType: 'pi', values: { a: 1 }, enabled: false, modelGateway: { baseUrl: 'https://g', authToken: 't', protocol: 'anthropic', model: 'm' }, command: 'rm' }))
      .toEqual({ runtimeId: 'r', runtimeType: 'pi', settings: { a: 1 }, sourceKey: null, enabled: false, modelGateway: { baseUrl: 'https://g', authToken: 't', protocol: 'anthropic', model: 'm' } })
    expect(runtimeSpecFrom({ runtimeId: 'r', runtimeType: 'pi', modelGateway: { baseUrl: 'https://g', authToken: 't', protocol: 'other' } })).not.toHaveProperty('modelGateway')
  })
})

describe('native session ids keep the v2 rules', () => {
  const legacy = (type: string) => ({ runtimeId: type, runtimeType: type, settings: {}, sourceKey: null, enabled: true })
  it('per Runtime type', () => {
    expect(nativeSessionId('dev_1', legacy('codex'), { nativeSessionId: 'thr_1' })).toBe(codexStableSessionId('dev_1', 'thr_1'))
    expect(nativeSessionId('dev_1', legacy('claude'), { nativeSessionId: 'u-1' })).toBe(claudeStableSessionId('dev_1', 'u-1'))
    expect(nativeSessionId('dev_1', legacy('pi'), { nativeSessionId: 'p1', locator: '/h/s.jsonl' })).toBe(piNativeSessionId('pi', '/h/s.jsonl', 'p1'))
    expect(nativeSessionId('dev_1', legacy('opencode'), { nativeSessionId: 'o1' })).toMatch(/^acp_native_[0-9a-f]{40}$/u)
  })

  it('ships every B profile', () => {
    expect(builtinProviders({ log }).map(provider => provider.type)).toEqual(['codex', 'claude', 'pi', 'hermes', 'opencode', 'antigravity', 'codebuddy', 'commandcode', 'mimo', 'minimax'])
  })
})
