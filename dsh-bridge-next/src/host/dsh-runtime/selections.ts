import { BridgeError } from './errors.js'

export interface ModelSelection { provider: string, model: string, reasoningEffort?: string }
export interface Selections { model?: string | null, permission?: string | null }

export function modelSelectionId(selection: ModelSelection): string {
  return `dsh:model:${Buffer.from(JSON.stringify([selection.provider, selection.model, selection.reasoningEffort ?? null])).toString('base64url')}`
}

export function permissionSelectionId(preset: string): string {
  return `dsh:permission:${Buffer.from(preset).toString('base64url')}`
}

function decode(value: string, prefix: string): string {
  const body = value.slice(prefix.length)
  if (!value.startsWith(prefix) || !/^[\w-]+$/.test(body) || body.length > 16_384) {
    throw new BridgeError('INVALID_PARAMS', 'Invalid DSH selection ID.')
  }
  const text = Buffer.from(body, 'base64url').toString('utf8')
  if (Buffer.from(text).toString('base64url') !== body) throw new BridgeError('INVALID_PARAMS', 'Invalid DSH selection encoding.')
  return text
}

export function decodeModelSelection(value: string): ModelSelection {
  let parts: unknown
  try { parts = JSON.parse(decode(value, 'dsh:model:')) } catch { throw new BridgeError('INVALID_PARAMS', 'Invalid DSH model selection.') }
  if (!Array.isArray(parts) || parts.length !== 3 || !nonempty(parts[0]) || !nonempty(parts[1]) || (parts[2] !== null && !nonempty(parts[2]))) {
    throw new BridgeError('INVALID_PARAMS', 'A DSH model selection must identify provider, model and effort.')
  }
  const selection = { provider: parts[0], model: parts[1], ...(parts[2] === null ? {} : { reasoningEffort: parts[2] }) }
  if (modelSelectionId(selection) !== value) throw new BridgeError('INVALID_PARAMS', 'DSH model selection must use canonical encoding.')
  return selection
}

export function decodePermissionSelection(value: string): string {
  const preset = decode(value, 'dsh:permission:')
  if (!preset || preset === 'custom' || preset.trim() !== preset || /[\r\n]/u.test(preset)) throw new BridgeError('INVALID_PARAMS', 'Choose a switchable DSH permission preset.')
  return preset
}

export function parseSelections(value: unknown): Selections {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_PARAMS', 'Selections must be an object.')
  const selection: Selections = {}
  for (const [key, item] of Object.entries(value)) {
    if (!['model', 'permission'].includes(key) || !nonempty(item)) throw new BridgeError('INVALID_PARAMS', 'A configuration change requires a concrete selection ID.')
    if (key === 'model') { decodeModelSelection(item); selection.model = item }
    else { decodePermissionSelection(item); selection.permission = item }
  }
  return selection
}

export function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
