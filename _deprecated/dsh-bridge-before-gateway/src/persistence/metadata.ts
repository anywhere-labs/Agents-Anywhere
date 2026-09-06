import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  readJsonDirectorySecure,
  readOptionalJsonSecure,
  writeJsonAtomicSecure,
  writeJsonNoClobberSecure,
} from '../security/files.js'
import { deterministicMessageId, sha256Hex } from '../projection/identity.js'
import { BridgeError } from '../wire/errors.js'
import { isRecord } from '../wire/validation.js'

export interface BindingRecord {
  version: 1
  platformSessionId: string
  externalSessionId: string
}

export interface MessageRecord {
  version: 1
  platformSessionId: string
  clientMessageId: string
  operation: 'create' | 'start' | 'steer'
  contentHash: string
  messageId: string
}

export interface CreationRecord {
  version: 1
  platformSessionId: string
  clientMessageId: string
  externalSessionId: string
  committed: boolean
}

interface CatalogRevisionRecord {
  version: 1
  revision: number
  fingerprint: string
}

export class MetadataStore {
  private readonly bindingsByPlatform = new Map<string, BindingRecord>()
  private readonly bindingsByExternal = new Map<string, BindingRecord>()
  private bindingTail: Promise<void> = Promise.resolve()
  private catalogTail: Promise<void> = Promise.resolve()

  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    const records = await readJsonDirectorySecure<unknown>(join(this.root, 'bindings'))
    for (const value of records) {
      const record = bindingRecord(value)
      const byPlatform = this.bindingsByPlatform.get(record.platformSessionId)
      const byExternal = this.bindingsByExternal.get(record.externalSessionId)
      if ((byPlatform !== undefined && byPlatform.externalSessionId !== record.externalSessionId)
        || (byExternal !== undefined && byExternal.platformSessionId !== record.platformSessionId)) {
        throw bindingConflict(record.platformSessionId, record.externalSessionId)
      }
      this.bindingsByPlatform.set(record.platformSessionId, record)
      this.bindingsByExternal.set(record.externalSessionId, record)
    }
  }

  bindingForPlatform(platformSessionId: string): BindingRecord | undefined {
    return this.bindingsByPlatform.get(platformSessionId)
  }

  bindingForExternal(externalSessionId: string): BindingRecord | undefined {
    return this.bindingsByExternal.get(externalSessionId)
  }

  async bind(platformSessionId: string, externalSessionId: string): Promise<BindingRecord> {
    let result: BindingRecord | undefined
    const operation = this.bindingTail.then(async () => {
      result = await this.bindCore(platformSessionId, externalSessionId)
    })
    this.bindingTail = operation.catch(() => undefined)
    await operation
    return result as BindingRecord
  }

  async reserveCreation(platformSessionId: string, clientMessageId: string): Promise<CreationRecord> {
    const path = this.path('creations', `${platformSessionId}\0${clientMessageId}`)
    const record: CreationRecord = {
      version: 1,
      platformSessionId,
      clientMessageId,
      externalSessionId: `aa-${randomUUID()}`,
      committed: false,
    }
    if (await writeJsonNoClobberSecure(path, record) === 'created') return record
    const existing = creationRecord(await readOptionalJsonSecure<unknown>(path))
    if (existing.platformSessionId !== platformSessionId || existing.clientMessageId !== clientMessageId) {
      throw corruptMetadata('creation reservation')
    }
    return existing
  }

  async commitCreation(record: CreationRecord): Promise<void> {
    await writeJsonAtomicSecure(this.path('creations', `${record.platformSessionId}\0${record.clientMessageId}`), {
      ...record,
      committed: true,
    } satisfies CreationRecord)
  }

  async message(platformSessionId: string, clientMessageId: string): Promise<MessageRecord | undefined> {
    const value = await readOptionalJsonSecure<unknown>(this.path('messages', `${platformSessionId}\0${clientMessageId}`))
    return value === undefined ? undefined : messageRecord(value)
  }

  async recordMessage(
    input: Omit<MessageRecord, 'version' | 'messageId'>,
  ): Promise<{ record: MessageRecord; duplicate: boolean }> {
    const record: MessageRecord = {
      version: 1,
      ...input,
      messageId: deterministicMessageId(input.platformSessionId, input.clientMessageId),
    }
    const path = this.path('messages', `${record.platformSessionId}\0${record.clientMessageId}`)
    if (await writeJsonNoClobberSecure(path, record) === 'created') return { record, duplicate: false }
    const existing = messageRecord(await readOptionalJsonSecure<unknown>(path))
    if (existing.operation !== record.operation
      || existing.contentHash !== record.contentHash
      || existing.messageId !== record.messageId
      || existing.platformSessionId !== record.platformSessionId
      || existing.clientMessageId !== record.clientMessageId) {
      throw new BridgeError('IDEMPOTENCY_CONFLICT', 'clientMessageId was already used for different content or operation.', {
        retryable: false,
        sessionId: record.platformSessionId,
      })
    }
    return { record: existing, duplicate: true }
  }

  async catalogRevision(fingerprint: string): Promise<number> {
    let result = 0
    const operation = this.catalogTail.then(async () => {
      const path = join(this.root, 'catalog-revisions.json')
      const value = await readOptionalJsonSecure<unknown>(path)
      if (value === undefined) {
        await writeJsonAtomicSecure(path, { version: 1, revision: 1, fingerprint } satisfies CatalogRevisionRecord)
        result = 1
        return
      }
      const current = catalogRevisionRecord(value)
      if (current.fingerprint === fingerprint) {
        result = current.revision
        return
      }
      result = current.revision + 1
      await writeJsonAtomicSecure(path, { version: 1, revision: result, fingerprint } satisfies CatalogRevisionRecord)
    })
    this.catalogTail = operation.catch(() => undefined)
    await operation
    return result
  }

  private async bindCore(platformSessionId: string, externalSessionId: string): Promise<BindingRecord> {
    const knownPlatform = this.bindingsByPlatform.get(platformSessionId)
    const knownExternal = this.bindingsByExternal.get(externalSessionId)
    if ((knownPlatform !== undefined && knownPlatform.externalSessionId !== externalSessionId)
      || (knownExternal !== undefined && knownExternal.platformSessionId !== platformSessionId)) {
      throw bindingConflict(platformSessionId, externalSessionId)
    }
    if (knownPlatform !== undefined) return knownPlatform
    const record: BindingRecord = { version: 1, platformSessionId, externalSessionId }
    const path = this.path('bindings', platformSessionId)
    if (await writeJsonNoClobberSecure(path, record) === 'exists') {
      const existing = bindingRecord(await readOptionalJsonSecure<unknown>(path))
      if (existing.platformSessionId !== platformSessionId || existing.externalSessionId !== externalSessionId) {
        throw bindingConflict(platformSessionId, externalSessionId)
      }
    }
    this.bindingsByPlatform.set(platformSessionId, record)
    this.bindingsByExternal.set(externalSessionId, record)
    return record
  }

  private path(kind: 'bindings' | 'creations' | 'messages', key: string): string {
    return join(this.root, kind, `${sha256Hex(key)}.json`)
  }
}

