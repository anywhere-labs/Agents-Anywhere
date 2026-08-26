import { createHash } from 'node:crypto'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { BridgeError } from '../wire/errors.js'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function platformSessionId(connectorId: string, externalSessionId: string): string {
  return `sess_dsh_${sha256Hex(`${connectorId}:dsh:${externalSessionId}`).slice(0, 24)}`
}

export function timelineItemId(externalSessionId: string, projectionKind: string, businessId: string): string {
  return `dsh_${sha256Hex(`${externalSessionId}\0${projectionKind}\0${businessId}`)}`
}

export function deterministicMessageId(platformId: string, clientMessageId: string): string {
  return `aa-${sha256Hex(`${platformId}\0${clientMessageId}`)}`
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('canonical JSON rejects this number')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object') throw new TypeError(`canonical JSON rejects ${typeof value}`)
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== undefined) output[key] = canonicalValue(item)
  }
  return output
}

function encodeJson(value: unknown): string {
  return Buffer.from(canonicalJson(value), 'utf8').toString('base64url')
}

export function modelSelectionId(selection: ModelSelection): string {
  return `dsh:model:${encodeJson([selection.provider, selection.model, selection.reasoningEffort ?? null])}`
}

export function permissionSelectionId(preset: string): string {
  return `dsh:permission:${Buffer.from(preset, 'utf8').toString('base64url')}`
}

export function decodeModelSelectionId(id: string): ModelSelection {
  if (!id.startsWith('dsh:model:')) throw invalidSelection()
  try {
    const encoded = id.slice('dsh:model:'.length)
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (encodeJson(parsed) !== encoded || !Array.isArray(parsed) || parsed.length !== 3) throw invalidSelection()
    const [provider, model, effort] = parsed
    if (typeof provider !== 'string' || provider.length === 0
      || typeof model !== 'string' || model.length === 0
      || (effort !== null && (typeof effort !== 'string' || effort.length === 0))) {
      throw invalidSelection()
    }
    return {
      provider,
      model,
      ...(effort === null ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    }
  } catch (error: unknown) {
    if (error instanceof BridgeError) throw error
    throw invalidSelection()
  }
}

export function decodePermissionSelectionId(id: string): string {
  if (!id.startsWith('dsh:permission:')) throw invalidSelection()
  try {
    const preset = Buffer.from(id.slice('dsh:permission:'.length), 'base64url').toString('utf8')
    if (preset.length === 0 || permissionSelectionId(preset) !== id) throw invalidSelection()
    return preset
  } catch (error: unknown) {
    if (error instanceof BridgeError) throw error
    throw invalidSelection()
  }
}

function invalidSelection(): BridgeError {
  return new BridgeError('INVALID_SELECTION', 'The selection ID is invalid or has the wrong kind.', {
    retryable: false,
  })
}
