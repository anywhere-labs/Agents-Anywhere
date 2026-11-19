// The device side of encrypted mode end to end, in process: a paired client talks to DeviceTunnelApi through a real
// Noise channel (F's ClientSecureChannel ↔ SecureChannelHub), with the real store, use cases and workspace.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationService } from '../../src/application/index.js'
import { CommandInbox } from '../../src/application/inbound/index.js'
import type { RuntimeHandle, RuntimeHandles } from '../../src/application/ports/index.js'
import type { DeviceSecrets, TrustRepository } from '../../src/application/ports/trust.js'
import { DeviceTrustService } from '../../src/application/trust/device-trust-service.js'
import { ClientSecureChannel, SecureChannelHub, b64url, nodeContentSealer, parsePairingUri, sealSegments, type ChannelItem } from './legacy/index.js'
import { generateX25519, nodeNoiseCrypto, x25519FromSecret } from '../../src/channel/noise/node-crypto.js'
import { clientIdFor, type DeviceTrustState } from '../../src/domain/trust/index.js'
import { openSealedUpload } from '../../src/entry/trust.js'
import { inProcessStore, openSqliteStore, type RemoteStore } from '../../src/store/index.js'
import { DeviceReaders, DeviceTunnelApi, MemoryChangeFeed, outboxItem, plainSealer, type TerminalSink, type TunnelTerminals } from '../../src/sync/index.js'
import { AttachmentCache, FileOps, RootPolicy, ShellOps, workspaceMethods } from '../../src/workspace/index.js'
import { FakeRuntimeSession } from '../support/fake-runtime-session.js'

class MemoryRepository implements TrustRepository {
  state: DeviceTrustState | null = null
  async load() {
    return this.state
  }
  async save(state: DeviceTrustState) {
    this.state = structuredClone(state)
  }
}

class MemorySecrets implements DeviceSecrets {
  readonly identity = generateX25519()
  readonly keys = new Map<string, Uint8Array>()
  async identityKey() {
    return { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey }
  }
  async directoryKey(keyId: string) {
    return this.keys.get(keyId) ?? null
  }
  async putDirectoryKey(keyId: string, key: Uint8Array) {
    this.keys.set(keyId, key)
  }
  async deleteDirectoryKey(keyId: string) {
    this.keys.delete(keyId)
  }
}

/** One terminal whose output the test drives. */
class FakeTerminals implements TunnelTerminals {
  sink: TerminalSink | null = null
  async attach(_params: Record<string, unknown>, sink: TerminalSink) {
    this.sink = sink
    return { terminal: { terminalId: 'trm_1', status: 'running' }, seq: 2, dataBase64: Buffer.from('$ ').toString('base64') }
  }
  async release(_params: Record<string, unknown>, sink: TerminalSink) {
    if (this.sink === sink) this.sink = null
  }
}

const DEVICE = 'dev_home'
let dir: string
let store: RemoteStore
let sessions: FakeRuntimeSession[]
let uploads: Map<string, Buffer>
let terminals: FakeTerminals
let tunnel: DeviceTunnelApi

