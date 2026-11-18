// The collaboration client's keys (encrypted mode): <dataDir>/trust/agent-peers.json (0600). The identity lets this
// device's Agents open secure channels to other devices that approved it as an `agent` client; it grants nothing on
// this device, so it is kept apart from the device identity in secrets.json.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { AgentPeerKeyring, PinnedPeer } from '../application/ports/collab.js'
import { generateX25519, x25519FromSecret, type X25519KeyPair } from '../channel/noise/node-crypto.js'
import { identityFingerprint } from '../domain/trust/index.js'

interface PeersFile {
  v: 1
  identity: string | null
  peers: PinnedPeer[]
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export class FileAgentPeers implements AgentPeerKeyring {
  readonly #file: string
  readonly #now: () => string
  #cache: PeersFile | null = null
  #queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, now: () => string = () => new Date().toISOString()) {
    this.#file = path.join(dataDir, 'trust', 'agent-peers.json')
    this.#now = now
  }

  /** The collaboration identity's key pair (created on first use). */
  async keyPair(): Promise<X25519KeyPair> {
    return this.#serial(async () => {
      const file = await this.#load()
      if (file.identity !== null) return x25519FromSecret(Buffer.from(file.identity, 'base64url'))
      const created = generateX25519()
      await this.#save({ ...file, identity: b64url(created.secretKey) })
      return created
    })
  }

  async identityPub(): Promise<string> {
    return b64url((await this.keyPair()).publicKey)
  }

  async peers(): Promise<PinnedPeer[]> {
    return [...(await this.#load()).peers]
  }

  async pinned(deviceId: string): Promise<PinnedPeer | null> {
    return (await this.#load()).peers.find(peer => peer.deviceId === deviceId) ?? null
  }

  async pin(peer: { readonly deviceId: string; readonly identityPub: string; readonly label: string }): Promise<PinnedPeer> {
    const pub = Buffer.from(peer.identityPub, 'base64url')
    if (pub.length !== 32) throw Object.assign(new Error('deviceIdentityPub must be a 32-byte base64url key'), { code: 'invalid_argument' })
    return this.#serial(async () => {
      const file = await this.#load()
      const entry: PinnedPeer = { deviceId: peer.deviceId, identityPub: b64url(pub), identityPubFingerprint: identityFingerprint(pub), label: peer.label.slice(0, 200), pinnedAt: this.#now() }
      await this.#save({ ...file, peers: [...file.peers.filter(item => item.deviceId !== peer.deviceId), entry] })
      return entry
    })
  }

  async #load(): Promise<PeersFile> {
    if (this.#cache !== null) return this.#cache
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<PeersFile>
      this.#cache = { v: 1, identity: typeof parsed.identity === 'string' ? parsed.identity : null, peers: Array.isArray(parsed.peers) ? parsed.peers : [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#cache = { v: 1, identity: null, peers: [] }
    }
    return this.#cache
  }

  async #save(file: PeersFile): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    const temporary = `${this.#file}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.#file)
    this.#cache = file
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run)
    this.#queue = next.catch(() => undefined)
    return next
  }
}
