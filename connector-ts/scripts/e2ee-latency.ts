// E-7（docs/v3/11-e2ee-noise.md §13）：加密模式的首屏与流式延迟，与普通模式比较，P95 增加不超过 20%。
//
// 对一套真实部署测量（等 Server 隧道与设备链路合起来后直接运行）：
//   AA_E7_CONFIG=e7.json corepack yarn vitest run test/e2ee/e7-live.test.ts
// 配置见 `E7Config`。加密一侧先用设备上生成的 aa-pair:// 链接配对一次，身份写进 `identityFile`（含私钥，
// 放在仓库外、权限 0600），之后每次用 KK 重连。
//
// 测什么：
// - 首屏：普通模式 `GET /api/v2/sessions/{id}/snapshot`；加密模式同一请求经安全通道。
//   「热」：通道已建立，只算请求；「冷」：每次都取票据、开隧道 WebSocket、KK 握手再请求。
//   判定用热路径（与普通模式的长连接 HTTP 对等），冷路径单独报告。
// - 流式：订阅会话事件，发一条消息，每个事件的延迟 = 客户端收到的时刻 − 事件的 `emittedAt`。
//   `emittedAt` 是设备的时钟：在设备所在的机器上运行，或确认两边已对时。
//
// 普通模式与加密模式可以是同一台 Server 上的两台设备，也可以是两套部署（各自的 serverUrl/accessToken）。

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  ClientSecureChannel,
  b64url,
  fromB64url,
  inputDigest,
  parsePairingUri,
  type ChannelItem,
  type ChannelWire,
} from '../src/channel/index.js'
import { generateX25519, nodeNoiseCrypto, x25519FromSecret } from '../src/channel/noise/node-crypto.js'
import { clientIdFor } from '../src/domain/trust/index.js'

// ---------------------------------------------------------------------------
// 统计与判定
// ---------------------------------------------------------------------------

export interface Summary {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]!
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? Number.NaN }
}

export interface Comparison {
  readonly plainP95: number
  readonly encryptedP95: number
  /** encrypted / plain − 1 */
  readonly increase: number
  readonly pass: boolean
}

export function compareP95(plain: Summary, encrypted: Summary, limit = 0.2): Comparison {
  const increase = encrypted.p95 / plain.p95 - 1
  return { plainP95: plain.p95, encryptedP95: encrypted.p95, increase, pass: Number.isFinite(increase) && increase <= limit }
}

// ---------------------------------------------------------------------------
// 一条内容路径（普通或加密）
// ---------------------------------------------------------------------------

export type SessionEvent = Record<string, unknown>

/** 打开一次会话所需的操作；普通模式与加密模式各实现一份。 */
export interface ContentPath {
  snapshot(sessionId: string): Promise<unknown>
  sendMessage(sessionId: string, content: string): Promise<void>
  subscribe(sessionId: string, onEvent: (event: SessionEvent) => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

export async function measureFirstScreen(
  open: () => Promise<ContentPath>,
  sessionId: string,
  iterations: number,
  mode: 'warm' | 'cold',
  clock: () => number = () => performance.now(),
): Promise<Summary> {
  const timings: number[] = []
  if (mode === 'warm') {
    const path = await open()
    try {
      await path.snapshot(sessionId) // 预热
      for (let i = 0; i < iterations; i++) {
        const started = clock()
        await path.snapshot(sessionId)
        timings.push(clock() - started)
      }
    } finally {
      await path.close()
    }
    return summarize(timings)
  }
  for (let i = 0; i < iterations; i++) {
    const started = clock()
    const path = await open()
    try {
      await path.snapshot(sessionId)
      timings.push(clock() - started)
    } finally {
      await path.close()
    }
  }
  return summarize(timings)
}

export interface StreamOptions {
  readonly message: string
  readonly timeoutMs: number
  /** 事件里的设备时间字段（ISO 字符串或毫秒），默认 `emittedAt`。 */
  readonly timeField?: string
  /** 收到这个事件就结束本轮（默认：`runtime.state.updated` 且 payload 里的状态回到 idle）。 */
  readonly done?: (event: SessionEvent) => boolean
  readonly now?: () => number
}

function eventTime(event: SessionEvent, field: string): number | null {
  const value = event[field]
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export function turnFinished(event: SessionEvent): boolean {
  if (event['type'] !== 'runtime.state.updated') return false
  const payload = event['payload'] as Record<string, unknown> | undefined
  const state = (payload?.['state'] ?? payload?.['runtimeState'] ?? payload) as Record<string, unknown> | undefined
  const status = state?.['status'] ?? state?.['phase']
  return status === 'idle' || status === 'completed'
}

/** 一轮：订阅、发消息、收事件直到结束或超时；返回每个事件的延迟（毫秒）。 */
export async function measureStreaming(path: ContentPath, sessionId: string, options: StreamOptions): Promise<number[]> {
  const field = options.timeField ?? 'emittedAt'
  const now = options.now ?? Date.now
  const done = options.done ?? turnFinished
  const lags: number[] = []
  let sent = false
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const unsubscribe = await path.subscribe(sessionId, (event) => {
    if (!sent) return // 订阅前的积压（session.subscribed、补发）不计
    const at = eventTime(event, field)
    if (at !== null) lags.push(now() - at)
    if (done(event)) finish()
  })
  try {
    sent = true
    await path.sendMessage(sessionId, options.message)
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, options.timeoutMs))])
  } finally {
    await unsubscribe()
  }
  return lags
}