function bindingRecord(value: unknown): BindingRecord {
  if (!isRecord(value) || value.version !== 1
    || typeof value.platformSessionId !== 'string' || value.platformSessionId.length === 0
    || typeof value.externalSessionId !== 'string' || value.externalSessionId.length === 0) {
    throw corruptMetadata('binding')
  }
  return value as unknown as BindingRecord
}

function creationRecord(value: unknown): CreationRecord {
  if (!isRecord(value) || value.version !== 1
    || typeof value.platformSessionId !== 'string' || value.platformSessionId.length === 0
    || typeof value.clientMessageId !== 'string' || value.clientMessageId.length === 0
    || typeof value.externalSessionId !== 'string' || value.externalSessionId.length === 0
    || typeof value.committed !== 'boolean') {
    throw corruptMetadata('creation')
  }
  return value as unknown as CreationRecord
}

function messageRecord(value: unknown): MessageRecord {
  if (!isRecord(value) || value.version !== 1
    || typeof value.platformSessionId !== 'string' || value.platformSessionId.length === 0
    || typeof value.clientMessageId !== 'string' || value.clientMessageId.length === 0
    || !['create', 'start', 'steer'].includes(String(value.operation))
    || typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contentHash)
    || typeof value.messageId !== 'string' || value.messageId.length === 0) {
    throw corruptMetadata('message')
  }
  return value as unknown as MessageRecord
}

function catalogRevisionRecord(value: unknown): CatalogRevisionRecord {
  if (!isRecord(value) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0
    || typeof value.fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.fingerprint)) {
    throw corruptMetadata('catalog revision')
  }
  return value as unknown as CatalogRevisionRecord
}

function corruptMetadata(kind: string): BridgeError {
  return new BridgeError('PERSISTENCE_ERROR', `Bridge ${kind} metadata is corrupt.`, { retryable: false })
}

function bindingConflict(platformSessionId: string, externalSessionId: string): BridgeError {
  return new BridgeError('SESSION_CONFLICT', 'The platform and DSH Session binding conflicts with durable metadata.', {
    retryable: false,
    sessionId: platformSessionId,
    externalSessionId,
    details: { code: 'SESSION_BINDING_CONFLICT' },
  })
}