const settle = async (rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

function runtimeHandle(): RuntimeHandle {
  return {
    type: 'codex',
    instanceId: 'codex',
    capabilities: () => ({ revision: 1, items: [] }),
    catalogs: async () => ({}),
    listNativeSessions: async () => ({ sessions: [] }),
    readNativeHistory: async () => ({ items: [] }),
    open: async (target, options) => {
      const session = new FakeRuntimeSession(options.sessionId, target.kind === 'existing' ? target.ref.nativeSessionId : `thr_${sessions.length + 1}`)
      sessions.push(session)
      return session
    },
    events: (async function* () {})(),
    stop: async () => undefined,
  }
}

async function channelTo(api: DeviceTunnelApi): Promise<ClientSecureChannel> {
  const secrets = new MemorySecrets()
  const trust = new DeviceTrustService({
    deviceId: DEVICE,
    repository: new MemoryRepository(),
    secrets,
    clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
    random: { bytes: n => new Uint8Array(randomBytes(n)), id: prefix => `${prefix}${randomBytes(6).toString('hex')}` },
    sealer: nodeContentSealer,
  })
  await trust.init()
  await trust.declareServerMode('required')
  const hub = new SecureChannelHub({ deviceId: DEVICE, deviceLabel: 'Home Mac', trust, identity: x25519FromSecret(secrets.identity.secretKey), crypto: nodeNoiseCrypto, api })
  const invitation = await trust.startPairing('https://aa.example.com', 'required')
  const identity = generateX25519()
  let client: ClientSecureChannel | null = null
  let device: ReturnType<SecureChannelHub['open']> | null = null
  const deviceWire = {
    send: (item: ChannelItem) => queueMicrotask(() => void client?.receive(item)),
    end: (code?: string) => queueMicrotask(() => client?.ended(code ?? 'closed')),
  }
  const { channel } = await ClientSecureChannel.pair(parsePairingUri(invitation.uri), {
    crypto: nodeNoiseCrypto,
    identity,
    ch: 'c_test',
    wire: {
      send: async (item: ChannelItem) => {
        device ??= hub.open({ clientId: clientIdFor(identity.publicKey), ch: 'c_test' }, deviceWire)
        await device.receive(item)
      },
      end: () => void device?.close('shutdown'),
    },
    bind: (c: ClientSecureChannel) => (client = c),
    label: 'Pixel',
    platform: 'android',
  })
  return channel
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-tunnel-'))
  mkdirSync(join(dir, 'home'))
  store = inProcessStore(openSqliteStore({ dataDir: join(dir, 'store'), durability: 'normal', now: () => new Date().toISOString() }))
  sessions = []
  uploads = new Map()
  terminals = new FakeTerminals()
  const feed = new MemoryChangeFeed()
  const clock = { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() }
  const ids = { newId: (prefix: string) => `${prefix}${randomBytes(6).toString('hex')}` }
  const cache = new AttachmentCache(join(dir, 'attachments'), async fileId => (async function* () {
    yield uploads.get(fileId) ?? Buffer.alloc(0)
  })(), openSealedUpload)
  const runtimes: RuntimeHandles = { handle: async runtimeId => (runtimeId === 'codex' ? runtimeHandle() : null) }
  const service = new ConversationService({
    store,
    feed,
    live: { emit: () => undefined },
    runtimes,
    clock,
    ids,
    attachments: async (sessionId, ref) => {
      const local = await cache.resolve(sessionId, ref)
      return { kind: 'file', path: local.path, mimeType: local.mediaType, name: local.name }
    },
  })
  const policy = new RootPolicy({ roots: [join(dir, 'home')] })
  tunnel = new DeviceTunnelApi({
    deviceId: DEVICE,
    store,
    readers: new DeviceReaders(store, clock.nowIso),
    watch: { store, feed, now: clock.nowIso },
    inbox: new CommandInbox(store, clock, service),
    clock,
    workspace: workspaceMethods(new FileOps(policy), new ShellOps(policy)),
    terminals,
    newId: ids.newId,
  })
})

