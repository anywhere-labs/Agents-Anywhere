// Device-side secure channel: one instance per Secure/channel call. During the handshake it asks Device Trust for authorization;
// afterwards it hands decrypted requests to TunnelApi (the same use cases as normal mode) and handles trust management requests here.

import type { ChannelCaller, TunnelApi, TunnelSubscription } from '../application/inbound/tunnel-api.js'
import type { ChannelTrust } from '../application/inbound/channel-trust.js'
import { TrustError, clientIdFor, type ClientPlatform } from '../domain/trust/index.js'
import { HandshakeState, type NoiseCrypto, type NoiseKeyPair } from './noise/index.js'
import {
  CHANNEL_ID_PATTERN,
  NOISE_PAIRING_PROTOCOL,
  NOISE_RECONNECT_PROTOCOL,
  b64url,
  connectPrologue,
  fromB64url,
  pairingPrologue,
} from './formats.js'
import {
  ChannelProtocolError,
  TransportSession,
  decodeHandshake,
  encodeHandshake,
  type ChannelItem,
  type ChannelWire,
} from './transport.js'

const PLATFORMS: readonly ClientPlatform[] = ['web', 'desktop', 'android', 'ios', 'cli']
const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), 'utf8')

export interface DeviceChannelDeps {
  readonly deviceId: string
  readonly deviceLabel: string
  readonly trust: ChannelTrust
  readonly identity: NoiseKeyPair
  readonly crypto: NoiseCrypto
  readonly api: TunnelApi
  readonly now?: () => number
}

export interface SecureChannelOpen {
  readonly clientId: string
  readonly ch: string
}

type Phase =
  | { readonly kind: 'start' }
  | { readonly kind: 'handshake'; readonly hs: HandshakeState; readonly pairingId: string | null; readonly step: number }
  | { readonly kind: 'open'; readonly transport: TransportSession; readonly caller: ChannelCaller }
  | { readonly kind: 'closed' }

export class DeviceSecureChannel {
  readonly clientId: string
  readonly ch: string
  readonly #wire: ChannelWire
  readonly #deps: DeviceChannelDeps
  #phase: Phase = { kind: 'start' }
  #closing = false
  #queue: Promise<void> = Promise.resolve()
  readonly #subscriptions = new Map<string, () => void>()
  readonly #closeListeners = new Set<() => void>()

  constructor(open: SecureChannelOpen, wire: ChannelWire, deps: DeviceChannelDeps) {
    this.clientId = open.clientId
    this.ch = open.ch
    this.#wire = wire
    this.#deps = deps
    if (!CHANNEL_ID_PATTERN.test(open.ch)) this.#end('e2ee_protocol_error')
  }

  get isOpen(): boolean {
    return this.#phase.kind === 'open' && !this.#closing
  }

  get isClosed(): boolean {
    return this.#phase.kind === 'closed'
  }

  onClose(listener: () => void): void {
    this.#closeListeners.add(listener)
  }

