import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ChannelCaller, TunnelApi } from '../../src/application/inbound/tunnel-api.js'
import type { DeviceSecrets, TrustRepository } from '../../src/application/ports/trust.js'
import { DeviceTrustService } from '../../src/application/trust/device-trust-service.js'
import {
  ClientSecureChannel,
  SecureChannelHub,
  fromB64url,
  nodeContentSealer,
  parsePairingUri,
  type ChannelItem,
} from '../../src/channel/index.js'
import { generateX25519, nodeNoiseCrypto, x25519FromSecret, type X25519KeyPair } from '../../src/channel/noise/node-crypto.js'
import { clientIdFor, type DeviceTrustState } from '../../src/domain/trust/index.js'
import {
  compareP95,
  encryptedPath,
  formatReport,
  measureFirstScreen,
  measureStreaming,
  percentile,
  runE7,
  summarize,
  turnFinished,
  type ChannelFactory,
  type ContentPath,
} from '../../scripts/e2ee-latency.js'

// 自检 E-7 测量脚本：统计、判定，以及加密路径经真实安全通道（进程内设备）测首屏和流式延迟。

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

/** 设备侧的会话 API：快照固定返回；发消息后推 3 个事件，`emittedAt` 比当前早 5 ms，最后一个表示这一轮结束。 */
class StreamingApi implements TunnelApi {
  readonly emitters = new Map<string, (event: Record<string, unknown>) => void>()
  readonly requests: string[] = []
  async request(_caller: ChannelCaller, request: { method: string; path: string; body: unknown }) {
    this.requests.push(`${request.method} ${request.path}`)
    if (request.path.endsWith('/snapshot')) return { status: 200, body: { timeline: [{ id: 't1' }], eventCursor: 'seq:1' } }
    if (request.path.endsWith('/runtime/messages')) {
      const sessionId = request.path.split('/')[4]!
      setTimeout(() => {
        const emit = this.emitters.get(sessionId)
        const at = () => new Date(Date.now() - 5).toISOString()
        emit?.({ type: 'timeline.item_created', emittedAt: at(), payload: {} })
        emit?.({ type: 'timeline.item_updated', emittedAt: at(), payload: {} })
        emit?.({ type: 'runtime.state.updated', emittedAt: at(), payload: { state: { status: 'idle' } } })
      }, 1)
      return { status: 200, body: { ok: true } }
    }
    return { status: 404, body: null }
  }
  async subscribe(_caller: ChannelCaller, subscription: { sessionId: string }, emit: (event: Record<string, unknown>) => void) {
    this.emitters.set(subscription.sessionId, emit)
    emit({ type: 'session.subscribed', emittedAt: new Date(0).toISOString() })
    return () => this.emitters.delete(subscription.sessionId)
  }
}

async function device() {
  const secrets = new MemorySecrets()
  const trust = new DeviceTrustService({
    deviceId: 'dev_e7',
    repository: new MemoryRepository(),
    secrets,
    clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
    random: { bytes: (n) => new Uint8Array(randomBytes(n)), id: (prefix) => `${prefix}${randomBytes(6).toString('hex')}` },
    sealer: nodeContentSealer,
    confirmation: { confirmClientApproval: async () => false },
  })
  await trust.init()
  await trust.declareServerMode('required')
  const api = new StreamingApi()
  const hub = new SecureChannelHub({
    deviceId: 'dev_e7',
    deviceLabel: 'E-7',
    trust,
    identity: x25519FromSecret(secrets.identity.secretKey),
    crypto: nodeNoiseCrypto,
    api,
  })
  return { trust, hub, api, secrets }
}

type Device = Awaited<ReturnType<typeof device>>

/** 进程内的 Server：在客户端通道与设备 hub 之间转发 {n, ct}。 */
function link(dev: Device, identity: X25519KeyPair, ch: string) {
  let client: ClientSecureChannel | null = null
  let deviceChannel: ReturnType<SecureChannelHub['open']> | null = null
  const deviceWire = {
    send: (item: ChannelItem) => queueMicrotask(() => client?.receive(item)),
    end: (code?: string) => queueMicrotask(() => client?.ended(code ?? 'closed')),
  }
  return {
    crypto: nodeNoiseCrypto,
    identity,
    ch,
    wire: {
      send: async (item: ChannelItem) => {
        deviceChannel ??= dev.hub.open({ clientId: clientIdFor(identity.publicKey), ch }, deviceWire)
        await deviceChannel.receive(item)
      },
      end: () => void deviceChannel?.close('shutdown'),
    },
    bind: (c: ClientSecureChannel) => (client = c),
  }
}

