import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsAnywhereConnectorService } from '../src/bridge-service.js'
import { CatalogManager, type CatalogSnapshot } from '../src/bridge/runtime/catalogs.js'
import { InteractionManager } from '../src/bridge/runtime/interactions.js'
import { SessionManager } from '../src/bridge/runtime/sessions.js'
import { LoopbackJsonRpcServer } from '../src/bridge/wire/server.js'

const roots: string[] = []
const emptyCatalogs: CatalogSnapshot = { revision: 1, models: [], permissions: [] }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bridge service lifecycle', () => {
  it('rolls back observers, interactions, listeners, and the endpoint after partial init failure', async () => {
    const { ctx, service } = await createService()
    const disposeObservers = vi.fn()
    const disposeInteractions = vi.fn()
    const refresh = vi.spyOn(CatalogManager.prototype, 'refresh').mockResolvedValue(emptyCatalogs)
    vi.spyOn(SessionManager.prototype, 'registerObservers').mockReturnValue(disposeObservers)
    vi.spyOn(InteractionManager.prototype, 'register').mockReturnValue(disposeInteractions)
    vi.spyOn(InteractionManager.prototype, 'cancelAll').mockResolvedValue()
    vi.spyOn(SessionManager.prototype, 'shutdown').mockResolvedValue({ disposedSessions: 0, failedSessions: 0 })
    vi.spyOn(LoopbackJsonRpcServer.prototype, 'start').mockRejectedValue(new Error('synthetic endpoint failure'))
    const stop = vi.spyOn(LoopbackJsonRpcServer.prototype, 'stop').mockResolvedValue()

    await expect(service[Service.init]()).rejects.toThrow('synthetic endpoint failure')
    expect(disposeObservers).toHaveBeenCalledOnce()
    expect(disposeInteractions).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()

    await ctx.emit('llm/adapters-updated')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('contains delayed initialization notifications and reports the package version', async () => {
    const { ctx, service } = await createService()
    vi.spyOn(CatalogManager.prototype, 'refresh').mockResolvedValue(emptyCatalogs)
    vi.spyOn(CatalogManager.prototype, 'current').mockResolvedValue(emptyCatalogs)
    vi.spyOn(SessionManager.prototype, 'registerObservers').mockReturnValue(() => undefined)
    vi.spyOn(InteractionManager.prototype, 'register').mockReturnValue(() => undefined)
    vi.spyOn(InteractionManager.prototype, 'cancelAll').mockResolvedValue()
    vi.spyOn(SessionManager.prototype, 'shutdown').mockResolvedValue({ disposedSessions: 0, failedSessions: 0 })
    vi.spyOn(LoopbackJsonRpcServer.prototype, 'start').mockResolvedValue({
      version: 1,
      host: '127.0.0.1',
      port: 12345,
      token: 'test-token',
      pid: process.pid,
    })
    vi.spyOn(LoopbackJsonRpcServer.prototype, 'stop').mockResolvedValue()
    vi.spyOn(LoopbackJsonRpcServer.prototype, 'notify').mockRejectedValue(new Error('synthetic notification failure'))
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    try {
      await service[Service.init]()
      const result = await service.request({
        jsonrpc: '2.0',
        id: 'initialize-test',
        method: 'initialize',
        params: {
          protocolVersion: '1.0',
          runtime: 'dsh',
          connectorId: 'test-connector',
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }) as { identity: { bridgeVersion: string } }
      expect(result.identity.bridgeVersion).toBe('0.1.0')
      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      expect(warnings.some(message => message.includes('initial catalog publication failed')
        && message.includes('synthetic notification failure'))).toBe(true)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await (service as unknown as { shutdownCore(reason: string): Promise<unknown> }).shutdownCore('test-cleanup')
    }
  })
})

async function createService(): Promise<{ ctx: Context; service: AgentsAnywhereConnectorService }> {
  const root = await mkdtemp(join(tmpdir(), 'aa-bridge-service-'))
  roots.push(root)
  const ctx = new Context()
  ctx.provide('sessionPersistence', {
    locate: () => undefined,
    listSnapshots: () => Promise.resolve([]),
  })
  ctx.provide('userQuestions', {})
  return {
    ctx,
    service: new AgentsAnywhereConnectorService(ctx, { bridge: { stateRoot: root } }),
  }
}
