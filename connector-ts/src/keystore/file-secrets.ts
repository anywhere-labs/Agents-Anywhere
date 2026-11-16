// DeviceSecrets 的文件实现：身份私钥与列表密钥存在 <dataDir>/trust/secrets.json（0600），
// 有系统保险库时整份用 AES-256-GCM 加密。不写进任何备份或导出。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DeviceSecrets } from '../application/ports/trust.js'
import { generateX25519, x25519FromSecret } from '../channel/noise/node-crypto.js'
import type { VaultKeyProvider } from './vault.js'

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
  #queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, vault: VaultKeyProvider) {
    this.#file = path.join(dataDir, 'trust', 'secrets.json')
    this.#vault = vault
  }

  /** Which protection the secrets have; the Desktop settings page shows it. */
  get protection(): string {
    return this.#vault.kind
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
      this.#cache = { identity: null, directoryKeys: {} }
      return this.#cache
    }
    const envelope = JSON.parse(raw) as Envelope
    let plaintext: Buffer
    if (envelope.protection === 'none') {
      plaintext = Buffer.from(envelope.data, 'base64url')
    } else {
      const key = await this.#vault.getOrCreate()
      if (!key) throw new Error(`device secrets are protected by ${envelope.protection}, which is not available`)
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
    const key = await this.#vault.getOrCreate()
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
    this.#cache = secrets
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
