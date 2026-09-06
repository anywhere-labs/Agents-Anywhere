import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import { describe, expect, it } from 'vitest'
import { MetadataStore } from '../src/persistence/metadata.js'
import { SessionManager } from '../src/runtime/sessions.js'
import type { CatalogManager } from '../src/runtime/catalogs.js'

const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => void
const contractRoot = fileURLToPath(new URL('../../contracts/dsh-bridge/1.0/schemas/', import.meta.url))

describe('current Host Session API integration', () => {
  it('creates through agents.create and makes retries idempotent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aa-dsh-session-'))
    if (process.platform !== 'win32') await chmod(cwd, 0o700)
    const stateRoot = await mkdtemp(join(tmpdir(), 'aa-dsh-state-'))
    if (process.platform !== 'win32') await chmod(stateRoot, 0o700)
    const metadata = new MetadataStore(stateRoot)
    await metadata.initialize()

    const agents = new Map<string, Agent>()
    const snapshots = new Map<string, SessionPersistenceSnapshot>()
    let createCalls = 0
    const ctx = {
      agents: {
        get: (id: SessionId) => agents.get(String(id)),
        create: async (options: {
          sessionId: SessionId
          meta?: { cwd?: string }
          setup?: (ctx: Context) => void
        }): Promise<AgentHandle> => {
          createCalls += 1
          const pending: UserMessage[] = []
          const header: SessionHeader = {
            version: 0,
            id: options.sessionId,
            createdAt: Date.now(),
            ...(options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }),
          }
          const agent = {
            id: options.sessionId,
            options: { provider: 'provider', model: 'model' },
            session: { id: options.sessionId, header, events: [] },
            inbox: { nextTurn: pending, nextStep: [], hasPending: false },
            status: 'idle',
            ctx: { on: () => () => undefined } as unknown as Context,
            followup: (message: UserMessage) => { pending.push(message) },
            steer: (message: UserMessage) => { pending.push(message) },
            send: () => undefined,
            inject: () => undefined,
            cancel: () => undefined,
            whenIdle: async () => undefined,
            runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => await task(new AbortController().signal),
          } as unknown as Agent
          options.setup?.(agent.ctx)
          agents.set(String(options.sessionId), agent)
          snapshots.set(String(options.sessionId), {
            header,
            revision: 'test:1' as SessionPersistenceSnapshot['revision'],
          })
          return {
            agent,
            dispose: async () => { agents.delete(String(options.sessionId)) },
          }
        },
      },
      sessions: { flush: async () => true },
      sessionPersistence: {
        listSnapshots: async () => [...snapshots.values()],
        inspect: async (id: SessionId) => ({
          meta: snapshots.get(String(id))?.header,
          events: [],
        }),
      },
      permissionPresets: {
        current: () => 'workspace-write',
        set: () => undefined,
        defaultPreset: 'workspace-write',
      },
      logger: { warn: () => undefined },
    } as unknown as Context
    const selection: ModelSelection = { provider: 'provider', model: 'model' }
    const catalogs = {
      defaultModel: async () => selection,
      resolveModel: async () => selection,
      resolvePermission: async () => 'workspace-write',
      permissionFor: () => 'dsh:permission:d29ya3NwYWNlLXdyaXRl',
    } as unknown as CatalogManager
    const sessions = new SessionManager(ctx, metadata, catalogs, 100, 100, async () => undefined)
    const operation = {
      sessionId: 'platform-1',
      content: 'hello',
      cwd,
      selections: {},
      attachments: [],
      clientMessageId: 'client-1',
    }
    await expect(sessions.createAndStart(operation)).resolves.toMatchObject({
      result: { accepted: true, duplicate: false },
    })
    await expect(sessions.createAndStart(operation)).resolves.toMatchObject({
      result: { accepted: true, duplicate: true },
    })
    expect(createCalls).toBe(1)
    const binding = metadata.bindingForPlatform('platform-1')
    if (binding === undefined) throw new Error('Session binding was not persisted')
    const listed = await sessions.listSessions(100, undefined, false)
    const state = await sessions.state('platform-1', binding.externalSessionId)
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false })
    addFormats(ajv)
    const validateMeta = ajv.compile(JSON.parse(
      await readFile(join(contractRoot, 'session-meta.schema.json'), 'utf8'),
    ) as AnySchema)
    const validateState = ajv.compile(JSON.parse(
      await readFile(join(contractRoot, 'session-state.schema.json'), 'utf8'),
    ) as AnySchema)
    expect(validateMeta(listed.sessions[0]), JSON.stringify(validateMeta.errors)).toBe(true)
    expect(validateState(state), JSON.stringify(validateState.errors)).toBe(true)
    await expect(sessions.createAndStart({ ...operation, content: 'different' })).rejects.toMatchObject({
      data: { code: 'IDEMPOTENCY_CONFLICT' },
    })
  })
})
