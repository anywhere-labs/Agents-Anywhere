// The machine-wide Connector record `~/.agents-anywhere/connector-runtime.json` (contracts/local-machine/2.0), with
// the reading, validation and legacy folding of v2 connector/core/runtime_owner.py. Unknown fields are kept as
// they are; a damaged record or an unknown version is an error and is never overwritten.
import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { withMachineStateLock } from './state-lock.js'

export interface RuntimeOwnerRecord {
  instanceId: string
  kind: string
  pid: number
  startedAt: string
  processStartedAt?: string
  childPid?: number
  childStartedAt?: string
  connectorId?: string
  serverUrl?: string
  /** v3: the Connector version and the newest local-store schema it opens (version arbitration). */
  connectorVersion?: string
  schemaVersion?: number
  /** v3: digest of the owner's command line, so a reused pid is not taken for it. */
  commandDigest?: string
  [key: string]: unknown
}

export interface RuntimeState {
  version: 2
  connectorIds: string[]
  runtime?: RuntimeOwnerRecord
  legacyMachineMigrated?: boolean
  [key: string]: unknown
}

export class RuntimeRecordError extends Error {
  public readonly code = 'runtime_record_invalid'
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new RuntimeRecordError('Cannot read the local Connector record. Check its format and permissions.')
  }
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    throw new RuntimeRecordError('Cannot read the local Connector record. Check its format and permissions.')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeRecordError('Invalid local Connector record.')
  return value as Record<string, unknown>
}

function ids(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.trim() === '')) throw new RuntimeRecordError('Invalid local Connector IDs.')
  return [...new Set((value as string[]).map(v => v.trim()))]
}

function validOwner(value: unknown): RuntimeOwnerRecord {
  const owner = value as Partial<RuntimeOwnerRecord> | null
  const positive = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0
  if (
    owner === null || typeof owner !== 'object' || !positive(owner.pid) || typeof owner.kind !== 'string'
    || typeof owner.instanceId !== 'string' || owner.instanceId === '' || typeof owner.startedAt !== 'string'
    || ('childPid' in owner && !positive(owner.childPid))
    || (['processStartedAt', 'childStartedAt'] as const).some(key => key in owner && typeof owner[key] !== 'string')
  ) {
    throw new RuntimeRecordError('Invalid local Connector owner.')
  }
  return owner as RuntimeOwnerRecord
}

/** Reads the record (an empty v2 record when there is none), upgrading the pre-v2 single-owner form. */
export async function readRuntimeState(path: string): Promise<RuntimeState> {
  const value = await readJson(path)
  if (value === null) return { version: 2, connectorIds: [] }
  if (!('version' in value) && Number.isInteger(value.pid) && typeof value.kind === 'string') {
    const owner = validOwner({ ...value, instanceId: `legacy-${String(value.pid)}`, startedAt: typeof value.startedAt === 'string' ? value.startedAt : '' })
    return { version: 2, connectorIds: typeof value.connectorId === 'string' && value.connectorId !== '' ? [value.connectorId] : [], runtime: owner }
  }
  if (value.version !== 2) throw new RuntimeRecordError('Unsupported local Connector record version.')
  const state = { ...value, version: 2, connectorIds: ids(value.connectorIds) } as RuntimeState
  if ('runtime' in value) validOwner(value.runtime)
  return state
}

async function writeState(path: string, state: RuntimeState): Promise<void> {
  const contents = `${JSON.stringify(state, null, 2)}\n`
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current === contents) return
  const temporary = join(dirname(path), `${path.split(/[\\/]/u).pop()!}.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Reads, changes and atomically replaces the record inside the shared short file transaction. Legacy
 * `~/.agentsanywhere/machine.json` and `desktop/install.json` are folded in once, as v2 does.
 */
export async function runtimeTransaction<T>(path: string, update: (state: RuntimeState) => T | Promise<T>): Promise<T> {
  return withMachineStateLock(path, async () => {
    let state = await readRuntimeState(path)
    const legacy = join(dirname(dirname(path)), '.agentsanywhere', 'machine.json')
    const installation = join(dirname(legacy), 'desktop', 'install.json')
    const [machine, desktop] = state.legacyMachineMigrated === true ? [null, null] : await Promise.all([readJson(legacy), readJson(installation)])
    if (machine === null && desktop === null) {
      state.legacyMachineMigrated = true
      const result = await update(state)
      await writeState(path, state)
      return result
    }
    return withMachineStateLock(legacy, async () => {
      if (machine !== null && machine.version !== 1) throw new RuntimeRecordError('Unsupported legacy machine record version.')
      if (desktop !== null && desktop.version !== 1) throw new RuntimeRecordError('Unsupported legacy installation record version.')
      if (machine !== null) state = { ...machine, ...state, version: 2, connectorIds: [...new Set([...ids(machine.connectorIds), ...state.connectorIds])] }
      if (!('desktop' in state) && desktop !== null) state.desktop = desktop
      state.legacyMachineMigrated = true
      const result = await update(state)
      await writeState(path, state)
      if (machine !== null) await unlink(legacy).catch(() => undefined)
      if (desktop !== null) await unlink(installation).catch(() => undefined)
      return result
    })
  })
}
