import { describe, expect, it } from 'vitest'

import type { LiveEvents, ProviderFacts, RuntimeHandle, RuntimeHandleEvent, RuntimeProvider } from '../../src/application/ports/index.js'
import { announceRuntimes, applyRuntime, capabilitySet, runtimeCapabilities, runtimeEvent, RuntimeRegistry, type RuntimeScans } from '../../src/application/runtimes/index.js'
import { declaredRuntimeCapabilities } from '../../src/domain/runtimes/index.js'
import type { ProtocolCapabilitySet } from '../../src/generated/protocol/v1_2/capability-set.js'
import { PushQueue } from '../support/fake-runtime-session.js'

/** A started instance whose Agent has not run: like an ACP handle before `initialize`, it reports nothing. */
class NotNegotiatedHandle implements RuntimeHandle {
  public readonly events = new PushQueue<RuntimeHandleEvent>()
  public constructor(public readonly type: string, public readonly instanceId: string) {}
  capabilities = () => ({ revision: 1, items: [] })
  catalogs = async () => ({})
  listNativeSessions = async () => ({ sessions: [] })
  readNativeHistory = async () => ({ items: [] })
  open = async () => { throw new Error('not used') }
  stop = async () => this.events.close()
}

class Provider implements RuntimeProvider {
  public constructor(public readonly type: string) {}
  async discover(): Promise<ProviderFacts> {
    return { type: this.type, displayName: this.type, installed: true, problems: [], instancePolicy: 'multiple', processScope: 'shared' }
  }
  async start(instance: { instanceId: string }): Promise<RuntimeHandle> {
    return new NotNegotiatedHandle(this.type, instance.instanceId)
  }
}

const log = () => undefined

function recorder(): { live: LiveEvents; events: { method: string; payload: Record<string, unknown> }[] } {
  const events: { method: string; payload: Record<string, unknown> }[] = []
  return { events, live: { emit: (method: string, payload: unknown) => events.push({ method, payload: payload as Record<string, unknown> }) } as unknown as LiveEvents }
}

const items = (set: ProtocolCapabilitySet): NonNullable<ProtocolCapabilitySet['capabilities']> => set.capabilities ?? []
const ids = (set: ProtocolCapabilitySet): string[] => items(set).map(item => item.capabilityId)

describe('runtimeCapabilities', () => {
  it('reports the declared set while the Agent has not negotiated', () => {
    const set = capabilitySet(runtimeCapabilities('claude', { revision: 1, items: [] }), { runtime: 'claude', sessionId: null })
    expect(ids(set)).toEqual(declaredRuntimeCapabilities('claude').map(item => item.id))
    const planning = items(set).find(item => item.capabilityId === 'session.planning')
    expect(planning).toMatchObject({ supported: true, available: true, scope: 'runtime', runtime: 'claude', sessionId: null })
    expect(items(set).find(item => item.capabilityId === 'session.steer')).toMatchObject({ supported: false, available: false })
  })

  it('lets the live capabilities win once known', () => {
    const merged = runtimeCapabilities('claude', { revision: 2, items: [
      { id: 'session.steer', supported: true },
      { id: 'runtime.attachment', supported: false },
      { id: 'session.fork', supported: true },
    ] })
    expect(merged.revision).toBe(2)
    const byId = new Map(merged.items.map(item => [item.id, item]))
    expect(byId.get('session.steer')).toEqual({ id: 'session.steer', supported: true })
    expect(byId.get('runtime.attachment')).toEqual({ id: 'runtime.attachment', supported: false })
    expect(byId.get('session.fork')?.supported).toBe(true)
    expect(byId.get('session.planning')?.supported).toBe(true)
  })

  it('marks the declared set unavailable without a started instance', () => {
    const set = capabilitySet(runtimeCapabilities('codex', null), { runtime: 'codex', sessionId: null })
    expect(set.revision).toBe(0)
    const send = items(set).find(item => item.capabilityId === 'session.send_message')
    expect(send).toMatchObject({ supported: true, available: false, unavailableReason: 'runtime_not_running' })
    expect(items(set).every(item => item.available === false)).toBe(true)
  })
})

describe('reported runtime capabilities before the Agent has run', () => {
  for (const type of ['codex', 'claude', 'pi', 'hermes', 'dsh', 'opencode']) {
    it(`${type}: runtime.apply and runtime.status carry the declared set`, async () => {
      const registry = new RuntimeRegistry({ connectorId: 'dev_1', providers: [new Provider(type)], log })
      const declared = declaredRuntimeCapabilities(type).map(item => item.id)
      const applied = await applyRuntime(registry, { runtimeId: 'rti_1', runtimeType: type, active: true, config: {} })
      expect(applied.status).toBe('running')
      expect(ids(applied.capabilities!)).toEqual(declared)
      expect(items(applied.capabilities!).every(item => item.runtime === type && item.scope === 'runtime')).toBe(true)

      const { live, events } = recorder()
      await announceRuntimes(registry, live, log)
      const reported = events.filter(event => event.payload.runtimeId !== '*')
      expect(reported.length).toBeGreaterThan(0)
      for (const event of reported) expect(ids(event.payload.capabilities as ProtocolCapabilitySet)).toEqual(declared)
      await registry.close()
    })
  }

  it('a capabilities change is reported merged with the declared set', async () => {
    const { live, events } = recorder()
    const handle = new NotNegotiatedHandle('codex', 'codex')
    runtimeEvent({
      spec: { runtimeId: 'codex', runtimeType: 'codex', settings: {}, sourceKey: null, enabled: true },
      handle,
      event: { type: 'capabilities.changed', capabilities: { revision: 3, items: [{ id: 'session.steer', supported: false }, { id: 'runtime.owner_release', supported: true }] } },
      live,
      scans: {} as RuntimeScans,
      conversations: { binding: async () => null },
      store: { sessions: {} as never },
      connectorId: 'dev_1',
      log,
    })
    const set = events[0]!.payload.capabilities as ProtocolCapabilitySet
    expect(set.revision).toBe(3)
    expect(items(set).find(item => item.capabilityId === 'session.steer')?.supported).toBe(false)
    expect(items(set).find(item => item.capabilityId === 'session.goal')?.supported).toBe(false)
    expect(ids(set)).toContain('runtime.owner_release')
  })
})