// ---------------------------------------------------------------------------
// 普通模式：HTTP + 会话 WebSocket
// ---------------------------------------------------------------------------

export interface Endpoint {
  readonly serverUrl: string
  readonly accessToken: string
}

async function api(endpoint: Endpoint, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, endpoint.serverUrl), {
    method,
    headers: {
      authorization: `Bearer ${endpoint.accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

function wsUrl(endpoint: Endpoint, path: string): string {
  const url = new URL(path, endpoint.serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => reject(new Error(`WebSocket ${url.split('?')[0]} failed`)), { once: true })
  })
}

export function plainPath(endpoint: Endpoint, clientId = `e7_${randomBytes(4).toString('hex')}`): ContentPath {
  return {
    snapshot: (sessionId) => api(endpoint, 'GET', `/api/v2/sessions/${sessionId}/snapshot`),
    async sendMessage(sessionId, content) {
      await api(endpoint, 'POST', `/api/v2/sessions/${sessionId}/runtime/messages`, {
        content,
        clientMessageId: `e7_${randomBytes(6).toString('hex')}`,
      })
    },
    async subscribe(sessionId, onEvent) {
      const { ticket } = (await api(endpoint, 'POST', '/api/v2/ws-ticket', { clientId, scope: { sessionId } })) as {
        ticket: string
      }
      const socket = await openSocket(wsUrl(endpoint, `/api/v2/sessions/${sessionId}/ws?ticket=${encodeURIComponent(ticket)}`))
      socket.addEventListener('message', (message) => onEvent(JSON.parse(String(message.data)) as SessionEvent))
      return async () => socket.close()
    },
    close: async () => {},
  }
}

// ---------------------------------------------------------------------------
// 加密模式：隧道 WebSocket + 安全通道
// ---------------------------------------------------------------------------

/** 配对后保存的客户端身份（含私钥；放在仓库外）。 */
export interface StoredIdentity {
  readonly deviceId: string
  readonly devicePub: string
  readonly clientSecret: string
  readonly clientPub: string
  readonly directoryKey: string
}

export interface EncryptedEndpoint extends Endpoint {
  readonly deviceId: string
  readonly identity: StoredIdentity
  /** `POST /api/v2/ws-ticket` 的 scope；隧道票据的范围还在和 C 确认，默认沿用 C 当前接受的 dashboard。 */
  readonly ticketScope?: Record<string, unknown>
}

/** 把隧道 WebSocket 接到一个通道上：发出 `ClientTunnelFrame`，收到的帧交给通道。 */
async function tunnelWire(
  endpoint: EncryptedEndpoint,
  clientId: string,
  ch: string,
): Promise<{ wire: ChannelWire; bind: (channel: ClientSecureChannel) => void; socket: WebSocket }> {
  const { ticket } = (await api(endpoint, 'POST', '/api/v2/ws-ticket', {
    clientId,
    scope: endpoint.ticketScope ?? { dashboard: true },
  })) as { ticket: string }
  const socket = await openSocket(wsUrl(endpoint, `/api/v3/tunnel?ticket=${encodeURIComponent(ticket)}`))
  const route = { deviceId: endpoint.deviceId, clientId, ch }
  let channel: ClientSecureChannel | null = null
  const early: ChannelItem[] = []
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data)) as { t: string; route?: { ch?: string }; n?: number; ct?: string; code?: string }
    if (frame.route?.ch !== ch) return
    if (frame.t === 'tun') {
      const item = { n: frame.n!, ct: frame.ct! }
      if (channel) channel.receive(item)
      else early.push(item)
    } else if (frame.t === 'end') {
      channel?.ended(frame.code ?? 'closed')
    }
  })
  socket.addEventListener('close', () => channel?.ended('closed'))
  return {
    socket,
    wire: {
      send: (item) => socket.send(JSON.stringify({ t: 'tun', route, n: item.n, ct: item.ct })),
      end: () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'end', route }))
      },
    },
    bind: (bound) => {
      channel = bound
      for (const item of early.splice(0)) bound.receive(item)
    },
  }
}

export interface ChannelFactory {
  (ch: string): Promise<{ channel: ClientSecureChannel; close(): Promise<void> }>
}

/** 经隧道重连（KK）到已配对设备。 */
export function tunnelChannels(endpoint: EncryptedEndpoint): ChannelFactory {
  const identity = x25519FromSecret(fromB64url(endpoint.identity.clientSecret))
  const clientId = clientIdFor(identity.publicKey)
  return async (ch) => {
    const tunnel = await tunnelWire(endpoint, clientId, ch)
    const channel = await ClientSecureChannel.connect(endpoint.deviceId, fromB64url(endpoint.identity.devicePub), {
      crypto: nodeNoiseCrypto,
      identity,
      ch,
      wire: tunnel.wire,
      bind: tunnel.bind,
    })
    return {
      channel,
      async close() {
        await channel.close().catch(() => {})
        tunnel.socket.close()
      },
    }
  }
}

export function encryptedPath(
  factory: ChannelFactory,
  options: { readonly deviceId: string; readonly directoryKey: Uint8Array; readonly register?: (commandId: string, digest: string) => Promise<void> },
): () => Promise<ContentPath> {
  return async () => {
    const opened = await factory(`e7${randomBytes(6).toString('hex')}`)
    const { channel } = opened
    const subscriptions: string[] = []
    return {
      async snapshot(sessionId) {
        const response = await channel.request('GET', `/api/v2/sessions/${sessionId}/snapshot`)
        if (response.status >= 400) throw new Error(`snapshot through the channel: ${response.status}`)
        return response.body
      },
      async sendMessage(sessionId, content) {
        const clientMessageId = `e7_${randomBytes(6).toString('hex')}`
        const body = { content, clientMessageId }
        await options.register?.(clientMessageId, inputDigest(options.directoryKey, new TextEncoder().encode(JSON.stringify(body))))
        const response = await channel.request('POST', `/api/v2/sessions/${sessionId}/runtime/messages`, body)
        if (response.status >= 400) throw new Error(`send through the channel: ${response.status}`)
      },
      async subscribe(sessionId, onEvent) {
        const id = await channel.subscribe(sessionId, null, onEvent)
        subscriptions.push(id)
        return () => channel.unsubscribe(id)
      },
      close: () => opened.close(),
    }
  }
}

// ---------------------------------------------------------------------------
// 配对（一次）
// ---------------------------------------------------------------------------

export async function pairOnce(endpoint: Endpoint & { readonly pairingUri: string }, identityFile: string): Promise<StoredIdentity> {
  const payload = parsePairingUri(endpoint.pairingUri)
  const identity = generateX25519()
  const ch = `e7p${randomBytes(6).toString('hex')}`
  const target: EncryptedEndpoint = {
    ...endpoint,
    deviceId: payload.deviceId,
    identity: { deviceId: payload.deviceId, devicePub: payload.deviceIdentityPub, clientSecret: '', clientPub: '', directoryKey: '' },
  }
  const tunnel = await tunnelWire(target, clientIdFor(identity.publicKey), ch)
  const paired = await ClientSecureChannel.pair(payload, {
    crypto: nodeNoiseCrypto,
    identity,
    ch,
    wire: tunnel.wire,
    bind: tunnel.bind,
    label: 'E-7 bench',
    platform: 'cli',
  })
  await paired.channel.close().catch(() => {})
  tunnel.socket.close()
  const stored: StoredIdentity = {
    deviceId: payload.deviceId,
    devicePub: payload.deviceIdentityPub,
    clientSecret: b64url(identity.secretKey),
    clientPub: b64url(identity.publicKey),
    directoryKey: paired.directoryKey.key,
  }
  await mkdir(dirname(identityFile), { recursive: true })
  await writeFile(identityFile, JSON.stringify(stored, null, 2), { mode: 0o600 })
  return stored
}

// ---------------------------------------------------------------------------
// 一次完整测量
// ---------------------------------------------------------------------------

export interface E7Config {
  readonly iterations?: number
  readonly plain: Endpoint & { readonly sessionId: string }
  readonly encrypted: Endpoint & {
    readonly sessionId: string
    readonly identityFile: string
    /** 第一次运行时用；之后读 identityFile。 */
    readonly pairingUri?: string
    readonly ticketScope?: Record<string, unknown>
  }
  /** 省略时不测流式。 */
  readonly stream?: { readonly message: string; readonly rounds?: number; readonly timeoutMs?: number; readonly timeField?: string }
  /** P95 允许增加的比例，默认 0.2。 */
  readonly limit?: number
}

export interface E7Report {
  readonly at: string
  readonly firstScreen: { plain: Summary; encryptedWarm: Summary; encryptedCold: Summary; verdict: Comparison }
  readonly stream?: { plain: Summary; encrypted: Summary; verdict: Comparison }
  readonly pass: boolean
}

export async function loadIdentity(config: E7Config['encrypted']): Promise<StoredIdentity> {
  try {
    return JSON.parse(await readFile(config.identityFile, 'utf8')) as StoredIdentity
  } catch (error) {
    if (!config.pairingUri) throw new Error(`no identity at ${config.identityFile} and no pairingUri to pair with`, { cause: error })
    return pairOnce({ ...config, pairingUri: config.pairingUri }, config.identityFile)
  }
}

export async function runE7(
  config: E7Config,
  paths: { readonly plain: () => Promise<ContentPath>; readonly encrypted: () => Promise<ContentPath> },
): Promise<E7Report> {
  const iterations = config.iterations ?? 50
  const limit = config.limit ?? 0.2
  const plain = await measureFirstScreen(paths.plain, config.plain.sessionId, iterations, 'warm')
  const encryptedWarm = await measureFirstScreen(paths.encrypted, config.encrypted.sessionId, iterations, 'warm')
  const encryptedCold = await measureFirstScreen(paths.encrypted, config.encrypted.sessionId, Math.max(5, Math.floor(iterations / 5)), 'cold')
  const firstScreen = { plain, encryptedWarm, encryptedCold, verdict: compareP95(plain, encryptedWarm, limit) }
  let stream: E7Report['stream']
  if (config.stream) {
    const lags = { plain: [] as number[], encrypted: [] as number[] }
    const options: StreamOptions = {
      message: config.stream.message,
      timeoutMs: config.stream.timeoutMs ?? 120_000,
      ...(config.stream.timeField ? { timeField: config.stream.timeField } : {}),
    }
    for (let round = 0; round < (config.stream.rounds ?? 3); round++) {
      for (const [mode, open, sessionId] of [
        ['plain', paths.plain, config.plain.sessionId],
        ['encrypted', paths.encrypted, config.encrypted.sessionId],
      ] as const) {
        const path = await open()
        try {
          lags[mode].push(...(await measureStreaming(path, sessionId, options)))
        } finally {
          await path.close()
        }
      }
    }
    const plainStream = summarize(lags.plain)
    const encryptedStream = summarize(lags.encrypted)
    stream = { plain: plainStream, encrypted: encryptedStream, verdict: compareP95(plainStream, encryptedStream, limit) }
  }
  return {
    at: new Date().toISOString(),
    firstScreen,
    ...(stream ? { stream } : {}),
    pass: firstScreen.verdict.pass && (stream?.verdict.pass ?? true),
  }
}

export function formatReport(report: E7Report): string {
  const row = (name: string, s: Summary) => `${name.padEnd(22)} n=${String(s.n).padStart(4)}  p50 ${s.p50.toFixed(1).padStart(8)} ms  p95 ${s.p95.toFixed(1).padStart(8)} ms  max ${s.max.toFixed(1).padStart(8)} ms`
  const verdict = (v: Comparison) => `P95 ${v.increase >= 0 ? '+' : ''}${(v.increase * 100).toFixed(1)}% → ${v.pass ? '通过' : '不通过'}`
  const lines = [
    `E-7 ${report.at}`,
    '首屏',
    row('  普通', report.firstScreen.plain),
    row('  加密（热）', report.firstScreen.encryptedWarm),
    row('  加密（冷，含握手）', report.firstScreen.encryptedCold),
    `  ${verdict(report.firstScreen.verdict)}`,
  ]
  if (report.stream) {
    lines.push('流式（事件 emittedAt → 客户端收到）', row('  普通', report.stream.plain), row('  加密', report.stream.encrypted), `  ${verdict(report.stream.verdict)}`)
  }
  lines.push(report.pass ? '结论：通过' : '结论：不通过')
  return lines.join('\n')
}