async function pairedFactory(): Promise<{ factory: ChannelFactory; dev: Device; directoryKey: Uint8Array }> {
  const dev = await device()
  const invitation = await dev.trust.startPairing('https://aa.example.com', 'required')
  const payload = parsePairingUri(invitation.uri)
  const identity = generateX25519()
  const paired = await ClientSecureChannel.pair(payload, { ...link(dev, identity, 'e7pair'), label: 'E-7', platform: 'cli' })
  await paired.channel.close()
  const devicePub = fromB64url(payload.deviceIdentityPub)
  const factory: ChannelFactory = async (ch) => {
    const channel = await ClientSecureChannel.connect('dev_e7', devicePub, link(dev, identity, ch))
    return { channel, close: () => channel.close() }
  }
  return { factory, dev, directoryKey: fromB64url(paired.directoryKey.key) }
}

function fakePlain(delayMs: number): () => Promise<ContentPath> {
  return async () => ({
    snapshot: () => new Promise((resolve) => setTimeout(() => resolve({}), delayMs)),
    sendMessage: async () => {},
    subscribe: async (_sessionId, onEvent) => {
      const timer = setTimeout(() => {
        onEvent({ type: 'timeline.item_created', emittedAt: new Date(Date.now() - 4).toISOString() })
        onEvent({ type: 'runtime.state.updated', emittedAt: new Date(Date.now() - 4).toISOString(), payload: { state: { status: 'idle' } } })
      }, 2)
      return async () => clearTimeout(timer)
    },
    close: async () => {},
  })
}

describe('E-7 测量脚本：统计与判定', () => {
  it('百分位取最近秩，P95 增加不超过 20% 才通过', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 50)).toBe(50)
    expect(percentile(values, 95)).toBe(95)
    expect(summarize([3, 1, 2])).toEqual({ n: 3, p50: 2, p95: 3, max: 3 })
    expect(compareP95(summarize([10]), summarize([12])).pass).toBe(true)
    expect(compareP95(summarize([10]), summarize([12.5])).pass).toBe(false)
    expect(compareP95(summarize([]), summarize([1])).pass).toBe(false)
  })

  it('一轮结束：runtime.state.updated 且状态回到 idle', () => {
    expect(turnFinished({ type: 'runtime.state.updated', payload: { state: { status: 'idle' } } })).toBe(true)
    expect(turnFinished({ type: 'runtime.state.updated', payload: { state: { status: 'running' } } })).toBe(false)
    expect(turnFinished({ type: 'timeline.item_created' })).toBe(false)
  })
})

describe('E-7 测量脚本：加密路径经真实安全通道', () => {
  it('热首屏只算请求，冷首屏每次都做 KK 握手', async () => {
    const { factory, dev, directoryKey } = await pairedFactory()
    const open = encryptedPath(factory, { deviceId: 'dev_e7', directoryKey })
    const warm = await measureFirstScreen(open, 's1', 20, 'warm')
    const cold = await measureFirstScreen(open, 's1', 5, 'cold')
    expect(warm.n).toBe(20)
    expect(cold.n).toBe(5)
    // 预热 1 次 + 20 次热 + 5 次冷
    expect(dev.api.requests.filter((r) => r.endsWith('/snapshot'))).toHaveLength(26)
  })

  it('流式：发消息前先登记命令，延迟按 emittedAt 计，订阅前的积压不计', async () => {
    const { factory, directoryKey } = await pairedFactory()
    const registered: { commandId: string; digest: string }[] = []
    const open = encryptedPath(factory, {
      deviceId: 'dev_e7',
      directoryKey,
      register: async (commandId, digest) => void registered.push({ commandId, digest }),
    })
    const path = await open()
    try {
      const lags = await measureStreaming(path, 's1', { message: 'hi', timeoutMs: 2_000 })
      expect(lags).toHaveLength(3)
      for (const lag of lags) expect(lag).toBeGreaterThanOrEqual(4)
      expect(registered).toHaveLength(1)
      expect(registered[0]!.digest).toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/)
    } finally {
      await path.close()
    }
  })

  it('完整一次 runE7：报告含首屏、流式与结论', async () => {
    const { factory, directoryKey } = await pairedFactory()
    const report = await runE7(
      {
        iterations: 10,
        plain: { serverUrl: 'http://unused', accessToken: '', sessionId: 's1' },
        encrypted: { serverUrl: 'http://unused', accessToken: '', sessionId: 's1', identityFile: '/dev/null' },
        stream: { message: 'hi', rounds: 2, timeoutMs: 2_000 },
        limit: 1_000, // 进程内对比没有意义，这里只检查报告的形状
      },
      { plain: fakePlain(1), encrypted: encryptedPath(factory, { deviceId: 'dev_e7', directoryKey }) },
    )
    expect(report.firstScreen.plain.n).toBe(10)
    expect(report.firstScreen.encryptedWarm.n).toBe(10)
    expect(report.firstScreen.encryptedCold.n).toBe(5)
    expect(report.stream?.plain.n).toBe(4)
    expect(report.stream?.encrypted.n).toBe(6)
    expect(report.pass).toBe(true)
    const text = formatReport(report)
    expect(text).toContain('加密（冷，含握手）')
    expect(text).toContain('结论：通过')
  })
})