afterEach(async () => {
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('encrypted mode on the device: the client API inside the channel', () => {
  it('creates and starts a session through the channel, then sends a message with a sealed attachment', async () => {
    const channel = await channelTo(tunnel)
    const created = await channel.request('POST', '/api/v2/sessions/create-and-start', { connectorId: DEVICE, projectId: 'prj_1', runtime: 'codex', cwd: join(dir, 'home'), content: 'hello', clientMessageId: 'cm_create' })
    expect(created.status).toBe(200)
    const session = (created.body as { session: { id: string; connectorId: string; runtime: string } }).session
    expect(session).toMatchObject({ connectorId: DEVICE, runtime: 'codex' })
    await expect.poll(() => sessions[0]?.calls[0]).toMatchObject({ method: 'prompt', input: { text: 'hello' } })
    sessions[0]!.emit({ type: 'turn.started', turnId: 't1', origin: 'user', clientMessageId: 'cm_create' })
    sessions[0]!.emit({ type: 'turn.ended', turnId: 't1', reason: 'end_turn' })
    await new Promise(resolve => setTimeout(resolve, 150))
    // A retry with the same clientMessageId does not create a second session.
    const again = await channel.request('POST', '/api/v2/sessions/create-and-start', { connectorId: DEVICE, projectId: 'prj_1', runtime: 'codex', cwd: join(dir, 'home'), content: 'hello', clientMessageId: 'cm_create' })
    expect((again.body as { session: { id: string } }).session.id).toBe(session.id)
    // The summary goes out sealed-free of content in the outbox; the command receipt is scrubbed in encrypted mode.
    const pending = await store.outbox.pending(0, 100)
    const result = pending.find(record => record.kind === 'command.result')!
    // The project the client chose travels with the summary in the clear, so the Server can file the new row.
    const summary = pending.find(record => record.kind === 'session.summary')!
    expect((await outboxItem(summary, { ...plainSealer, encrypted: true })).p).toMatchObject({ summary: { sessionId: session.id, projectId: 'prj_1' } })
    expect(session).toMatchObject({ projectId: 'prj_1' })
    expect((await outboxItem(result, { ...plainSealer, encrypted: true })).p).toEqual({ commandId: 'cm_create', outcome: 'accepted', r: null })

    // A sealed upload: the Server holds ciphertext under attachment.bin; name, type and key come through the channel.
    const plaintext = randomBytes(150_000)
    const sha256 = createHash('sha256').update(plaintext).digest('hex')
    const key = randomBytes(32)
    uploads.set('file_1', Buffer.concat(sealSegments('attachment', sha256, key, plaintext)))
    const sent = await channel.request('POST', `/api/v2/sessions/${session.id}/runtime/messages`, {
      content: 'see attached',
      clientMessageId: 'cm_2',
      attachments: [{ fileId: 'file_1', name: 'attachment.bin', mediaType: 'application/octet-stream', size: 150_032 }],
      sealedAttachmentKeys: [{ fileId: 'file_1', key: b64url(key), size: plaintext.length, sha256, name: 'photo.png', mimeType: 'image/png' }],
    })
    expect(sent.status).toBe(200)
    // Downloading and opening the upload takes real I/O: wait for the prompt rather than a fixed number of ticks.
    const findPrompt = () => sessions[0]!.calls.find(call => call.method === 'prompt' && (call as { input: { text: string } }).input.text === 'see attached')
    await expect.poll(findPrompt).toBeTruthy()
    const prompt = findPrompt() as unknown as { input: { attachments: { kind: string; path: string; mimeType: string; name: string }[] } }
    // The platform identity rides along, so a Runtime that records it natively (Pi) shows it again in history.
    expect(prompt.input.attachments[0]).toMatchObject({ kind: 'file', mimeType: 'image/png', name: 'photo.png', info: { fileId: 'file_1', name: 'photo.png', mediaType: 'image/png', sha256 } })
    expect(readFileSync(prompt.input.attachments[0]!.path).equals(plaintext)).toBe(true)

    // A key that does not open the upload is refused before the Runtime sees anything.
    uploads.set('file_2', Buffer.concat(sealSegments('attachment', sha256, randomBytes(32), plaintext)))
    const bad = await channel.request('POST', `/api/v2/sessions/${session.id}/runtime/messages`, {
      content: 'tampered',
      clientMessageId: 'cm_3',
      attachments: [{ fileId: 'file_2' }],
      sealedAttachmentKeys: [{ fileId: 'file_2', key: b64url(key), size: plaintext.length, sha256 }],
    })
    // Accepted like any message (the hand-off is asynchronous), then rejected before the Runtime: never a prompt.
    expect(bad.status).toBe(200)
    await expect.poll(async () => (await store.deliveries.get(session.id, 'cm_3'))?.state).toBe('rejected')
    expect(await store.deliveries.get(session.id, 'cm_3')).toMatchObject({ state: 'rejected', errorCode: 'attachment_corrupt' })
    expect(sessions[0]!.calls.some(call => call.method === 'prompt' && (call as { input: { text: string } }).input.text === 'tampered')).toBe(false)
  }, 20_000)

  it('reads a file in chunks, lists directories and answers unknown routes with 404', async () => {
    const channel = await channelTo(tunnel)
    const bytes = randomBytes(20_000)
    writeFileSync(join(dir, 'home', 'big.bin'), bytes)
    const root = join(dir, 'home')
    const parts: Buffer[] = []
    let offset = 0
    for (;;) {
      const response = await channel.request('GET', `/api/v2/connectors/${DEVICE}/fs/read?${new URLSearchParams({ root, path: 'big.bin', offset: String(offset), length: '8192' })}`)
      expect(response.status).toBe(200)
      const chunk = response.body as { encoding: string; data: string; offset: number; size: number; eof: boolean }
      expect(chunk).toMatchObject({ encoding: 'base64', offset, size: bytes.length })
      parts.push(Buffer.from(chunk.data, 'base64'))
      offset += Buffer.from(chunk.data, 'base64').length
      if (chunk.eof) break
    }
    expect(parts).toHaveLength(3)
    expect(Buffer.concat(parts).equals(bytes)).toBe(true)
    const listed = await channel.request('POST', `/api/v2/connectors/${DEVICE}/fs/list?root=${encodeURIComponent(root)}`, { path: '.' })
    expect((listed.body as { result: { entries: { name: string }[] } }).result.entries.map(entry => entry.name)).toContain('big.bin')
    // Outside the allowed roots: refused by the workspace policy.
    const outside = await channel.request('GET', `/api/v2/connectors/${DEVICE}/fs/read?${new URLSearchParams({ root: '/', path: 'etc/hosts' })}`)
    expect(outside.status).toBeGreaterThanOrEqual(400)
    expect((await channel.request('GET', `/api/v2/connectors/dev_other/fs/read?root=/`)).status).toBe(404)
    expect((await channel.request('GET', '/api/v2/sessions/sess_x/unknown')).status).toBe(404)
  })

  it('streams a terminal: replay first, then output and exit', async () => {
    const channel = await channelTo(tunnel)
    const events: Record<string, unknown>[] = []
    const id = await channel.subscribeTerminal('trm_1', 0, event => events.push(event))
    await settle()
    expect(events).toEqual([{ type: 'replay', data: Buffer.from('$ ').toString('base64'), seq: 2 }])
    terminals.sink!('terminal.output', { terminalId: 'trm_1', seq: 3, dataBase64: Buffer.from('ls').toString('base64') })
    terminals.sink!('terminal.exited', { terminalId: 'trm_1', exitCode: 0, reason: 'exit' })
    await settle()
    expect(events.slice(1)).toEqual([{ type: 'output', data: Buffer.from('ls').toString('base64'), seq: 3 }, { type: 'exit', exitCode: 0, reason: 'exit' }])
    await channel.unsubscribe(id)
    await settle()
    expect(terminals.sink).toBeNull()
  })

  it('streams session events and serves reads (snapshot, timeline) through the channel', async () => {
    const channel = await channelTo(tunnel)
    const created = await channel.request('POST', '/api/v2/sessions/create-and-start', { connectorId: DEVICE, runtime: 'codex', cwd: join(dir, 'home'), content: 'first', clientMessageId: 'cm_s' })
    const sessionId = (created.body as { session: { id: string } }).session.id
    await settle()
    const own = (await store.outbox.pending(0, 100)).filter(record => record.kind === 'session.summary' && record.sessionId === sessionId)
    for (const record of own) expect(((await outboxItem(record, plainSealer)).p as { summary: Record<string, unknown> }).summary).not.toHaveProperty('projectId')
    const events: Record<string, unknown>[] = []
    await channel.subscribe(sessionId, 'seq:0', event => events.push(event))
    await expect.poll(() => events.some(event => event.type === 'timeline.item_created')).toBe(true)
    const snapshot = await channel.request('GET', `/api/v2/sessions/${sessionId}/snapshot`)
    expect(snapshot.body).toMatchObject({ session: { id: sessionId, connectorId: DEVICE }, historySource: 'live' })
    const timeline = await channel.request('GET', `/api/v2/sessions/${sessionId}/timeline?mode=latest&limit=10`)
    expect((timeline.body as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })
})
