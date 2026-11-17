// Client side of the encrypted-mode end-to-end test (server/tests/test_v3_e2e_e2ee.py): the TS client channel
// (`ClientSecureChannel`) over the Server's `WS /api/v3/tunnel`, driven by the test as JSON lines on stdin/stdout.
//
//   node --experimental-transform-types --import ./test/support/ts-resolve.mjs test/support/e2ee-client.ts <serverUrl> <accessToken>
//
// Requests (one JSON object per line, answered by `{id, ok, result}` or `{id, ok: false, error, code}`):
//   {id, op: "pair", uri, label}             XXpsk0 with an aa-pair:// URI; keeps the identity for "connect"
//   {id, op: "connect", ch?, devicePub?}     KK with the kept identity (devicePub overrides the pinned key)
//   {id, op: "request", method, path, body}  TunnelRequest; result {status, body}
//   {id, op: "subscribe", sessionId, afterCursor?} / {id, op: "subscribeTerminal", terminalId, fromSeq?}
//   {id, op: "unsubscribe", sub}
//   {id, op: "close"}                        closes the channel and the tunnel WebSocket
// Events of a subscription are written as `{event: {...}, sub}`; a channel that ends as `{closed: code}`.
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'

import { ChannelClosedError, ClientSecureChannel, b64url, fromB64url, parsePairingUri, type ChannelItem } from '../../src/channel/index.js'
import { generateX25519, nodeNoiseCrypto, type X25519KeyPair } from '../../src/channel/noise/node-crypto.js'
import { clientIdFor } from '../../src/domain/trust/index.js'

const [serverUrl, accessToken] = process.argv.slice(2)
if (serverUrl === undefined || accessToken === undefined) {
  process.stderr.write('usage: e2ee-client.ts <serverUrl> <accessToken>\n')
  process.exit(64)
}

const write = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

let identity: X25519KeyPair | null = null
let deviceId = ''
let devicePub = ''
let channel: ClientSecureChannel | null = null
let socket: WebSocket | null = null

async function ticket(clientId: string): Promise<string> {
  const response = await fetch(new URL('/api/v2/ws-ticket', serverUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, scope: { dashboard: true } }),
  })
  if (!response.ok) throw new Error(`ws-ticket: HTTP ${response.status}`)
  return ((await response.json()) as { ticket: string }).ticket
}

/** Opens the tunnel WebSocket for one channel id and connects it to the channel the handshake creates. */
async function tunnel(clientId: string, ch: string) {
  const url = new URL(`/api/v3/tunnel?ticket=${encodeURIComponent(await ticket(clientId))}`, serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const opened = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    opened.addEventListener('open', () => resolve(), { once: true })
    opened.addEventListener('error', () => reject(new Error('tunnel WebSocket failed')), { once: true })
  })
  socket?.close()
  socket = opened
  const route = { deviceId, clientId, ch }
  let bound: ClientSecureChannel | null = null
  const early: ChannelItem[] = []
  opened.addEventListener('message', message => {
    const frame = JSON.parse(String(message.data)) as { t: string; route?: { ch?: string }; n?: number; ct?: string; code?: string }
    if (frame.route?.ch !== ch) return
    if (frame.t === 'tun') {
      const item = { n: frame.n!, ct: frame.ct! }
      if (bound) bound.receive(item)
      else early.push(item)
    } else if (frame.t === 'end') {
      bound?.ended(frame.code ?? 'closed')
    }
  })
  opened.addEventListener('close', () => bound?.ended('closed'))
  return {
    wire: {
      send: (item: ChannelItem) => opened.send(JSON.stringify({ t: 'tun', route, n: item.n, ct: item.ct })),
      end: () => {
        if (opened.readyState === WebSocket.OPEN) opened.send(JSON.stringify({ t: 'end', route }))
      },
    },
    bind: (created: ClientSecureChannel) => {
      bound = created
      created.onClose(error => write({ closed: error.code, ch }))
      for (const item of early.splice(0)) created.receive(item)
    },
  }
}

const requireChannel = (): ClientSecureChannel => {
  if (channel === null) throw new Error('no channel: pair or connect first')
  return channel
}

async function handle(request: Record<string, unknown>): Promise<unknown> {
  switch (request.op) {
    case 'pair': {
      const payload = parsePairingUri(String(request.uri))
      identity = generateX25519()
      deviceId = payload.deviceId
      devicePub = payload.deviceIdentityPub
      const ch = `pair${randomBytes(6).toString('hex')}`
      const wire = await tunnel(clientIdFor(identity.publicKey), ch)
      const paired = await ClientSecureChannel.pair(payload, { crypto: nodeNoiseCrypto, identity, ch, ...wire, label: String(request.label ?? 'e2e client'), platform: 'cli' })
      channel = paired.channel
      return { deviceId, clientId: channel.clientId, ready: channel.ready, directoryKey: paired.directoryKey }
    }
    case 'connect': {
      if (identity === null) throw new Error('pair first')
      await channel?.close().catch(() => undefined)
      const ch = typeof request.ch === 'string' ? request.ch : `kk${randomBytes(6).toString('hex')}`
      const wire = await tunnel(clientIdFor(identity.publicKey), ch)
      const pinned = typeof request.devicePub === 'string' ? request.devicePub : devicePub
      channel = await ClientSecureChannel.connect(deviceId, fromB64url(pinned), { crypto: nodeNoiseCrypto, identity, ch, ...wire })
      return { clientId: channel.clientId, ready: channel.ready, ch }
    }
    case 'request':
      return requireChannel().request(request.method as 'GET', String(request.path), request.body ?? null)
    case 'subscribe': {
      const sub = await requireChannel().subscribe(String(request.sessionId), typeof request.afterCursor === 'string' ? request.afterCursor : null, event => write({ event, sub }))
      return { sub }
    }
    case 'subscribeTerminal': {
      const sub = await requireChannel().subscribeTerminal(String(request.terminalId), Number(request.fromSeq ?? 0), event => write({ event, sub }))
      return { sub }
    }
    case 'unsubscribe':
      await requireChannel().unsubscribe(String(request.sub))
      return {}
    case 'close':
      await channel?.close().catch(() => undefined)
      channel = null
      socket?.close()
      socket = null
      return {}
    case 'identity':
      return identity === null ? null : { clientPub: b64url(identity.publicKey), clientId: clientIdFor(identity.publicKey) }
    default:
      throw new Error(`unknown op ${String(request.op)}`)
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line) as Record<string, unknown>
  handle(request).then(
    result => write({ id: request.id, ok: true, result }),
    (error: Error) => write({ id: request.id, ok: false, error: error.message, code: error instanceof ChannelClosedError ? error.code : null }),
  )
}).on('close', () => {
  void channel?.close().catch(() => undefined)
  socket?.close()
  process.exit(0)
})
write({ ready: true })