  /** Feed one item from the wire. Items are processed strictly in order. */
  receive(item: ChannelItem): Promise<void> {
    const run = this.#queue.then(() => this.#handle(item))
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** Push a channel-level event (`e2ee.directory_key`, `e2ee.trust_changed`). */
  async pushEvent(event: Record<string, unknown>): Promise<void> {
    if (this.#phase.kind !== 'open' || this.#closing) return
    await this.#phase.transport.sendMessage({ kind: 'event', sub: null, event })
  }

  /** Close with an in-channel `close` message (when the channel is open) and end the call. */
  async close(reason: 'revoked' | 'not_paired' | 'policy' | 'shutdown' | 'protocol_error' | 'too_large', code?: string): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    if (this.#phase.kind === 'open') {
      await this.#phase.transport.sendMessage({ kind: 'close', reason, message: code ?? '' }).catch(() => undefined)
    }
    this.#end(code ?? (reason === 'revoked' || reason === 'not_paired' ? 'e2ee_not_paired' : reason))
  }

  async #handle(item: ChannelItem): Promise<void> {
    try {
      switch (this.#phase.kind) {
        case 'closed':
          return
        case 'start':
          return await this.#start(item)
        case 'handshake':
          return await this.#continueHandshake(item)
        case 'open':
          for (const message of await this.#phase.transport.receive(item)) await this.#dispatch(message as Record<string, unknown>)
      }
    } catch (error) {
      if (error instanceof TrustError) {
        const code = error.code === 'pairing_expired' ? 'pairing_expired' : 'e2ee_not_paired'
        await this.close('not_paired', code)
      } else if (error instanceof ChannelProtocolError) {
        await this.close(error.code === 'too_large' ? 'too_large' : 'protocol_error', error.code)
      } else {
        // A failed MAC during the handshake (wrong psk, rewritten route, unknown key) lands here.
        await this.close('protocol_error', 'e2ee_handshake_failed')
      }
    }
  }

  async #start(item: ChannelItem): Promise<void> {
    const envelope = decodeHandshake(item, 0)
    const { trust, deviceId, identity, crypto } = this.#deps
    let hs: HandshakeState
    if (envelope.pattern === 'XXpsk0') {
      if (!envelope.pairingId) throw new ChannelProtocolError('XXpsk0 without pairingId')
      hs = await HandshakeState.create({
        crypto,
        protocolName: NOISE_PAIRING_PROTOCOL,
        initiator: false,
        prologue: pairingPrologue(deviceId, envelope.pairingId, this.clientId, this.ch),
        s: identity,
        psks: [trust.pairingPsk(envelope.pairingId)],
      })
    } else {
      hs = await HandshakeState.create({
        crypto,
        protocolName: NOISE_RECONNECT_PROTOCOL,
        initiator: false,
        prologue: connectPrologue(deviceId, this.clientId, this.ch),
        s: identity,
        rs: trust.pinnedKey(this.clientId),
      })
    }
    await hs.readMessage(fromB64url(envelope.message))
    const reply = envelope.pattern === 'XXpsk0' ? json({ deviceId, label: this.#deps.deviceLabel }) : new Uint8Array(0)
    const message = await hs.writeMessage(reply)
    await this.#wire.send(encodeHandshake({ pattern: envelope.pattern, pairingId: envelope.pairingId ?? null, step: 1, message: b64url(message) }))
    if (envelope.pattern === 'KK') return this.#openAfterKK(hs)
    this.#phase = { kind: 'handshake', hs, pairingId: envelope.pairingId ?? null, step: 2 }
  }

  async #continueHandshake(item: ChannelItem): Promise<void> {
    if (this.#phase.kind !== 'handshake') return
    const { hs, pairingId } = this.#phase
    const envelope = decodeHandshake(item, 2)
    if (envelope.pattern !== 'XXpsk0' || envelope.pairingId !== pairingId) throw new ChannelProtocolError('handshake changed midway')
    const hello = JSON.parse(Buffer.from(await hs.readMessage(fromB64url(envelope.message))).toString('utf8')) as Record<string, unknown>
    const pair = hs.takeTransport()
    const rs = pair.remoteStatic!
    // The route's clientId must be the one this key derives: a relay cannot file a key under another client.
    if (clientIdFor(rs) !== this.clientId) throw new TrustError('client_id_mismatch', 'client id does not match the key')
    const label = typeof hello['label'] === 'string' ? hello['label'] : ''
    const platform = PLATFORMS.includes(hello['platform'] as ClientPlatform) ? (hello['platform'] as ClientPlatform) : null
    const transport = new TransportSession(pair, this.#wire, this.#deps.now)
    // From here on errors can be reported inside the channel.
    this.#phase = { kind: 'open', transport, caller: { clientId: this.clientId, label, platform } }
    const { grant, directoryKey } = await this.#deps.trust.completePairing(pairingId!, {
      clientId: this.clientId,
      identityPub: b64url(rs),
      label,
      platform,
    })
    await transport.sendMessage({
      kind: 'pair.committed',
      deviceId: this.#deps.deviceId,
      clientId: this.clientId,
      grantedAt: grant.grantedAt,
      directoryKey,
    })
    await this.#sendReady(transport)
  }

  async #openAfterKK(hs: HandshakeState): Promise<void> {
    const pair = hs.takeTransport()
    const grant = this.#deps.trust.authorize(this.clientId, pair.remoteStatic!)
    const transport = new TransportSession(pair, this.#wire, this.#deps.now)
    this.#phase = { kind: 'open', transport, caller: { clientId: grant.clientId, label: grant.label, platform: grant.platform } }
    await this.#sendReady(transport)
  }

  async #sendReady(transport: TransportSession): Promise<void> {
    const { keyId, epoch } = this.#deps.trust.state.directoryKey
    await transport.sendMessage({
      kind: 'ready',
      deviceId: this.#deps.deviceId,
      clientId: this.clientId,
      directoryKeyId: keyId,
      directoryKeyEpoch: epoch,
    })
  }

