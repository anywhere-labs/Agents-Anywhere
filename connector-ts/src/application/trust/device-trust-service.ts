import {
  activeGrants,
  approveClient,
  authorizeClient,
  cancelPairing,
  completePairing,
  declareServerMode,
  e2eeLabel,
  effectiveMode,
  expirePairings,
  grantLocally,
  identityFingerprint,
  newDeviceTrust,
  relaxPolicyLocally,
  requireOpenPairing,
  retireDirectoryKey,
  revokeClient,
  rotateDirectoryKey,
  setApprovalWithoutConfirmation,
  startPairing,
  type Change,
  type ClientGrant,
  type DeviceTrustState,
  type E2eeMode,
  type NewClient,
  type TrustEvent,
  TrustError,
} from '../../domain/trust/index.js'
import type {
  ContentSealer,
  DeviceSecrets,
  LocalConfirmation,
  TrustClock,
  TrustRandom,
  TrustRepository,
  TrustListView,
} from '../ports/trust.js'

const DIRECTORY_KEY_BYTES = 32
const PSK_BYTES = 32

export interface PairingInvitation {
  readonly payload: {
    readonly v: 1
    readonly deviceId: string
    readonly deviceIdentityPub: string
    readonly pairingId: string
    readonly psk: string
    readonly serverUrl: string
    readonly e2eeMode: E2eeMode
    readonly expiresAt: string
  }
  /** `aa-pair://<base64url(json)>`, the QR code content. */
  readonly uri: string
}

export interface DirectoryKeyGrant {
  readonly deviceId: string
  readonly keyId: string
  readonly epoch: number
  readonly key: string
}

export interface SealedDisplay {
  readonly mode: 'sealed'
  readonly keyId: string
  readonly payload: string
}

export interface TrustServiceDeps {
  readonly deviceId: string
  readonly repository: TrustRepository
  readonly secrets: DeviceSecrets
  readonly clock: TrustClock
  readonly random: TrustRandom
  readonly sealer: ContentSealer
  readonly confirmation?: LocalConfirmation
}

/**
 * Device Trust use cases: the only writer of the trust list. Mutations are serialised and persisted before their
 * events are published, so a channel never acts on a grant that a crash would forget.
 */
export class DeviceTrustService {
  readonly #deps: TrustServiceDeps
  #state: DeviceTrustState | null = null
  #queue: Promise<unknown> = Promise.resolve()
  /** Pairing psks live only in memory: a restart voids every open QR code. */
  readonly #psks = new Map<string, Uint8Array>()
  readonly #listeners = new Set<(event: TrustEvent) => void>()

  constructor(deps: TrustServiceDeps) {
    this.#deps = deps
  }

  /** Load the trust list, or create it with a fresh identity and directory key on first run. */
  async init(requireEncryptionOnFirstUse = false): Promise<DeviceTrustState> {
    return this.#serial(async () => {
      const identity = await this.#deps.secrets.identityKey()
      const identityPub = Buffer.from(identity.publicKey).toString('base64url')
      let state = await this.#deps.repository.load()
      if (state && state.identityPub !== identityPub) {
        // The secret store was reset (reinstall, keychain wiped): this is a new device identity and every grant
        // pinned the old key, so they are void (§4.1 invariant 4).
        state = null
      }
      if (!state) {
        const keyId = this.#deps.random.id('dk_')
        await this.#deps.secrets.putDirectoryKey(keyId, this.#deps.random.bytes(DIRECTORY_KEY_BYTES))
        state = newDeviceTrust(this.#deps.deviceId, identityPub, keyId)
        if (requireEncryptionOnFirstUse) state = declareServerMode(state, 'required', this.#deps.clock.nowIso()).state
        await this.#deps.repository.save(state)
      }
      // Pairings are never persisted with their psk; drop any left over.
      state = { ...state, pairings: [] }
      this.#state = state
      return state
    })
  }

