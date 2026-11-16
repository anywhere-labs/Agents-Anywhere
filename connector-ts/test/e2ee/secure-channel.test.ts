import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChannelCaller, TunnelApi } from '../../src/application/inbound/tunnel-api.js'
import type { DeviceSecrets, TrustRepository } from '../../src/application/ports/trust.js'
import { DeviceTrustService } from '../../src/application/trust/device-trust-service.js'
import {
  ChannelClosedError,
  ClientSecureChannel,
  SecureChannelHub,
  fromB64url,
  nodeContentSealer,
  parsePairingUri,
  sealSegments,
  type ChannelItem,
  type PairingPayload,
} from '../../src/channel/index.js'
import { nodeNoiseCrypto, x25519FromSecret, generateX25519, type X25519KeyPair } from '../../src/channel/noise/node-crypto.js'
import { clientIdFor, type DeviceTrustState } from '../../src/domain/trust/index.js'

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

class FakeApi implements TunnelApi {
  readonly requests: { caller: ChannelCaller; method: string; path: string; body: unknown }[] = []
  readonly emitters = new Map<string, (event: Record<string, unknown>) => void>()
  async request(caller: ChannelCaller, request: { method: string; path: string; body: unknown }) {
    this.requests.push({ caller, ...request })
    return { status: 200, body: { echo: request.body, path: request.path } }
  }
  async subscribe(_caller: ChannelCaller, subscription: { sessionId: string }, emit: (event: Record<string, unknown>) => void) {
    this.emitters.set(subscription.sessionId, emit)
    return () => this.emitters.delete(subscription.sessionId)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

type Tamper = (item: ChannelItem, index: number) => ChannelItem | null

interface RelayOptions {
  /** What the relay puts in SecureChannelOpen.clientId (a malicious Server may lie). */
  readonly routeClientId?: string
  readonly toDevice?: Tamper
  readonly toClient?: Tamper
}

let now = Date.parse('2026-11-16T12:00:00Z')

async function device() {
  const repository = new MemoryRepository()
  const secrets = new MemorySecrets()
  const approvals: boolean[] = []
  const trust = new DeviceTrustService({
    deviceId: 'dev_home',
    repository,
    secrets,
    clock: { nowMs: () => now, nowIso: () => new Date(now).toISOString() },
    random: { bytes: (n) => new Uint8Array(randomBytes(n)), id: (prefix) => `${prefix}${randomBytes(6).toString('hex')}` },
    sealer: nodeContentSealer,
    confirmation: { confirmClientApproval: async () => approvals.shift() ?? false },
  })
  await trust.init()
  await trust.declareServerMode('required')
  const api = new FakeApi()
  const hub = new SecureChannelHub({
    deviceId: 'dev_home',
    deviceLabel: 'Home Mac',
    trust,
    identity: x25519FromSecret(secrets.identity.secretKey),
    crypto: nodeNoiseCrypto,
    api,
    now: () => now,
  })
  return { trust, hub, api, secrets, repository, approvals }
}

type Device = Awaited<ReturnType<typeof device>>

/** An in-memory Server: forwards {n, ct} between one client channel and the device hub, optionally tampering. */
function relay(dev: Device, identity: X25519KeyPair, ch: string, options: RelayOptions = {}) {
  let client: ClientSecureChannel | null = null
  let deviceChannel: ReturnType<SecureChannelHub['open']> | null = null
  let toDevice = 0
  let toClient = 0
  const ends: string[] = []
  const deviceWire = {
    send: (item: ChannelItem) => {
      const out = options.toClient ? options.toClient(item, toClient++) : item
      if (out) queueMicrotask(() => client?.receive(out))
    },
    end: (code?: string) => {
      ends.push(code ?? 'closed')
      queueMicrotask(() => client?.ended(code ?? 'closed'))
    },
  }
  const clientWire = {
    send: async (item: ChannelItem) => {
      deviceChannel ??= dev.hub.open({ clientId: options.routeClientId ?? clientIdFor(identity.publicKey), ch }, deviceWire)
      const out = options.toDevice ? options.toDevice(item, toDevice++) : item
      if (out) await deviceChannel.receive(out)
    },
    end: () => void deviceChannel?.close('shutdown'),
  }
  return {
    options: { crypto: nodeNoiseCrypto, identity, ch, wire: clientWire, now: () => now, bind: (c: ClientSecureChannel) => (client = c) },
    ends,
    replay: (item: ChannelItem) => deviceChannel!.receive(item),
  }
}

async function pairClient(dev: Device, label = 'Pixel', identity = generateX25519()) {
  const invitation = await dev.trust.startPairing('https://aa.example.com', 'required')
  const payload = parsePairingUri(invitation.uri)
  const link = relay(dev, identity, `c_${randomBytes(4).toString('hex')}`)
  const paired = await ClientSecureChannel.pair(payload, { ...link.options, label, platform: 'android' })
  return { identity, payload, ...paired }
}

beforeEach(() => {
  now = Date.parse('2026-11-16T12:00:00Z')
})

describe('扫码配对（XXpsk0）与重连（KK）', () => {
  it('配对后拿到列表密钥，请求与订阅走同一组用例', async () => {
    const dev = await device()
    const { channel, directoryKey, identity } = await pairClient(dev)
    expect(channel.ready.clientId).toBe(clientIdFor(identity.publicKey))
    expect(directoryKey.keyId).toBe(dev.trust.state.directoryKey.keyId)
    expect(fromB64url(directoryKey.key)).toEqual(await dev.secrets.directoryKey(directoryKey.keyId))
    expect(dev.trust.trustList().grants).toMatchObject([{ clientId: channel.clientId, label: 'Pixel', grantedBy: 'qr' }])

    const response = await channel.request('POST', '/api/v2/sessions/s1/messages', { content: 'hello' })
    expect(response).toEqual({ status: 200, body: { echo: { content: 'hello' }, path: '/api/v2/sessions/s1/messages' } })
    expect(dev.api.requests[0]!.caller).toEqual({ clientId: channel.clientId, label: 'Pixel', platform: 'android' })

    const events: Record<string, unknown>[] = []
    await channel.subscribe('s1', 'seq:0', (event) => events.push(event))
    await tick()
    dev.api.emitters.get('s1')!({ type: 'timeline.item_created', seq: 1 })
    await tick()
    await tick()
    expect(events).toEqual([{ type: 'timeline.item_created', seq: 1 }])
  })

  it('大消息分片，双向 rekey 后照常收发', async () => {
    const dev = await device()
    const { channel } = await pairClient(dev)
    const big = 'x'.repeat(200_000)
    expect((await channel.request('POST', '/api/v2/big', { big })).body).toMatchObject({ echo: { big } })
    await channel.rekeyNow()
    expect((await channel.request('GET', '/api/v2/after-rekey')).status).toBe(200)
    now += 61 * 60 * 1000 // the device's send direction is now due for a time-based rekey
    expect((await channel.request('GET', '/api/v2/after-time-rekey')).status).toBe(200)
  })

  it('配对码只能用一次，10 分钟后过期', async () => {
    const dev = await device()
    const invitation = await dev.trust.startPairing('https://aa.example.com', 'required')
    const payload = parsePairingUri(invitation.uri)
    const first = relay(dev, generateX25519(), 'c_a')
    await ClientSecureChannel.pair(payload, { ...first.options, label: 'A', platform: 'ios' })
    const second = relay(dev, generateX25519(), 'c_b')
    await expect(ClientSecureChannel.pair(payload, { ...second.options, label: 'B', platform: 'ios' })).rejects.toMatchObject({
      code: 'pairing_expired',
    })

    const late = parsePairingUri((await dev.trust.startPairing('https://aa.example.com', 'required')).uri)
    now += 11 * 60 * 1000
    const third = relay(dev, generateX25519(), 'c_c')
    await expect(ClientSecureChannel.pair(late, { ...third.options, label: 'C', platform: 'ios' })).rejects.toMatchObject({
      code: 'pairing_expired',
    })
  })

  it('同一时刻最多 3 个打开的配对', async () => {
    const dev = await device()
    for (let i = 0; i < 3; i++) await dev.trust.startPairing('https://aa.example.com', 'required')
    await expect(dev.trust.startPairing('https://aa.example.com', 'required')).rejects.toMatchObject({ code: 'pairing_limit' })
  })

  it('KK 重连：新 ch、钉住的设备公钥', async () => {
    const dev = await device()
    const { identity, payload } = await pairClient(dev)
    const link = relay(dev, identity, 'c_again')
    const channel = await ClientSecureChannel.connect(payload.deviceId, fromB64url(payload.deviceIdentityPub), link.options)
    expect(channel.ready.directoryKeyEpoch).toBe(0)
    expect((await channel.request('GET', '/api/v2/sessions')).status).toBe(200)
  })

  it('未授权的客户端 KK 被拒（e2ee_not_paired）', async () => {
    const dev = await device()
    const devicePub = (await dev.secrets.identityKey()).publicKey
    const link = relay(dev, generateX25519(), 'c_x')
    await expect(ClientSecureChannel.connect('dev_home', devicePub, link.options)).rejects.toMatchObject({ code: 'e2ee_not_paired' })
  })
})

describe('E-2：Server 无法中间人配对', () => {
  it('没有 psk：Server 用自己猜的 psk 冒充客户端，设备拒绝', async () => {
    const dev = await device()
    const real = parsePairingUri((await dev.trust.startPairing('https://aa.example.com', 'required')).uri)
    const forged: PairingPayload = { ...real, psk: Buffer.from(randomBytes(32)).toString('base64url') }
    const link = relay(dev, generateX25519(), 'c_mitm')
    await expect(ClientSecureChannel.pair(forged, { ...link.options, label: 'mitm', platform: 'web' })).rejects.toBeInstanceOf(ChannelClosedError)
    expect(link.ends).toEqual(['e2ee_handshake_failed'])
    expect(dev.trust.trustList().grants).toEqual([])
    // The real pairing is still usable afterwards.
    const ok = relay(dev, generateX25519(), 'c_ok')
    await ClientSecureChannel.pair(real, { ...ok.options, label: 'real', platform: 'ios' })
  })

  it('Server 把配对握手转给自己控制的设备身份：没有 psk，配对失败', async () => {
    const dev = await device()
    const real = parsePairingUri((await dev.trust.startPairing('https://aa.example.com', 'required')).uri)
    const evil = await device() // another identity the Server controls, knowing nothing of the psk
    const forged: PairingPayload = { ...real }
    const link = relay(evil, generateX25519(), 'c_swap')
    await expect(ClientSecureChannel.pair(forged, { ...link.options, label: 'x', platform: 'ios' })).rejects.toBeInstanceOf(ChannelClosedError)
    expect(evil.trust.trustList().grants).toEqual([])
  })

  it('篡改第 2 条握手消息里的设备公钥：客户端拒绝', async () => {
    const dev = await device()
    const payload = parsePairingUri((await dev.trust.startPairing('https://aa.example.com', 'required')).uri)
    const link = relay(dev, generateX25519(), 'c_t', {
      toClient: (item, index) => {
        if (index !== 0) return item
        const envelope = JSON.parse(Buffer.from(item.ct, 'base64url').toString('utf8'))
        const message = Buffer.from(envelope.message, 'base64url')
        message[40]! ^= 1
        return { ...item, ct: Buffer.from(JSON.stringify({ ...envelope, message: message.toString('base64url') })).toString('base64url') }
      },
    })
    await expect(ClientSecureChannel.pair(payload, { ...link.options, label: 'x', platform: 'ios' })).rejects.toBeInstanceOf(Error)
    expect(dev.trust.trustList().grants).toEqual([])
  })

  it('改写路由里的 clientId：握手失败，不会把公钥登记到别的 clientId 下', async () => {
    const dev = await device()
    const payload = parsePairingUri((await dev.trust.startPairing('https://aa.example.com', 'required')).uri)
    const other = clientIdFor(generateX25519().publicKey)
    const link = relay(dev, generateX25519(), 'c_r', { routeClientId: other })
    await expect(ClientSecureChannel.pair(payload, { ...link.options, label: 'x', platform: 'ios' })).rejects.toBeInstanceOf(ChannelClosedError)
    expect(link.ends).toEqual(['e2ee_handshake_failed'])
    expect(dev.trust.trustList().grants).toEqual([])
  })

  it('重放传输帧：设备关闭通道', async () => {
    const dev = await device()
    const { identity, payload } = await pairClient(dev)
    const seen: ChannelItem[] = []
    const link = relay(dev, identity, 'c_replay', { toDevice: (item) => (seen.push(item), item) })
    const channel = await ClientSecureChannel.connect(payload.deviceId, fromB64url(payload.deviceIdentityPub), link.options)
    await channel.request('GET', '/api/v2/one')
    await link.replay(seen.at(-1)!)
    await tick()
    expect(link.ends).toEqual(['e2ee_protocol_error'])
    expect(channel.closed?.code).toBe('e2ee_protocol_error')
  })
})

describe('E-4：撤销', () => {
  it('撤销后立即断开、无法重新握手，列表密钥轮换且只发给仍被授权的客户端', async () => {
    const dev = await device()
    const alice = await pairClient(dev, 'Alice')
    const bob = await pairClient(dev, 'Bob')
    const aliceKeys: Record<string, unknown>[] = []
    const bobKeys: Record<string, unknown>[] = []
    alice.channel.onChannelEvent((event) => aliceKeys.push(event))
    bob.channel.onChannelEvent((event) => bobKeys.push(event))
    const before = dev.trust.state.directoryKey

    // Alice revokes Bob through her channel (an authorised client may revoke).
    const response = await alice.channel.request('POST', '/e2ee/v1/trust/revoke', { clientId: bob.channel.clientId })
    expect(response.status).toBe(200)
    await tick()
    await tick()
    expect(bob.channel.closed?.code).toBe('e2ee_not_paired')
    // Said by the device inside the channel: a client may act on it (a Server-relayed end never is).
    expect(bob.channel.closed?.fromDevice).toBe(true)
    expect(dev.trust.state.directoryKey.epoch).toBe(before.epoch + 1)
    expect(aliceKeys.filter((event) => event['type'] === 'e2ee.directory_key')).toHaveLength(1)
    expect(bobKeys.filter((event) => event['type'] === 'e2ee.directory_key')).toHaveLength(0)

    const retry = relay(dev, bob.identity, 'c_bob_again')
    await expect(
      ClientSecureChannel.connect(bob.payload.deviceId, fromB64url(bob.payload.deviceIdentityPub), retry.options),
    ).rejects.toMatchObject({ code: 'e2ee_not_paired' })
  })
})

describe('E-3：降级保护（设备侧）', () => {
  it('Server 改成 off 不会让设备放松；只有本机确认才能降级', async () => {
    const dev = await device()
    expect(dev.trust.effectiveMode('off')).toBe('required')
    await dev.trust.declareServerMode('off')
    expect(dev.trust.state.policy.required).toBe(true)
    await expect(dev.trust.relaxPolicyLocally(false)).rejects.toMatchObject({ code: 'local_confirmation_required' })
    await dev.trust.relaxPolicyLocally(true)
    expect(dev.trust.effectiveMode('off')).toBe('off')
  })
})

describe('§7.2：已授权客户端批准新客户端', () => {
  it('本机确认后新客户端可以 KK 连接；未确认则拒绝', async () => {
    const dev = await device()
    const alice = await pairClient(dev, 'Alice')
    const newcomer = generateX25519()
    const body = { clientIdentityPub: Buffer.from(newcomer.publicKey).toString('base64url'), label: 'Browser', platform: 'web' }

    dev.approvals.push(false)
    expect((await alice.channel.request('POST', '/e2ee/v1/trust/approve', body)).status).toBe(403)

    dev.approvals.push(true)
    const approved = await alice.channel.request('POST', '/e2ee/v1/trust/approve', body)
    expect(approved).toMatchObject({ status: 200, body: { clientId: clientIdFor(newcomer.publicKey), grantedBy: 'approval' } })

    const link = relay(dev, newcomer, 'c_new')
    const channel = await ClientSecureChannel.connect('dev_home', fromB64url(alice.payload.deviceIdentityPub), link.options)
    expect((await channel.request('GET', '/e2ee/v1/trust')).body).toMatchObject({ grants: [{ label: 'Alice' }, { label: 'Browser' }] })
  })
})

describe('展示信封', () => {
  it('用当前列表密钥加密；轮换后旧信封仍能用保留的旧密钥打开', async () => {
    const dev = await device()
    const sealed = await dev.trust.sealDisplay('sess_1', 'device', { title: '修复登录页' })
    expect(sealed.payload).not.toContain('修复')
    await dev.trust.rotateDirectoryKey()
    expect(await dev.trust.openDisplay('sess_1', 'device', sealed)).toEqual({ title: '修复登录页' })
    await dev.trust.retireDirectoryKey(sealed.keyId)
    await expect(dev.trust.openDisplay('sess_1', 'device', sealed)).rejects.toThrow()
  })
})

describe('E-1：Server 转发的内容里没有任何明文（进程内金丝雀）', () => {
  it('消息、回复、事件、标题、附件、客户端名称里的金丝雀都不出现在经 Server 的字节里', async () => {
    const canary = `canary-${randomBytes(12).toString('hex')}`
    const needle = Buffer.from(canary, 'utf8')
    const seen: Buffer[] = []
    // Everything the Server (and the Router) could see: route + n + ct, with ct decoded as deeply as it decodes.
    const record = (item: ChannelItem) => {
      const raw = Buffer.from(item.ct, 'base64url')
      seen.push(Buffer.from(JSON.stringify(item)), raw)
      try {
        const envelope = JSON.parse(raw.toString('utf8')) as { message?: string }
        if (typeof envelope.message === 'string') seen.push(Buffer.from(envelope.message, 'base64url'))
      } catch {
        // transport frames are ciphertext, not JSON
      }
      return item
    }
    const dev = await device()
    const invitation = await dev.trust.startPairing('https://aa.example.com', 'required')
    const identity = generateX25519()
    const link = relay(dev, identity, 'c_canary', { toDevice: record, toClient: record })
    const { channel } = await ClientSecureChannel.pair(parsePairingUri(invitation.uri), {
      ...link.options,
      label: `phone ${canary}`,
      platform: 'android',
    })

    // A message, its echoed reply, a pushed event.
    await channel.request('POST', '/api/v2/sessions/s1/runtime/messages', { content: `please ${canary}`, clientMessageId: 'm1' })
    await channel.subscribe('s1', null, () => undefined)
    await tick()
    dev.api.emitters.get('s1')!({ type: 'timeline.item_created', item: { text: `agent says ${canary}` } })
    await tick()
    await tick()
    // A file read and a terminal write travel the same way.
    await channel.request('GET', `/api/v2/connectors/dev_home/fs/readText?path=/tmp/${canary}.txt`)
    await channel.request('POST', '/api/v2/connectors/dev_home/terminals-v2/t1/write', { data: `echo ${canary}\n` })

    // Stored next to the Server: a sealed title and a sealed attachment.
    const title = await dev.trust.sealDisplay('s1', 'device', { title: canary, latest: canary, cwd: `/home/${canary}` })
    const attachmentKey = new Uint8Array(randomBytes(32))
    const segments = sealSegments('attachment', 'file_1', attachmentKey, Buffer.from(`${canary}`.repeat(5000)))
    seen.push(Buffer.from(JSON.stringify(title)), ...segments.map((segment) => Buffer.from(segment)))

    expect(dev.api.requests.length).toBe(3)
    expect(seen.length).toBeGreaterThan(10)
    for (const bytes of seen) expect(bytes.includes(needle)).toBe(false)
  })
})

describe('E-7：通道开销（进程内，不含网络）', () => {
  it('2 KiB 请求往返与 1 MiB 快照的加密开销', async () => {
    const dev = await device()
    const { channel } = await pairClient(dev)
    const body = { content: 'x'.repeat(2048) }
    const timings: number[] = []
    for (let i = 0; i < 300; i++) {
      const started = performance.now()
      await channel.request('POST', '/api/v2/sessions/s1/runtime/messages', body)
      timings.push(performance.now() - started)
    }
    timings.sort((a, b) => a - b)
    const p50 = timings[Math.floor(timings.length * 0.5)]!
    const p95 = timings[Math.floor(timings.length * 0.95)]!
    const big = 'y'.repeat(1024 * 1024)
    const started = performance.now()
    await channel.request('POST', '/api/v2/sessions/s1/snapshot', { big })
    const snapshotMs = performance.now() - started
    console.info(`E-7 in-process: 2 KiB round trip p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms; 1 MiB echo ${snapshotMs.toFixed(1)} ms`)
    // Loose ceilings: they catch regressions (e.g. a per-frame key import), not machine speed.
    expect(p95).toBeLessThan(20)
    expect(snapshotMs).toBeLessThan(2000)
  })
})
