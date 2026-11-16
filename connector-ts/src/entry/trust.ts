import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { TunnelApi } from '../application/inbound/tunnel-api.js'
import type { DisplayEnvelope, OutboxStore } from '../application/ports/index.js'
import type { LocalConfirmation } from '../application/ports/trust.js'
import { DeviceTrustService } from '../application/trust/device-trust-service.js'
import { SEALED_SEGMENT_BYTES, SecureChannelHub, fromB64url, nodeContentSealer, openSegments } from '../channel/index.js'
import { nodeNoiseCrypto, x25519FromSecret } from '../channel/noise/node-crypto.js'
import type { DisplayFields } from '../domain/conversation/index.js'
import { FileDeviceSecrets, FileTrustRepository, platformVault, type VaultKeyProvider } from '../keystore/index.js'
import { secureChannelVia, type E2eeMode, type SecureChannelHandler } from '../link/index.js'
import { plainSealer, type DisplaySealer } from '../sync/index.js'
import type { Log } from './compose.js'

/** AES-GCM tag after every sealed segment (contracts/e2ee/1.0 「附件与分享」). */
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
  readonly log: Log
  /** The client API served inside channels (`DeviceTunnelApi`). */
  readonly api: TunnelApi
  /** What clients see as this device's name in the trust list. */
  readonly deviceLabel?: string
  /** Where the secrets' wrapping key lives (default: the platform's keychain / DPAPI / Secret Service). */
  readonly vault?: VaultKeyProvider
  /** The person at this device confirms a client approved from another client (Desktop dialog). */
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
  public readonly hub: SecureChannelHub
  public readonly secure: SecureChannelHandler
  private serverMode: E2eeMode = 'off'
  private readonly unsubscribe: () => void
  private closed = false

  private constructor(private readonly options: DeviceTrustOptions, trust: DeviceTrustService, hub: SecureChannelHub) {
    this.trust = trust
    this.hub = hub
    this.secure = secureChannelVia(hub)
    this.unsubscribe = trust.onEvent(event => {
      if (event.type === 'DirectoryKeyRotated') void this.reseal(event.previousKeyId)
    })
  }

  public static async open(options: DeviceTrustOptions): Promise<DeviceTrust> {
    const account = `${safeUser()}@${options.deviceId}`
    const secrets = new FileDeviceSecrets(options.dataDir, options.vault ?? platformVault(account, options.dataDir))
    const trust = new DeviceTrustService({
      deviceId: options.deviceId,
      repository: new FileTrustRepository(options.dataDir),
      secrets,
      clock: { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() },
      random: { bytes: length => new Uint8Array(randomBytes(length)), id: prefix => `${prefix}${randomBytes(12).toString('base64url')}` },
      sealer: nodeContentSealer,
      ...(options.confirmation !== undefined ? { confirmation: options.confirmation } : {}),
    })
    await trust.init()
    const identity = x25519FromSecret((await secrets.identityKey()).secretKey)
    const hub = new SecureChannelHub({ deviceId: options.deviceId, deviceLabel: options.deviceLabel ?? hostname(), trust, identity, crypto: nodeNoiseCrypto, api: options.api })
    return new DeviceTrust(options, trust, hub)
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
    await this.hub.closeAll('shutdown').catch(() => undefined)
    this.hub.dispose()
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