  get state(): DeviceTrustState {
    if (!this.#state) throw new Error('DeviceTrustService.init() was not called')
    return this.#state
  }

  onEvent(listener: (event: TrustEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  effectiveMode(serverMode: E2eeMode): E2eeMode {
    return effectiveMode(this.state, serverMode)
  }

  async declareServerMode(serverMode: E2eeMode): Promise<void> {
    await this.#apply((state) => declareServerMode(state, serverMode, this.#deps.clock.nowIso()))
  }

  async relaxPolicyLocally(confirmedByLocalUser: boolean): Promise<void> {
    await this.#apply((state) => relaxPolicyLocally(state, this.#deps.clock.nowIso(), confirmedByLocalUser))
  }

  async setApprovalWithoutConfirmation(enabled: boolean): Promise<void> {
    await this.#apply((state) => ({ state: setApprovalWithoutConfirmation(state, enabled), events: [] }))
  }

  async startPairing(serverUrl: string, serverMode: E2eeMode): Promise<PairingInvitation> {
    return this.#serial(async () => {
      const nowMs = this.#deps.clock.nowMs()
      let pairing = this.state.pairings.find(item => item.state === 'open' && item.expiresAtMs > nowMs)
      if (!pairing) {
        const id = this.#deps.random.id('pair_')
        const state = await this.#commit(startPairing(this.state, id, nowMs))
        pairing = state.pairings.find(item => item.pairingId === id)!
      }
      const payload = {
        v: 1 as const,
        deviceId: this.state.deviceId,
        deviceIdentityPub: this.state.identityPub,
        pairingId: pairing.pairingId,
        psk: Buffer.from(this.#psks.get(pairing.pairingId)!).toString('base64url'),
        serverUrl,
        e2eeMode: effectiveMode(this.state, serverMode),
        expiresAt: new Date(pairing.expiresAtMs).toISOString(),
      }
      return { payload, uri: `aa-pair://${Buffer.from(JSON.stringify(payload)).toString('base64url')}` }
    })
  }

  async cancelPairing(pairingId: string): Promise<void> {
    await this.#apply((state) => cancelPairing(state, pairingId))
  }

  async expirePairings(): Promise<void> {
    await this.#apply((state) => expirePairings(state, this.#deps.clock.nowMs()))
  }

  /** The psk of an open pairing, for the XXpsk0 responder. Throws `pairing_expired`. */
  pairingPsk(pairingId: string): Uint8Array {
    requireOpenPairing(this.state, pairingId, this.#deps.clock.nowMs())
    const psk = this.#psks.get(pairingId)
    if (!psk) throw new TrustError('pairing_expired', 'the pairing code has expired or was already used')
    return Uint8Array.from(psk)
  }

  /** Redeem a local invitation. A client retrying a lost reply can prove it holds the saved credential. */
  async commitMeshPairing(
    pairingId: string,
    client: NewClient,
    matches: (secret: Uint8Array) => boolean,
    matchesCredential: (digest: string | undefined) => boolean,
  ): Promise<void> {
    await this.#apply((current) => {
      const existing = current.grants.find(grant => grant.clientId === client.clientId && grant.revokedAt === null)
      if (existing && matchesCredential(existing.meshCredentialDigest)) {
        // A lost reply can be retried after redemption. A fresh invitation shown to the same client is single-use too.
        const open = current.pairings.find(pairing => pairing.pairingId === pairingId && pairing.expiresAtMs > this.#deps.clock.nowMs())
        if (open && matches(this.pairingPsk(pairingId))) return cancelPairing(current, pairingId)
        return { state: current, events: [] }
      }
      if (!matches(this.pairingPsk(pairingId))) throw new TrustError('pairing_expired', 'invalid pairing invitation')
      return completePairing(current, pairingId, client, this.#deps.clock.nowMs(), this.#deps.clock.nowIso())
    })
  }

  /** XXpsk0 finished: consume the pairing, write the grant, return the directory key the client receives. */
  async completePairing(pairingId: string, client: NewClient): Promise<{ grant: ClientGrant; directoryKey: DirectoryKeyGrant }> {
    const nowMs = this.#deps.clock.nowMs()
    const state = await this.#apply((current) => completePairing(current, pairingId, client, nowMs, this.#deps.clock.nowIso()))
    return { grant: authorizeClient(state, client.clientId), directoryKey: await this.directoryKeyGrant() }
  }

  async grantLocally(client: NewClient): Promise<ClientGrant> {
    const state = await this.#apply((current) => grantLocally(current, client, this.#deps.clock.nowIso()))
    return authorizeClient(state, client.clientId)
  }

  async approveClient(approverClientId: string, client: NewClient): Promise<ClientGrant> {
    const approver = authorizeClient(this.state, approverClientId)
    let confirmed = false
    if (!this.state.policy.approvalWithoutConfirmation) {
      confirmed = (await this.#deps.confirmation?.confirmClientApproval({
        approverLabel: approver.label,
        label: client.label,
        fingerprint: identityFingerprint(Buffer.from(client.identityPub, 'base64url')),
      })) ?? false
    }
    const state = await this.#apply((current) =>
      approveClient(current, approverClientId, client, this.#deps.clock.nowIso(), confirmed),
    )
    return authorizeClient(state, client.clientId)
  }

  async revokeClient(clientId: string, grantedAt?: string): Promise<DeviceTrustState> {
    const keyId = this.#deps.random.id('dk_')
    return this.#serial(async () => {
      if (grantedAt !== undefined && authorizeClient(this.state, clientId).grantedAt !== grantedAt) throw new TrustError('invalid_argument', 'The selected grant has changed')
      const change = revokeClient(this.state, clientId, this.#deps.clock.nowIso(), keyId)
      await this.#deps.secrets.putDirectoryKey(keyId, this.#deps.random.bytes(DIRECTORY_KEY_BYTES))
      return this.#commit(change)
    })
  }

