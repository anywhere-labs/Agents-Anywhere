/**
 * AA model / permission selection IDs <-> DSH ACP config options. Both routes expose the
 * same option shapes (`model` value = JSON [provider, model], `reasoning_effort`,
 * `permission` preset), so saved AA selections survive a route switch and match the
 * v2 IDs (`dsh:model:…`, contracts/identity-vectors `selection.dshModelSelectionId`).
 */
import { dshModelSelectionId, dshPermissionSelectionId } from '../../../domain/identity/selection.js'
import type { SelectionCodec } from '../../acp/dialect.js'
import { acpSelectionId } from '../../../domain/identity/selection.js'

export interface ConfigChange { configId: string, value: string }

export function modelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

export function parseModelValue(value: string): { provider: string, model: string } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && parsed[0] && parsed[1]) {
      return { provider: parsed[0], model: parsed[1] }
    }
  } catch { /* not a DSH model value */ }
  return undefined
}

export function modelSelectionIdOf(value: string, effort: string | null): string | undefined {
  const parsed = parseModelValue(value)
  return parsed ? dshModelSelectionId(parsed.provider, parsed.model, effort) : undefined
}

function decode(selectionId: string, prefix: string): string | undefined {
  if (!selectionId.startsWith(prefix)) return undefined
  const body = selectionId.slice(prefix.length)
  if (!/^[\w-]+$/.test(body)) return undefined
  const text = Buffer.from(body, 'base64url').toString('utf8')
  return Buffer.from(text).toString('base64url') === body ? text : undefined
}

/** Config changes for one AA selection ID, in the order DSH needs them (model before effort). */
export function configChangesFor(selectionId: string): ConfigChange[] | undefined {
  const model = decode(selectionId, 'dsh:model:')
  if (model !== undefined) {
    let parts: unknown
    try { parts = JSON.parse(model) } catch { return undefined }
    if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== 'string' || typeof parts[1] !== 'string'
      || (parts[2] !== null && typeof parts[2] !== 'string')) return undefined
    if (dshModelSelectionId(parts[0], parts[1], parts[2]) !== selectionId) return undefined
    return [{ configId: 'model', value: modelValue(parts[0], parts[1]) },
      ...(parts[2] ? [{ configId: 'reasoning_effort', value: parts[2] as string }] : [])]
  }
  const preset = decode(selectionId, 'dsh:permission:')
  if (preset !== undefined && preset && dshPermissionSelectionId(preset) === selectionId) return [{ configId: 'permission', value: preset }]
  return undefined
}

/** Both routes' selection IDs (B's engine decodes by matching the current config values). */
export const DSH_SELECTIONS: SelectionCodec = {
  modelSelectionId: (model, effort) => modelSelectionIdOf(model, effort) ?? acpSelectionId(model, effort),
  permissionSelectionId: value => dshPermissionSelectionId(value),
}
