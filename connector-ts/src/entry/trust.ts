import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import type { TunnelApi } from '../application/inbound/tunnel-api.js'
import type { DisplayEnvelope, OutboxStore } from '../application/ports/index.js'
import type { LocalConfirmation } from '../application/ports/trust.js'
import { DeviceTrustService } from '../application/trust/device-trust-service.js'
import { SEALED_SEGMENT_BYTES, fromB64url, nodeContentSealer, openSegments } from '../channel/formats.js'
import { clientIdFor, identityFingerprint, type ClientPlatform } from '../domain/trust/index.js'
import type { DisplayFields } from '../domain/conversation/index.js'
import { FileDeviceSecrets, FileTrustRepository, platformVault, type VaultKeyProvider } from '../keystore/index.js'
import type { E2eeMode } from '../link/index.js'
import { deviceContent, type DeviceContent } from '../link/content.js'
import { plainSealer, type DisplaySealer } from '../sync/index.js'
import type { ClientPairingInvitation, LocalClientGrant } from '../host/index.js'
import type { Log } from './compose.js'

/** How long a pairing request waits for the first `LinkWelcome` (the Server's E2EE mode) after a start. */
const WELCOME_WAIT_MS = 20_000
const PLATFORMS: readonly ClientPlatform[] = ['web', 'desktop', 'android', 'ios', 'cli']

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** AES-GCM tag after every sealed segment (contracts/e2ee/1.0, attachments and sharing). */
const SEGMENT_TAG_BYTES = 16

/**
 * A sealed upload as the Server stores it: segments of 64 KiB + 16 bytes concatenated, the last one shorter. The
 * AD object id is the plaintext SHA-256 (the upload is sealed before the Server assigns a file id).
 */
export function openSealedUpload(ciphertext: Buffer, key: string, sha256: string): Buffer {
  const full = SEALED_SEGMENT_BYTES + SEGMENT_TAG_BYTES
  const segments: Uint8Array[] = []
  for (let start = 0; start < ciphertext.length; start += full) segments.push(ciphertext.subarray(start, start + full))
  // An empty file is one empty segment: just its tag.
  if (segments.length === 0) segments.push(ciphertext)
  return Buffer.from(openSegments('attachment', sha256, fromB64url(key), segments))
}

export interface DeviceTrustOptions {
  readonly dataDir: string
  readonly deviceId: string
  /** The Server this Connector is configured for: the `serverUrl` of a pairing invitation. */
  readonly serverUrl?: string
  readonly log: Log
  /** The client API served inside channels (`DeviceTunnelApi`). */
  readonly api: TunnelApi
  /** What clients see as this device's name in the trust list. */
  /** Where the secrets' wrapping key lives (default: the platform's keychain / DPAPI / Secret Service). */
  readonly vault?: VaultKeyProvider
  /** The person at this device confirms a client approved from another client (CLI prompt, Desktop dialog). */
  readonly confirmation?: LocalConfirmation
  /** Re-sends every session summary (after a directory key rotation). */
  readonly republishSummaries: () => Promise<number>
  readonly outbox: OutboxStore
}

/**
 * Device Trust and the secure channels (F's `application/trust`, `channel`, `keystore`) composed for one running
 * Connector: the effective E2EE mode, the `Secure/channel` handler, the display sealer the outbox uses, and the
 * directory key rotation follow-up (re-seal every summary, then retire the old key once the Server has them).
 */
export class DeviceTrust {
  public readonly trust: DeviceTrustService
  public readonly content: DeviceContent
  private serverMode: E2eeMode = 'off'
  private readonly unsubscribe: () => void
  private closed = false
  private welcomed!: () => void
  /** Resolves once the Server declared its mode (`LinkWelcome.e2eeMode`). */
  private readonly welcome = new Promise<void>(resolve => {
    this.welcomed = resolve
  })

  private constructor(private readonly options: DeviceTrustOptions, trust: DeviceTrustService, content: DeviceContent) {
    this.trust = trust
    this.content = content
    this.unsubscribe = trust.onEvent(event => {
      if (event.type === 'DirectoryKeyRotated') void this.reseal(event.previousKeyId)
    })
  }

  public static async open(options: DeviceTrustOptions): Promise<DeviceTrust> {
    const account = `${safeUser()}@${options.deviceId}`
    // Older hosts kept one trust store per computer. Keep it for its original binding;
    // a different device ID needs its own identity, directory keys and client grants.
    const legacy = new FileTrustRepository(options.dataDir)
    const legacyState = await legacy.load()
    const useLegacy = legacyState?.deviceId === options.deviceId
    const dataDir = useLegacy ? options.dataDir
      : join(options.dataDir, 'devices', createHash('sha256').update(options.deviceId).digest('hex'))
    const secrets = new FileDeviceSecrets(dataDir, options.vault ?? platformVault(account, dataDir))
    const trust = new DeviceTrustService({
      deviceId: options.deviceId,
      repository: useLegacy ? legacy : new FileTrustRepository(dataDir),
      secrets,
      clock: { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() },
      random: { bytes: length => new Uint8Array(randomBytes(length)), id: prefix => `${prefix}${randomBytes(12).toString('base64url')}` },
      sealer: nodeContentSealer,
      ...(options.confirmation !== undefined ? { confirmation: options.confirmation } : {}),
    })
    await trust.init(legacyState?.policy.required === true)
    const privateKey = (await secrets.identityKey()).secretKey
    return new DeviceTrust(options, trust, deviceContent(options.api, trust, privateKey))
  }

