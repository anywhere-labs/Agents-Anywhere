import { IdentityInputError } from './errors.js'
import { base64UrlNoPad, base64UrlPadded, sha256Bytes, utf8Strict } from './hash.js'
import { pythonJsonDumps, type JsonValue } from './python-json.js'

/**
 * server/protocol.py `protocol_selection_id`:
 * `sel_{type}_{base64url(sha256("1:runtime:type:" + canonicalJson(identity)))[:24]}`.
 */
export function protocolSelectionId(runtime: string, catalogType: string, identity: JsonValue): string {
  const canonical = pythonJsonDumps(identity, { sortKeys: true, ensureAscii: false, allowNan: true })
  const digest = base64UrlNoPad(sha256Bytes(`1:${runtime}:${catalogType}:${canonical}`))
  return `sel_${catalogType}_${digest.slice(0, 24)}`
}

/** custom_models.py `custom_model_selection_id`. */
export function customModelSelectionId(runtime: string, modelId: string, effortId: string | null = null): string {
  let identity: JsonValue
  if (runtime === 'codex') identity = { model_id: modelId, reasoning_id: effortId }
  else if (effortId !== null) identity = { model_id: modelId, effort_id: effortId }
  else identity = { model_id: modelId }
  return protocolSelectionId(runtime, 'model', identity)
}

/** claude/domain/models.py: model items use {model_id}, effort items {model_id, effort_id}. */
export function claudeModelSelectionId(modelId: string, effortId: string | null = null): string {
  return customModelSelectionId('claude', modelId, effortId)
}

/** claude/domain/permissions.py `_selection_id`. */
export function claudePermissionSelectionId(permissionId: string): string {
  return protocolSelectionId('claude', 'permission', { permission_id: permissionId })
}

/** codex/domain/catalogs.py: models always carry reasoning_id (null when the model has no efforts). */
export function codexModelSelectionId(modelId: string, reasoningId: string | null): string {
  return protocolSelectionId('codex', 'model', { model_id: modelId, reasoning_id: reasoningId })
}

/** codex/domain/catalogs.py: a static permission's own identity object, else {permission_id}. */
export function codexPermissionSelectionId(permissionId: string, identity?: { [key: string]: JsonValue }): string {
  return protocolSelectionId('codex', 'permission', identity ?? { permission_id: permissionId })
}

/** dsh/identity.py `model_selection_id`. */
export function dshModelSelectionId(provider: string, model: string, effort: string | null): string {
  if (!provider || !model || (effort !== null && !effort)) {
    throw new IdentityInputError('model selection components must not be empty')
  }
  const encoded = pythonJsonDumps([provider, model, effort], { sortKeys: false, ensureAscii: false })
  return `dsh:model:${base64UrlNoPad(utf8Strict(encoded))}`
}

/** dsh/identity.py `permission_selection_id`. */
export function dshPermissionSelectionId(preset: string): string {
  if (!preset) throw new IdentityInputError('permission preset must not be empty')
  return `dsh:permission:${base64UrlNoPad(utf8Strict(preset))}`
}

/**
 * acp/domain/catalogs.py `selection_id`: unlike every other rule it uses Python's default
 * `ensure_ascii=True` and keeps base64 '=' padding.
 */
export function acpSelectionId(model: string | null, effort: string | null): string {
  const encoded = pythonJsonDumps([model, effort], { sortKeys: false, ensureAscii: true })
  return `acp-selection:${base64UrlPadded(Buffer.from(encoded, 'ascii'))}`
}
