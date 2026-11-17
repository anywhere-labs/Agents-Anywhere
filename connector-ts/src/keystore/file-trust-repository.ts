// File implementation of TrustRepository: <dataDir>/trust/trust.json (0600). The trust list holds only public keys
// and names, so it is not secret, but only the device itself writes it.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { TrustRepository } from '../application/ports/trust.js'
import type { DeviceTrustState } from '../domain/trust/index.js'
import { writeAtomic } from './file-secrets.js'

export class FileTrustRepository implements TrustRepository {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'trust', 'trust.json')
  }

  async load(): Promise<DeviceTrustState | null> {
    try {
      const document = JSON.parse(await readFile(this.#file, 'utf8')) as { v: number; state: DeviceTrustState }
      if (document.v !== 1) throw new Error(`unsupported trust.json version ${document.v}`)
      return document.state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async save(state: DeviceTrustState): Promise<void> {
    await writeAtomic(this.#file, JSON.stringify({ v: 1, state }, null, 2))
  }
}
