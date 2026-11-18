// Agent collaboration on one device, in process: grants injected when sessions open, the collaboration tools
// through the local client API, supervision wakes, and the people's API.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CollabPeopleApi, CollabSettingsHolder, GrantService, SupervisionService, ToolService } from '../../src/application/collab/index.js'
import { ConversationService } from '../../src/application/index.js'
import { CommandInbox } from '../../src/application/inbound/index.js'
import type { OpenOptions, RuntimeHandle, RuntimeHandles, SupervisorFacts } from '../../src/application/ports/index.js'
import { PeerGateway } from '../../src/peer/gateway.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, DeviceTunnelApi, MemoryChangeFeed } from '../../src/sync/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

const DEVICE = 'dev_home'
let dir: string
let store: RemoteStore
let sessions: FakeRuntimeSession[]
let opened: OpenOptions[]
let nowMs: number
let tunnel: DeviceTunnelApi
let tools: ToolService
let supervisions: SupervisionService
let people: CollabPeopleApi
let settings: CollabSettingsHolder

const clock = { nowIso: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
const ids = { newId: (prefix: string) => `${prefix}${randomBytes(6).toString('hex')}` }
const human = { clientId: 'cli_person', label: 'Mac', platform: 'desktop' }

function runtimeHandle(): RuntimeHandle {
  return {
    type: 'codex',
    instanceId: 'codex',
    capabilities: () => ({ revision: 1, items: [{ id: 'runtime.agent_tools.host', supported: true }] }),
    catalogs: async () => ({}),
    listNativeSessions: async () => ({ sessions: [] }),
    readNativeHistory: async () => ({ items: [] }),
    open: async (target, options) => {
      opened.push(options)
      const session = new FakeRuntimeSession(options.sessionId, target.kind === 'existing' ? target.ref.nativeSessionId : `thr_${sessions.length + 1}`)
      sessions.push(session)
      return session
    },
    events: (async function* () {})(),
    stop: async () => undefined,
  }
}

async function createSession(content: string): Promise<string> {
  const response = await tunnel.request(human, { method: 'POST', path: '/api/v2/sessions/create-and-start', body: { connectorId: DEVICE, runtime: 'codex', cwd: join(dir, 'home'), content, clientMessageId: ids.newId('cm_') } })
  expect(response.status).toBe(200)
  return (response.body as { session: { id: string } }).session.id
}

async function finishTurn(session: FakeRuntimeSession, turnId: string, clientMessageId?: string): Promise<void> {
  session.emit({ type: 'turn.started', turnId, origin: 'user', ...(clientMessageId !== undefined ? { clientMessageId } : {}) })
  session.emit({ type: 'turn.ended', turnId, reason: 'end_turn' })
  await new Promise(resolve => setTimeout(resolve, 120))
}

beforeEach(() => {
  nowMs = Date.parse('2026-11-18T10:00:00Z')
  dir = mkdtempSync(join(tmpdir(), 'aa-collab-'))
  mkdirSync(join(dir, 'home'))
  store = inProcessStore(openSqliteStore({ dataDir: join(dir, 'store'), durability: 'normal', now: clock.nowIso }))
  sessions = []
  opened = []
  settings = new CollabSettingsHolder()
  settings.apply({ agentCollaboration: { enabled: true, instances: { codex: { enabled: true } } } })
  const feed = new MemoryChangeFeed()
  const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'codex' ? runtimeHandle() : null) }
  let service: ConversationService | null = null
  const facts: SupervisorFacts = {
    permissionLevel: async () => 'auto',
    busy: async sessionId => ['pending', 'running', 'stopping'].includes((await store.sessions.get(sessionId))?.status ?? ''),
    canHostTools: async () => true,
  }
  const grants = new GrantService({ deviceId: DEVICE, store, clock, ids, settings: () => settings.get(), facts, launch: { command: 'node', args: ['agent-tools.js'], env: {}, endpoint: '/tmp/tools.sock' } })
  service = new ConversationService({ store, feed, live: { emit: () => undefined }, runtimes, clock, ids, tools: grants })
  const conversation = service
  const gateway = new PeerGateway({
    deviceId: DEVICE,
    local: {
      request: async (_deviceId, actor, request) => tunnel.request(
        { clientId: `agent:${actor.sessionId}`, label: 'Agent', platform: 'agent', agent: { deviceId: actor.deviceId, sessionId: actor.sessionId, grantId: actor.grantId, ...(actor.supervisionId != null ? { supervisionId: actor.supervisionId } : {}) } },
        { method: request.method, path: `/api/v2/${request.path}`, body: request.body ?? null },
      ),
    },
    server: null,
    secure: null,
    directory: null,
    e2eeMode: () => 'off',
    now: clock.nowIso,
  })
  const escalations = { escalate: (sessionId: string, itemId: string, content: Record<string, unknown>) => conversation.appendSystemItem(sessionId, itemId, content as never) }
  supervisions = new SupervisionService({ deviceId: DEVICE, store, clock, ids, gateway, facts, escalations })
  tools = new ToolService({ deviceId: DEVICE, store, clock, ids, grants, gateway, facts, supervisions, escalations, waitPollMs: 5 })
  people = new CollabPeopleApi(supervisions, sessionId => grants.available(sessionId))
  tunnel = new DeviceTunnelApi({
    deviceId: DEVICE,
    store,
    readers: new DeviceReaders(store, clock.nowIso),
    watch: { store, feed, now: clock.nowIso },
    inbox: new CommandInbox(store, clock, service),
    clock,
    newId: ids.newId,
    collab: people,
  })
})