  /** The stricter of the Server's mode and this device's own policy (a device that once required E2EE keeps it). */
  public get mode(): E2eeMode {
    return this.trust.effectiveMode(this.serverMode)
  }

  /** This device's own policy, for the link's registration before and between welcomes. */
  public localMode(): E2eeMode {
    return this.trust.effectiveMode('off')
  }

  /** `LinkWelcome.e2eeMode`: remembered (the device never relaxes on the Server's word), applied to registration. */
  public async declareServerMode(mode: E2eeMode | undefined): Promise<void> {
    this.serverMode = mode === 'required' ? 'required' : 'off'
    await this.trust.declareServerMode(this.serverMode)
    this.welcomed()
  }

  /**
   * A client pairing invitation (§7.1): `startPairing` with the mode the Server declared in `LinkWelcome`. Only in
   * encrypted mode (the Server's or this device's own policy); before the first welcome it waits for one.
   */
  public async invite(waitMs = WELCOME_WAIT_MS, mobileLogin = false): Promise<ClientPairingInvitation> {
    if (this.closed) throw failure('connector_not_running', 'the Connector is not running')
    let timer: NodeJS.Timeout | undefined
    const welcomed = await Promise.race([
      this.welcome.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), waitMs)
        timer.unref()
      }),
    ])
    clearTimeout(timer)
    if (!welcomed) throw failure('connector_offline', 'the Connector has not reached its Server yet; check its connection and try again')
    if (this.mode !== 'required') throw failure('e2ee_off', 'this Server does not use end-to-end encryption (AGENT_SERVER_E2EE=required), so clients need no pairing')
    const serverUrl = this.options.serverUrl ?? ''
    if (serverUrl === '') throw failure('connector_not_running', 'the Connector has no Server configured')
    const invitation = await this.trust.startPairing(serverUrl, this.serverMode, mobileLogin)
    this.options.log('info', `client pairing ${invitation.payload.pairingId} (expires ${invitation.payload.expiresAt})`)
    return {
      uri: invitation.uri,
      deviceId: invitation.payload.deviceId,
      pairingId: invitation.payload.pairingId,
      expiresAt: invitation.payload.expiresAt,
      fingerprint: identityFingerprint(Buffer.from(invitation.payload.deviceIdentityPub, 'base64url')),
    }
  }

  /** §7.1: Desktop next to this Connector authorises its own client key through the local control interface. */
  public async grantLocal(request: { clientIdentityPub: string; label: string; platform: string | null }): Promise<LocalClientGrant> {
    const identityPub = fromB64url(request.clientIdentityPub)
    if (identityPub.length !== 32) throw failure('invalid_argument', 'clientIdentityPub must be a base64url X25519 public key')
    const platform = PLATFORMS.includes(request.platform as ClientPlatform) ? (request.platform as ClientPlatform) : null
    const grant = await this.trust.grantLocally({ clientId: clientIdFor(identityPub), identityPub: Buffer.from(identityPub).toString('base64url'), label: request.label, platform })
    this.options.log('info', `client ${grant.clientId} authorised on this computer`)
    return { clientId: grant.clientId, label: grant.label, identityPubFingerprint: identityFingerprint(identityPub) }
  }

  /**
   * The outbox's display sealer: plain in normal mode; sealed with the directory key in E2EE mode, where it never
   * falls back to plain (a failure keeps the record in the outbox).
   */
  public sealer(): DisplaySealer {
    const owner = this
    return {
      get encrypted() {
        return owner.mode === 'required'
      },
      async seal(fields: DisplayFields, sessionId: string): Promise<DisplayEnvelope> {
        if (owner.mode !== 'required') return plainSealer.seal(fields, sessionId)
        const sealed = await owner.trust.sealDisplay(sessionId, 'device', { ...fields })
        return { mode: 'sealed', keyId: sealed.keyId, payload: sealed.payload }
      },
    }
  }

  /** After a rotation: every summary again under the new key, then the old key goes once the Server acked them. */
  private async reseal(previousKeyId: string): Promise<void> {
    try {
      await this.options.republishSummaries()
      const last = (await this.options.outbox.pending(0, 1_000_000)).at(-1)?.oid ?? 0
      for (;;) {
        if (this.closed) return
        const lowest = await this.options.outbox.lowest()
        if (lowest === null || lowest > last) break
        await new Promise(resolve => setTimeout(resolve, 2000).unref())
      }
      await this.trust.retireDirectoryKey(previousKeyId)
      this.options.log('info', `directory key ${previousKeyId} retired after re-sealing every session summary`)
    } catch (error) {
      this.options.log('warn', `re-sealing after a directory key rotation failed: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  public async close(): Promise<void> {
    this.closed = true
    this.unsubscribe()
  }
}

function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'connector'
  }
}

export const TRUST_DIRECTORY = (dataDir: string): string => join(dataDir, 'trust')
