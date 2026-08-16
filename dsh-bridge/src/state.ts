import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionBinding } from './types.js'

function key(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class BridgeState {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.root, 'bindings'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'messages'), { recursive: true, mode: 0o700 })
  }

  async binding(externalSessionId: string): Promise<SessionBinding | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, 'bindings', `${key(externalSessionId)}.json`), 'utf8')) as SessionBinding
      return typeof raw.sessionId === 'string' && raw.externalSessionId === externalSessionId ? raw : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async bind(binding: SessionBinding): Promise<void> {
    const existing = await this.binding(binding.externalSessionId)
    if (existing !== undefined && existing.sessionId !== binding.sessionId) throw new Error('SESSION_BINDING_CONFLICT')
    await this.atomic(join(this.root, 'bindings', `${key(binding.externalSessionId)}.json`), binding)
  }

  async hasMessage(externalSessionId: string, clientMessageId: string): Promise<boolean> {
    try {
      await readFile(join(this.root, 'messages', `${key(`${externalSessionId}\0${clientMessageId}`)}.json`))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async rememberMessage(externalSessionId: string, clientMessageId: string): Promise<void> {
    await this.atomic(join(this.root, 'messages', `${key(`${externalSessionId}\0${clientMessageId}`)}.json`), {
      externalSessionIdHash: key(externalSessionId),
      clientMessageIdHash: key(clientMessageId),
    })
  }

  private async atomic(path: string, value: unknown): Promise<void> {
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
      const parent = await open(directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
