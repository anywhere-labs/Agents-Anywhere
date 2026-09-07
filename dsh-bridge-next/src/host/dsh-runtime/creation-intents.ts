import { join } from 'node:path'
import { readJson, writeJson } from '../storage/files.js'
import { digest } from './identity.js'

type CreationIntent = { requestId: string; fingerprint: string }

/** Retry bookkeeping only. Model, permission and mode facts remain in official DSH session storage. */
export class CreationIntents {
  constructor(private directory: string) {}
  async read(id: string): Promise<CreationIntent | null> {
    const value = await readJson<CreationIntent>(this.path(id))
    if (value && (typeof value.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint))) throw new Error('Invalid DSH creation receipt')
    return value
  }
  write(id: string, intent: CreationIntent): Promise<void> { return writeJson(this.path(id), intent) }
  private path(id: string): string { return join(this.directory, `${digest(id)}.json`) }
}
