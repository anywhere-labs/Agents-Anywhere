// Client Trust (docs/v3/11-e2ee-noise.md §3, §7): this client's identity, the devices it paired with (their
// pinned keys and current directory keys) and the local "requires encryption" policy.
//
// Keys stay inside WebCrypto: the identity private key and the directory keys are non-extractable CryptoKeys,
// stored as structured clones in IndexedDB. Script on the page can use them while it runs, but cannot read the
// bytes out. Only this client's own actions change the record; nothing the Server says relaxes it (E-3).

import { buf, fromB64url } from "./bytes"
import type { DirectoryKeyGrant } from "./client-channel"
import { clientIdFor, e2eeLabel, identityFingerprint } from "./formats"
import type { NoiseKeyPair } from "./noise"
import { generateIdentity, hmacSha256, keyPairFromCryptoKeys } from "./webcrypto"

export interface StoredDirectoryKey {
  readonly keyId: string
  readonly epoch: number
  /** AES-256-GCM, non-extractable: opens and seals display envelopes. */
  readonly aes: CryptoKey
  /** HMAC-SHA256 of the input-digest sub-key, non-extractable. */
  readonly digest: CryptoKey
}

export interface DevicePin {
  readonly deviceId: string
  /** base64url X25519 public key, pinned at pairing. */
  readonly devicePub: string
  readonly fingerprint: string
  readonly label: string
  readonly grantedAt: string
  /** Current key first; earlier epochs are kept until the device retires them. */
  readonly directoryKeys: readonly StoredDirectoryKey[]
}

export interface ClientIdentity {
  readonly clientId: string
  readonly fingerprint: string
  readonly publicKey: Uint8Array
  readonly noise: NoiseKeyPair
}

/** Persistence for trust records; values are structured-cloneable (CryptoKey included). */
export interface TrustBackend {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}

const IDENTITY = "identity"
const POLICY = "policy"
const devicePinKey = (deviceId: string) => `device:${deviceId}`

export interface LocalPolicy {
  /** Set once the deployment declared `required` or this client paired with any device; cleared only locally. */
  readonly required: boolean
  readonly since: string | null
}