afterEach(async () => {
  supervisions.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent collaboration on one device', () => {
  it('injects a grant, spawns and supervises a child, and wakes the supervisor when the child finishes', async () => {
    const supervisorId = await createSession('plan the work')
    await expect.poll(() => opened.length).toBe(1)
    const server = opened[0]!.toolServers?.[0]
    expect(server).toMatchObject({ name: 'aa', command: 'node', autoApprove: true })
    const token = server!.env.AA_AGENT_TOOLS_TOKEN!
    expect(server!.env.AA_AGENT_TOOLS_ENDPOINT).toBe('/tmp/tools.sock')
    expect((await store.outbox.pending(0, 100)).some(record => record.kind === 'collab.grant.changed')).toBe(true)
    await finishTurn(sessions[0]!, 't1')

    const spawned = await tools.call(token, 'aa_spawn', { runtimeId: 'codex', cwd: join(dir, 'home'), prompt: 'write the tests' })
    expect(spawned.ok).toBe(true)
    const child = (spawned as unknown as { value: { sessionId: string; supervisionId: string } }).value
    expect(child.supervisionId).toMatch(/^sup_/u)
    const childSession = await store.sessions.get(child.sessionId)
    expect(childSession?.origin).toMatchObject({ kind: 'agent', bySessionId: supervisorId, depth: 1 })
    await expect.poll(() => sessions.length).toBe(2)
    // At the deepest level the child gets no tools of its own (maxDepth 2: depth 1 still may spawn).
    expect(opened[1]!.toolServers?.length).toBe(1)
    await expect.poll(() => sessions[1]!.calls[0]).toMatchObject({ method: 'prompt', input: { text: 'write the tests' } })
    const page = await store.timeline.latest(child.sessionId)
    expect(JSON.stringify(page)).toContain('"author":{"kind":"agent"')
    expect((await store.outbox.pending(0, 100)).some(record => record.kind === 'collab.supervision.changed')).toBe(true)

    const status = await tools.call(token, 'aa_status', { sessionId: child.sessionId })
    expect(status).toMatchObject({ ok: true, value: { sessionId: child.sessionId, deviceId: DEVICE } })
    expect(await tools.call(token, 'aa_interrupt', { sessionId: child.sessionId })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })

    // The child finishes; after the coalescing window the supervisor gets a digest as a supervision message.
    await finishTurn(sessions[1]!, 'c1')
    await supervisions.tick()
    nowMs += 31_000
    await supervisions.tick()
    await expect.poll(() => sessions[0]!.calls.filter(call => call.method === 'prompt').length, { timeout: 3_000 }).toBe(2)
    const wake = sessions[0]!.calls.filter(call => call.method === 'prompt')[1] as { input: { text: string } }
    expect(wake.input.text).toContain('[Agents Anywhere supervision]')
    expect(wake.input.text).toContain('turn ended')
    const view = await people.view(supervisorId)
    expect(view).toMatchObject({ available: true, grant: { state: 'active' }, supervisions: [{ targetSessionId: child.sessionId, state: 'active', wakesLastHour: 1 }] })

    const closed = await tools.call(token, 'aa_close', { sessionId: child.sessionId })
    expect(closed).toMatchObject({ ok: true, value: { closed: true } })
    expect((await people.view(supervisorId)).supervisions).toEqual([])
  })

  it('refuses unknown secrets, tools on oneself, and sessions it did not create', async () => {
    const supervisorId = await createSession('one')
    await expect.poll(() => opened.length).toBe(1)
    const token = opened[0]!.toolServers![0]!.env.AA_AGENT_TOOLS_TOKEN!
    const otherId = await createSession('two')
    expect(await tools.call('nope', 'aa_status', { sessionId: otherId })).toMatchObject({ ok: false, code: 'agent_grant_revoked' })
    expect(await tools.call(token, 'aa_send', { sessionId: supervisorId, message: 'hi' })).toMatchObject({ ok: false, code: 'agent_scope_denied' })
    expect(await tools.call(token, 'aa_close', { sessionId: otherId })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })
    expect(await tools.call(token, 'aa_supervise', { sessionId: otherId })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })
    // A person may set up the same supervision.
    const created = await people.supervise(human, supervisorId, { targetSessionId: otherId })
    expect(created).toMatchObject({ supervision: { createdBy: 'human', targetSessionId: otherId } })
    await expect(people.supervise(human, otherId, { targetSessionId: supervisorId })).rejects.toMatchObject({ code: 'agent_supervision_cycle' })
    await expect(people.supervise({ ...human, agent: { deviceId: DEVICE, sessionId: supervisorId, grantId: 'g' } }, supervisorId, { targetSessionId: otherId })).rejects.toMatchObject({ code: 'agent_authority_exceeded' })
  })

  it('injects nothing while collaboration is off, and revokes grants when it is turned off', async () => {
    settings.apply({ agentCollaboration: { enabled: false } })
    await createSession('off')
    await expect.poll(() => opened.length).toBe(1)
    expect(opened[0]!.toolServers).toBeUndefined()
  })

  it('exposes the agent route allowlist on the client API', async () => {
    const sessionId = await createSession('x')
    const agent = { clientId: 'agent:x', label: 'Agent', platform: 'agent', agent: { deviceId: DEVICE, sessionId: 'sess_other', grantId: 'g' } }
    const denied = await tunnel.request(agent, { method: 'PATCH', path: `/api/v2/sessions/${sessionId}/runtime/selections`, body: {} })
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ detail: { code: 'agent_route_denied' } })
    const meta = await tunnel.request(agent, { method: 'GET', path: `/api/v2/sessions/${sessionId}/meta`, body: null })
    expect(meta.status).toBe(200)
    const collab = await tunnel.request(human, { method: 'GET', path: `/api/v2/sessions/${sessionId}/collab`, body: null })
    expect(collab).toMatchObject({ status: 200, body: { sessionId, available: true, supervisions: [] } })
  })
})
