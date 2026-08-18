import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { deterministicMessageId, sha256Hex } from '../projection/identity.js'
import { BridgeError } from '../wire/errors.js'
import { isRecord } from '../wire/validation.js'
import {
  readJsonDirectory,
  readOptionalJson,
  writeJsonAtomic,
  writeJsonNoClobber,
} from './files.js'

/** Durable AA-to-DSH session binding. */
export interface BindingRecord {
  version: 1
  platformSessionId: string
  externalSessionId: string
}

/** Durable client-message idempotency record. */
export interface MessageRecord {
  version: 1
  platformSessionId: string
  clientMessageId: string
  operation: 'create' | 'start' | 'steer'
  contentHash: string
  messageId: string
}

/** Durable candidate Session reservation for create-and-start recovery. */
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

/** Owns bridge-only durable metadata below the configured state root. */
export class MetadataStore {
  private readonly bindingsByPlatform = new Map<string, BindingRecord>()
  private readonly bindingsByExternal = new Map<string, BindingRecord>()
  private bindingTail: Promise<void> = Promise.resolve()
  private catalogTail: Promise<void> = Promise.resolve()

  /** @param root - Validated absolute bridge state directory. */
  constructor(readonly root: string) {}

  /** Load and cross-check all durable bindings before wire startup. */
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const records = await readJsonDirectory<unknown>(join(this.root, 'bindings'))
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

  /** Resolve an existing binding by platform Session ID. */
  bindingForPlatform(platformSessionId: string): BindingRecord | undefined {
    return this.bindingsByPlatform.get(platformSessionId)
  }

  /** Resolve an existing binding by DSH Session ID. */
  bindingForExternal(externalSessionId: string): BindingRecord | undefined {
    return this.bindingsByExternal.get(externalSessionId)
  }

  /** Create a binding once, rejecting either-direction conflicts. */
  async bind(platformSessionId: string, externalSessionId: string): Promise<BindingRecord> {
    let result: BindingRecord | undefined
    const operation = this.bindingTail.then(async () => {
      result = await this.bindCore(platformSessionId, externalSessionId)
    })
    this.bindingTail = operation.catch(() => undefined)
    await operation
    return result as BindingRecord
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
    if (await writeJsonNoClobber(path, record) === 'exists') {
      const existing = bindingRecord(await readOptionalJson<unknown>(path))
      if (existing.platformSessionId !== platformSessionId || existing.externalSessionId !== externalSessionId) {
        throw bindingConflict(platformSessionId, externalSessionId)
      }
    }
    this.bindingsByPlatform.set(platformSessionId, record)
    this.bindingsByExternal.set(externalSessionId, record)
    return record
  }

  /** Reserve or recover one candidate DSH Session ID for create-and-start. */
  async reserveCreation(platformSessionId: string, clientMessageId: string): Promise<CreationRecord> {
    const path = this.path('creations', `${platformSessionId}\0${clientMessageId}`)
    const record: CreationRecord = {
      version: 1,
      platformSessionId,
      clientMessageId,
      externalSessionId: `aa-${randomUUID()}`,
      committed: false,
    }
    if (await writeJsonNoClobber(path, record) === 'created') return record
    const existing = creationRecord(await readOptionalJson<unknown>(path))
    if (existing.platformSessionId !== platformSessionId || existing.clientMessageId !== clientMessageId) {
      throw new BridgeError('PERSISTENCE_ERROR', 'The creation reservation is corrupt.', { retryable: false })
    }
    return existing
  }

  /** Mark a recovered creation reservation committed after Session durability. */
  async commitCreation(record: CreationRecord): Promise<void> {
    await writeJsonAtomic(this.path('creations', `${record.platformSessionId}\0${record.clientMessageId}`), {
      ...record,
      committed: true,
    } satisfies CreationRecord)
  }

  /** Read an idempotency record for one AA Session and client message. */
  async message(platformSessionId: string, clientMessageId: string): Promise<MessageRecord | undefined> {
    const value = await readOptionalJson<unknown>(this.path('messages', `${platformSessionId}\0${clientMessageId}`))
    return value === undefined ? undefined : messageRecord(value)
  }

  /** Publish a message record without replacing an earlier operation. */
  async recordMessage(input: Omit<MessageRecord, 'version' | 'messageId'>): Promise<{ record: MessageRecord; duplicate: boolean }> {
    const record: MessageRecord = {
      version: 1,
      ...input,
      messageId: deterministicMessageId(input.platformSessionId, input.clientMessageId),
    }
    const path = this.path('messages', `${record.platformSessionId}\0${record.clientMessageId}`)
    if (await writeJsonNoClobber(path, record) === 'created') return { record, duplicate: false }
    const existing = messageRecord(await readOptionalJson<unknown>(path))
    if (existing.operation !== record.operation
      || existing.contentHash !== record.contentHash
      || existing.messageId !== record.messageId
      || existing.platformSessionId !== record.platformSessionId
      || existing.clientMessageId !== record.clientMessageId) {
      throw new BridgeError('IDEMPOTENCY_CONFLICT', 'clientMessageId was already used for different content or an operation.', {
        retryable: false,
        sessionId: record.platformSessionId,
      })
    }
    return { record: existing, duplicate: true }
  }

  /** Return a monotonic durable revision for one canonical catalog fingerprint. */
  async catalogRevision(fingerprint: string): Promise<number> {
    let result = 0
    const operation = this.catalogTail.then(async () => {
      const path = join(this.root, 'catalog-revisions.json')
      const value = await readOptionalJson<unknown>(path)
      if (value === undefined) {
        const initial: CatalogRevisionRecord = { version: 1, revision: 1, fingerprint }
        await writeJsonAtomic(path, initial)
        result = 1
        return
      }
      const current = catalogRevisionRecord(value)
      if (current.fingerprint === fingerprint) {
        result = current.revision
        return
      }
      const revision = current.revision + 1
      await writeJsonAtomic(path, { version: 1, revision, fingerprint } satisfies CatalogRevisionRecord)
      result = revision
    })
    this.catalogTail = operation.catch(() => undefined)
    await operation
    return result
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
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) {
    throw corruptMetadata('catalog revision')
  }
  return value as unknown as CatalogRevisionRecord
}

function corruptMetadata(kind: string): BridgeError {
  return new BridgeError('PERSISTENCE_ERROR', `Bridge ${kind} metadata is corrupt.`, { retryable: false })
}

function bindingConflict(platformSessionId: string, externalSessionId: string): BridgeError {
  return new BridgeError('SESSION_BINDING_CONFLICT', 'The AA and DSH Session binding conflicts with durable metadata.', {
    retryable: false,
    sessionId: platformSessionId,
    externalSessionId,
  })
}
