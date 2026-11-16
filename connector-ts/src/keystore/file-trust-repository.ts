// TrustRepository 的文件实现：<dataDir>/trust/trust.json（0600）。信任列表只有公钥与名称，不是秘密，
// 但只能由设备自己写。

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