  async #dispatch(message: Record<string, unknown>): Promise<void> {
    if (this.#phase.kind !== 'open') return
    const { transport, caller } = this.#phase
    // Every message re-checks the grant: a revocation that raced the close must not slip a request through.
    this.#deps.trust.authorize(this.clientId)
    switch (message['kind']) {
      case 'request': {
        const id = String(message['id'] ?? '')
        const method = message['method'] as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
        const path = String(message['path'] ?? '')
        if (!id || !path) throw new ChannelProtocolError('malformed request')
        const response = path.startsWith('/e2ee/v1/')
          ? await this.#trustRequest(method, path, message['body'])
          : await this.#deps.api.request(caller, { method, path, body: message['body'] ?? null })
        await transport.sendMessage({ kind: 'response', id, status: response.status, body: response.body })
        return
      }
      case 'subscribe': {
        const id = String(message['id'] ?? '')
        const stream: 'session' | 'terminal' = message['stream'] === 'terminal' ? 'terminal' : 'session'
        const sessionId = stream === 'session' ? String(message['sessionId'] ?? '') : ''
        const terminalId = stream === 'terminal' ? String(message['terminalId'] ?? '') : ''
        if (!id || (stream === 'session' ? !sessionId : !terminalId) || this.#subscriptions.has(id)) throw new ChannelProtocolError('malformed subscribe')
        const afterCursor = typeof message['afterCursor'] === 'string' ? message['afterCursor'] : null
        const fromSeq = typeof message['fromSeq'] === 'number' && Number.isSafeInteger(message['fromSeq']) ? message['fromSeq'] : 0
        const target: TunnelSubscription = stream === 'session' ? { stream, sessionId, afterCursor } : { stream, sessionId, afterCursor, terminalId, fromSeq }
        const stop = await this.#deps.api.subscribe(caller, target, (event) => {
          void transport.sendMessage({ kind: 'event', sub: id, event }).catch(() => undefined)
        })
        this.#subscriptions.set(id, stop)
        return
      }
      case 'unsubscribe': {
        const id = String(message['id'] ?? '')
        this.#subscriptions.get(id)?.()
        this.#subscriptions.delete(id)
        return
      }
      case 'close':
        this.#end()
        return
      default:
        throw new ChannelProtocolError(`unexpected channel message ${String(message['kind'])}`)
    }
  }

  async #trustRequest(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const trust = this.#deps.trust
    const route = `${method} ${path}`
    try {
      switch (route) {
        case 'GET /e2ee/v1/trust':
          return { status: 200, body: trust.trustList() }
        case 'GET /e2ee/v1/directory-key':
          return { status: 200, body: await trust.directoryKeyGrant() }
        case 'POST /e2ee/v1/trust/revoke': {
          const clientId = String((body as Record<string, unknown> | null)?.['clientId'] ?? '')
          await trust.revokeClient(clientId)
          return { status: 200, body: trust.trustList() }
        }
        case 'POST /e2ee/v1/trust/approve': {
          const request = body as Record<string, unknown> | null
          const pub = fromB64url(String(request?.['clientIdentityPub'] ?? ''))
          if (pub.length !== 32) return { status: 400, body: { code: 'invalid_argument', message: 'clientIdentityPub' } }
          const platform = PLATFORMS.includes(request?.['platform'] as ClientPlatform) ? (request?.['platform'] as ClientPlatform) : null
          const grant = await trust.approveClient(this.clientId, {
            clientId: clientIdFor(pub),
            identityPub: b64url(pub),
            label: String(request?.['label'] ?? ''),
            platform,
          })
          const view = trust.trustList().grants.find((candidate) => candidate.clientId === grant.clientId)
          return { status: 200, body: view }
        }
        default:
          return { status: 404, body: { code: 'not_found', message: route } }
      }
    } catch (error) {
      if (error instanceof TrustError) {
        const status = error.code === 'local_confirmation_required' || error.code === 'approver_not_authorized' ? 403 : 409
        return { status, body: { code: error.code, message: error.message } }
      }
      throw error
    }
  }

  #end(code?: string): void {
    if (this.#phase.kind === 'closed') return
    if (this.#phase.kind === 'open') this.#phase.transport.destroy()
    this.#phase = { kind: 'closed' }
    for (const stop of this.#subscriptions.values()) stop()
    this.#subscriptions.clear()
    this.#wire.end(code)
    for (const listener of this.#closeListeners) listener()
  }
}
