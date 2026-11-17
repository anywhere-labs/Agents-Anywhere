// DeviceSecrets 的文件实现：身份私钥与列表密钥存在 <dataDir>/trust/secrets.json（0600），
// 有系统保险库时整份用 AES-256-GCM 加密。不写进任何备份或导出。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DeviceSecrets } from '../application/ports/trust.js'
import { generateX25519, x25519FromSecret } from '../channel/noise/node-crypto.js'
import { KeystoreError, type VaultKeyProvider } from './vault.js'

interface SecretsFile {
  identity: string | null
  directoryKeys: Record<string, string>
}

interface Envelope {
  v: 1
  protection: string
  data: string
}

const AD = Buffer.from('aa-device-secrets/1', 'utf8')

export class FileDeviceSecrets implements DeviceSecrets {
  readonly #file: string
  readonly #vault: VaultKeyProvider
  #cache: SecretsFile | null = null
  readonly #warn: (message: string) => void
  /**
   * What is on disk, which decides how the next save is protected:
   * - `fresh`: no secrets file, nothing a new key could lose. Use the vault; when it is unreachable (no session bus
   *   on a headless Linux, an inaccessible keychain) fall back to the 0600 file and say why.
   * - `sealed`: sealed with the vault key. Reuse that key; never create, replace or fall back.
   * - `plain`: the 0600 fallback. Stay on it, even once a vault is reachable, so the secrets never change keys.
   */
  #state: 'fresh' | 'sealed' | 'plain' = 'fresh'
  #protection: string | null = null
  #queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, vault: VaultKeyProvider, options: { readonly warn?: (message: string) => void } = {}) {
    this.#file = path.join(dataDir, 'trust', 'secrets.json')
    this.#vault = vault
    this.#warn = options.warn ?? (message => console.warn(message))
  }

  /** Which protection the secrets have (`none` for the 0600 fallback); the Desktop settings page shows it. */
  get protection(): string {
    return this.#protection ?? this.#vault.kind
  }

  async identityKey(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
    return this.#serial(async () => {
      const secrets = await this.#load()
      if (!secrets.identity) {
        secrets.identity = Buffer.from(generateX25519().secretKey).toString('base64url')
        await this.#save(secrets)
      }
      const pair = x25519FromSecret(Buffer.from(secrets.identity, 'base64url'))
      return { publicKey: pair.publicKey, secretKey: pair.secretKey }
    })
  }

  async directoryKey(keyId: string): Promise<Uint8Array | null> {
    const secrets = await this.#serial(() => this.#load())
    const key = secrets.directoryKeys[keyId]
    return key ? new Uint8Array(Buffer.from(key, 'base64url')) : null
  }

  async putDirectoryKey(keyId: string, key: Uint8Array): Promise<void> {
    await this.#serial(async () => {
      const secrets = await this.#load()
      secrets.directoryKeys[keyId] = Buffer.from(key).toString('base64url')
      await this.#save(secrets)
    })
  }

  async deleteDirectoryKey(keyId: string): Promise<void> {
    await this.#serial(async () => {
      const secrets = await this.#load()
      delete secrets.directoryKeys[keyId]
      await this.#save(secrets)
    })
  }

  async #load(): Promise<SecretsFile> {
    if (this.#cache) return this.#cache
    let raw: string
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#state = 'fresh'
      this.#cache = { identity: null, directoryKeys: {} }
      return this.#cache
    }
    const envelope = JSON.parse(raw) as Envelope
    let plaintext: Buffer
    if (envelope.protection === 'none') {
      this.#state = 'plain'
      this.#protection = 'none'
      plaintext = Buffer.from(envelope.data, 'base64url')
    } else {
      // The file exists, so the key must too: never create one here (it could not open this file anyway).
      const key = await this.#vault.getOrCreate({ create: false })
      if (!key) {
        throw new KeystoreError('keystore_unavailable', `device secrets are protected by ${envelope.protection}, whose key is not available`, {
          kind: envelope.protection,
          reason: 'key_missing',
        })
      }
      this.#state = 'sealed'
      this.#protection = envelope.protection
      const bytes = Buffer.from(envelope.data, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), { authTagLength: 16 })
      decipher.setAAD(AD)
      decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      plaintext = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()])
    }
    this.#cache = JSON.parse(plaintext.toString('utf8')) as SecretsFile
    return this.#cache
  }

  async #save(secrets: SecretsFile): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8')
    const key = await this.#sealKey()
    let envelope: Envelope
    if (key) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
      cipher.setAAD(AD)
      const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
      envelope = { v: 1, protection: this.#vault.kind, data: Buffer.concat([nonce, body]).toString('base64url') }
    } else {
      envelope = { v: 1, protection: 'none', data: plaintext.toString('base64url') }
    }
    await writeAtomic(this.#file, JSON.stringify(envelope))
    this.#state = key ? 'sealed' : 'plain'
    this.#protection = envelope.protection
    this.#cache = secrets
  }

  /** The key the next save seals with; null writes the 0600 fallback (see `#state`). */
  async #sealKey(): Promise<Uint8Array | null> {
    switch (this.#state) {
      case 'plain':
        return null
      case 'sealed': {
        const key = await this.#vault.getOrCreate({ create: false })
        if (!key) throw new KeystoreError('keystore_unavailable', 'the vault key that protects the device secrets is no longer available', { reason: 'key_missing' })
        return key
      }
      case 'fresh':
        try {
          return await this.#vault.getOrCreate()
        } catch (error) {
          this.#warn(`device secrets: the ${this.#vault.kind} vault is unavailable (${(error as Error).message}); storing them in an owner-only (0600) file instead`)
          return null
        }
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }
}

/** Write via a temporary file and rename, owner-only (0700 directory, 0600 file). */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, file)
  await chmod(file, 0o600).catch(() => undefined)
}