  async rotateDirectoryKey(): Promise<DeviceTrustState> {
    const keyId = this.#deps.random.id('dk_')
    await this.#deps.secrets.putDirectoryKey(keyId, this.#deps.random.bytes(DIRECTORY_KEY_BYTES))
    return this.#apply((state) => rotateDirectoryKey(state, keyId))
  }

  /** Every envelope sealed with `keyId` was resealed; destroy the key. */
  async retireDirectoryKey(keyId: string): Promise<void> {
    await this.#apply((state) => retireDirectoryKey(state, keyId))
    await this.#deps.secrets.deleteDirectoryKey(keyId)
  }

  /** Throws `e2ee_not_paired` unless the client holds an active grant (with this key, when given). */
  authorize(clientId: string, identityPub?: Uint8Array): ClientGrant {
    return authorizeClient(this.state, clientId, identityPub && Buffer.from(identityPub).toString('base64url'))
  }

  /** The pinned identity key of an active client: the remote static of a KK handshake. */
  pinnedKey(clientId: string): Uint8Array {
    return Buffer.from(this.authorize(clientId).identityPub, 'base64url')
  }

  trustList(): TrustListView {
    const state = this.state
    return {
      deviceId: state.deviceId,
      grants: state.grants.map((grant) => ({
        clientId: grant.clientId,
        label: grant.label,
        platform: grant.platform,
        identityPubFingerprint: identityFingerprint(Buffer.from(grant.identityPub, 'base64url')),
        grantedAt: grant.grantedAt,
        grantedBy: grant.grantedBy,
        revokedAt: grant.revokedAt,
      })),
      directoryKeyId: state.directoryKey.keyId,
      directoryKeyEpoch: state.directoryKey.epoch,
    }
  }

  activeClientIds(): readonly string[] {
    return activeGrants(this.state).map((grant) => grant.clientId)
  }

  async directoryKeyGrant(): Promise<DirectoryKeyGrant> {
    const { keyId, epoch } = this.state.directoryKey
    const key = await this.#deps.secrets.directoryKey(keyId)
    if (!key) throw new Error(`directory key ${keyId} is missing from the secret store`)
    return { deviceId: this.state.deviceId, keyId, epoch, key: Buffer.from(key).toString('base64url') }
  }

  /** Seal a display envelope with the current directory key (§4.5, contracts/e2ee/1.0 README). */
  async sealDisplay(sessionId: string, slot: 'device' | 'user', payload: Record<string, unknown>): Promise<SealedDisplay> {
    const { keyId } = this.state.directoryKey
    const key = await this.#deps.secrets.directoryKey(keyId)
    if (!key) throw new Error(`directory key ${keyId} is missing from the secret store`)
    const ad = e2eeLabel('display', this.state.deviceId, sessionId, slot, keyId)
    const sealed = await this.#deps.sealer.seal(key, ad, Buffer.from(JSON.stringify(payload), 'utf8'))
    return { mode: 'sealed', keyId, payload: sealed }
  }

  /** Open an envelope sealed with the current or a retired key (e.g. a title a client set before a rotation). */
  async openDisplay(sessionId: string, slot: 'device' | 'user', envelope: SealedDisplay): Promise<Record<string, unknown>> {
    const known = [this.state.directoryKey.keyId, ...this.state.directoryKey.retiredKeyIds]
    if (!known.includes(envelope.keyId)) throw new Error(`unknown directory key ${envelope.keyId}`)
    const key = await this.#deps.secrets.directoryKey(envelope.keyId)
    if (!key) throw new Error(`directory key ${envelope.keyId} is missing from the secret store`)
    const ad = e2eeLabel('display', this.state.deviceId, sessionId, slot, envelope.keyId)
    const plaintext = await this.#deps.sealer.open(key, ad, envelope.payload)
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as Record<string, unknown>
  }

  #forgetPsk(pairingId: string): void {
    this.#psks.get(pairingId)?.fill(0)
    this.#psks.delete(pairingId)
  }

  async #apply(change: (state: DeviceTrustState) => Change): Promise<DeviceTrustState> {
    return this.#serial(() => this.#commit(change(this.state)))
  }

  async #commit({ state, events }: Change): Promise<DeviceTrustState> {
    if (state !== this.#state) {
      // Pairings and their secrets live only in this Connector process.
      await this.#deps.repository.save({ ...state, pairings: [] })
      this.#state = state
      for (const id of this.#psks.keys()) {
        if (!state.pairings.some(pairing => pairing.pairingId === id)) this.#forgetPsk(id)
      }
    }
    for (const event of events) {
      if (event.type === 'PairingStarted') this.#psks.set(event.pairingId, this.#deps.random.bytes(PSK_BYTES))
      for (const listener of this.#listeners) listener(event)
    }
    return state
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }
}