async function importDirectoryKey(grant: DirectoryKeyGrant): Promise<StoredDirectoryKey> {
  const raw = fromB64url(grant.key)
  if (raw.length !== 32) throw new RangeError("directory key must be 32 bytes")
  const subtle = globalThis.crypto.subtle
  const aes = await subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
  const digestRaw = await hmacSha256(raw, e2eeLabel("input-digest"))
  const digest = await subtle.importKey("raw", buf(digestRaw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  raw.fill(0)
  digestRaw.fill(0)
  return { keyId: grant.keyId, epoch: grant.epoch, aes, digest }
}

export class ClientTrustStore {
  readonly #backend: TrustBackend
  #identity: Promise<ClientIdentity> | null = null
  readonly #listeners = new Set<() => void>()

  constructor(backend: TrustBackend) {
    this.#backend = backend
  }

  /** This client's identity; created on first use and kept for good. */
  identity(): Promise<ClientIdentity> {
    this.#identity ??= (async () => {
      let keys = await this.#backend.get<CryptoKeyPair>(IDENTITY)
      if (!keys) {
        keys = await generateIdentity()
        await this.#backend.put(IDENTITY, keys)
      }
      const noise = await keyPairFromCryptoKeys(keys)
      return {
        clientId: await clientIdFor(noise.publicKey),
        fingerprint: await identityFingerprint(noise.publicKey),
        publicKey: noise.publicKey,
        noise,
      }
    })()
    this.#identity.catch(() => {
      this.#identity = null
    })
    return this.#identity
  }

  async policy(): Promise<LocalPolicy> {
    return (await this.#backend.get<LocalPolicy>(POLICY)) ?? { required: false, since: null }
  }

  /** Records that encryption is required. Only ever tightens: a later `off` from the Server changes nothing. */
  async requireEncryption(now = new Date().toISOString()): Promise<void> {
    if ((await this.policy()).required) return
    await this.#backend.put(POLICY, { required: true, since: now } satisfies LocalPolicy)
    this.#changed()
  }

  /** The only way back to plaintext: an explicit action by the person using this client. */
  async relaxLocally(): Promise<void> {
    await this.#backend.put(POLICY, { required: false, since: null } satisfies LocalPolicy)
    this.#changed()
  }

  async pin(deviceId: string): Promise<DevicePin | null> {
    return (await this.#backend.get<DevicePin>(devicePinKey(deviceId))) ?? null
  }

  async pins(): Promise<DevicePin[]> {
    const keys = await this.#backend.keys("device:")
    const pins = await Promise.all(keys.map((key) => this.#backend.get<DevicePin>(key)))
    return pins.filter((pin): pin is DevicePin => Boolean(pin))
  }

  /** After `pair.committed`: pin the device key and keep the directory key. Pairing also turns encryption on. */
  async savePairing(input: {
    deviceId: string
    devicePub: string
    label: string
    grantedAt: string
    directoryKey: DirectoryKeyGrant
  }): Promise<DevicePin> {
    const existing = await this.pin(input.deviceId)
    if (existing && existing.devicePub !== input.devicePub)
      // A different device identity under the same id: never overwrite silently.
      throw Object.assign(new Error("device key changed"), { code: "device_pin_mismatch" })
    const pin: DevicePin = {
      deviceId: input.deviceId,
      devicePub: input.devicePub,
      fingerprint: await identityFingerprint(fromB64url(input.devicePub)),
      label: input.label,
      grantedAt: input.grantedAt,
      directoryKeys: [await importDirectoryKey(input.directoryKey)],
    }
    await this.#backend.put(devicePinKey(input.deviceId), pin)
    await this.requireEncryption()
    this.#changed()
    return pin
  }

  /** `e2ee.directory_key` pushed by the device after a rotation (only through the channel). */
  async addDirectoryKey(grant: DirectoryKeyGrant): Promise<void> {
    const pin = await this.pin(grant.deviceId)
    if (!pin || pin.directoryKeys.some((key) => key.keyId === grant.keyId)) return
    const next = await importDirectoryKey(grant)
    const keys = [next, ...pin.directoryKeys].sort((a, b) => b.epoch - a.epoch).slice(0, 4)
    await this.#backend.put(devicePinKey(pin.deviceId), { ...pin, directoryKeys: keys } satisfies DevicePin)
    this.#changed()
  }

  /** The device said this client is no longer trusted (revoked / not paired): drop the pin, keep the policy. */
  async forget(deviceId: string): Promise<void> {
    await this.#backend.delete(devicePinKey(deviceId))
    this.#changed()
  }

  directoryKey(pin: DevicePin, keyId?: string): StoredDirectoryKey | null {
    return (keyId ? pin.directoryKeys.find((key) => key.keyId === keyId) : pin.directoryKeys[0]) ?? null
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        // listeners must not break trust updates
      }
    }
  }
}

/** In-memory backend (tests, and browsers without IndexedDB: nothing survives a reload). */
export function memoryTrustBackend(): TrustBackend {
  const values = new Map<string, unknown>()
  return {
    async get(key) {
      return values.get(key) as never
    },
    async put(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
    async keys(prefix) {
      return [...values.keys()].filter((key) => key.startsWith(prefix))
    },
  }
}

/** IndexedDB backend: one object store, structured clones (CryptoKeys stay non-extractable). */
export function indexedDbTrustBackend(name = "aa-e2ee-trust"): TrustBackend {
  const STORE = "trust"
  let db: Promise<IDBDatabase> | null = null
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }))
  const run = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, mode)
      const request = action(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  return {
    get: (key) => run("readonly", (store) => store.get(key)),
    put: async (key, value) => {
      await run("readwrite", (store) => store.put(value, key))
    },
    delete: async (key) => {
      await run("readwrite", (store) => store.delete(key))
    },
    keys: async (prefix) =>
      ((await run("readonly", (store) => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))) as IDBValidKey[]).map(String),
  }
}
