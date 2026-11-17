// ported from effi-crew cloud/agentd/src/conv/session-config.ts @30f8334 (ACP config option normalization)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/catalogs.py @98dd0e6e5 (decode_selection)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/configuration.py @98dd0e6e5 (merge_legacy)
//
// The session settings of an ACP Agent (mode, model, reasoning effort...), organized as the port's ConfigOption list.
// Source precedence:
//   1. `configOptions` (session/new|load|resume responses, `config_option_update`, `session/set_config_option` responses);
//   2. legacy `modes` (-> id "mode", set with `session/set_mode`, updated by `current_mode_update`) and unstable
//      `models` (-> id "model", set with `session/set_model`), for Agents without (1).
// Categories map to the AA model / effort / permission / mode / collaboration_mode / other categories;
// boolean options stay boolean (port ConfigOption.type = 'boolean').

import type { ConfigOption } from '../../application/ports/runtime-session.js'
import type { SelectionCodec } from './dialect.js'
import { fail } from './errors.js'
import { asRecord, type JsonRecord } from './client.js'

/** How a setting is sent to the Agent. */
export type ConfigApply = 'option' | 'boolean' | 'set_mode' | 'set_model'

export interface NormalizedConfig {
  readonly options: ConfigOption[]
  /** config id -> how it is sent. */
  readonly apply: Record<string, ConfigApply>
  /** The Agent sent configOptions (legacy modes / models are then ignored). */
  readonly native: boolean
}

/** The settings part of a session/new|load|resume response. */
export interface AgentConfigState {
  readonly configOptions?: unknown
  readonly modes?: unknown
  readonly models?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** ACP category (and common ids) -> AA catalog category. Dialects can adjust it after normalize. */
export function aaCategory(category: string | undefined, id: string): ConfigOption['category'] {
  switch (category) {
    case 'model':
      return 'model'
    case 'thought_level':
    case 'effort':
      return 'effort'
    case 'mode':
      return id === 'collaboration_mode' ? 'collaboration_mode' : 'mode'
    case 'collaboration_mode':
      return 'collaboration_mode'
    case 'permission':
      return 'permission'
    default:
      if (id === 'model') return 'model'
      if (id === 'mode') return 'mode'
      if (id === 'reasoning_effort' || id === 'effort' || id === 'thought_level') return 'effort'
      if (id === 'collaboration_mode') return 'collaboration_mode'
      return 'other'
  }
}

function selectValues(options: unknown[]): NonNullable<ConfigOption['values']>[number][] {
  const out: NonNullable<ConfigOption['values']>[number][] = []
  for (const raw of options) {
    const entry = asRecord(raw)
    if (Array.isArray(entry.options)) {
      const group = text(entry.name) ?? text(entry.group)
      for (const nested of entry.options) out.push(value(asRecord(nested), group))
    } else {
      out.push(value(entry))
    }
  }
  return out.filter(v => v.value !== '')
}

function value(o: JsonRecord, group?: string): NonNullable<ConfigOption['values']>[number] {
  const description = text(o.description)
  const v = typeof o.value === 'string' ? o.value : ''
  return {
    value: v,
    name: text(o.name) ?? v,
    ...(description !== undefined ? { description } : {}),
    ...(group !== undefined ? { group } : {}),
  }
}

/** Normalizes one ACP config option; returns undefined for shapes it does not understand. */
export function fromConfigOption(raw: unknown): { option: ConfigOption; apply: ConfigApply } | undefined {
  const option = asRecord(raw)
  const id = text(option.id)
  if (id === undefined) return undefined
  const description = text(option.description)
  // ACP's category is a reserved enum; AA's own category lives in `_meta.aa.selectionCategory`.
  const declared = text(asRecord(asRecord(option._meta).aa).selectionCategory)
  const head = {
    id,
    name: text(option.name) ?? id,
    ...(description !== undefined ? { description } : {}),
    category: declared === 'model' || declared === 'permission' || declared === 'effort' ? declared : aaCategory(text(option.category), id),
  }
  if (option.type === 'boolean' || typeof option.currentValue === 'boolean') {
    return { option: { ...head, type: 'boolean', currentValue: option.currentValue === true }, apply: 'boolean' }
  }
  if (typeof option.currentValue !== 'string' || !Array.isArray(option.options)) return undefined
  return { option: { ...head, type: 'select', currentValue: option.currentValue, values: selectValues(option.options) }, apply: 'option' }
}

/**
 * How legacy session modes appear as a config option. By default as `mode` / Mode / the mode category, and only when
 * the Agent sent no configOptions. When the dialect provides this description, modes are added as an option even
 * alongside configOptions, as long as none of them has the same category (Command Code puts permissions in modes).
 */
export interface LegacyModesSpec {
  readonly id: string
  readonly name: string
  readonly category: ConfigOption['category']
}

const DEFAULT_MODES: LegacyModesSpec = { id: 'mode', name: 'Mode', category: 'mode' }

export function fromModes(raw: unknown, spec: LegacyModesSpec = DEFAULT_MODES): ConfigOption | undefined {
  const modes = asRecord(raw)
  if (!Array.isArray(modes.availableModes) || modes.availableModes.length === 0 || typeof modes.currentModeId !== 'string') return undefined
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    type: 'select',
    currentValue: modes.currentModeId,
    values: modes.availableModes.map(asRecord).map(m => {
      const description = text(m.description)
      const id = typeof m.id === 'string' ? m.id : ''
      return { value: id, name: text(m.name) ?? id, ...(description !== undefined ? { description } : {}) }
    }),
  }
}

export function fromModels(raw: unknown): ConfigOption | undefined {
  const models = asRecord(raw)
  if (!Array.isArray(models.availableModels) || models.availableModels.length === 0 || typeof models.currentModelId !== 'string') return undefined
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: models.currentModelId,
    values: models.availableModels.map(asRecord).map(m => {
      const description = text(m.description)
      const id = typeof m.modelId === 'string' ? m.modelId : ''
      return { value: id, name: text(m.name) ?? id, ...(description !== undefined ? { description } : {}) }
    }),
  }
}

/** The settings the session reports. `configOptions` take precedence over legacy modes / models. */
export function normalizeConfig(state: AgentConfigState | null | undefined, legacyModes?: LegacyModesSpec): NormalizedConfig {
  const options: ConfigOption[] = []
  const apply: Record<string, ConfigApply> = {}
  if (Array.isArray(state?.configOptions)) {
    for (const raw of state.configOptions) {
      const n = fromConfigOption(raw)
      if (n === undefined || apply[n.option.id] !== undefined) continue
      options.push(n.option)
      apply[n.option.id] = n.apply
    }
    const mode = legacyModes && !options.some(o => o.category === legacyModes.category) ? fromModes(state.modes, legacyModes) : undefined
    if (mode && apply[mode.id] === undefined) {
      options.push(mode)
      apply[mode.id] = 'set_mode'
    }
    return { options, apply, native: true }
  }
  const spec = legacyModes ?? DEFAULT_MODES
  const mode = fromModes(state?.modes, spec)
  if (mode) {
    options.push(mode)
    apply[spec.id] = 'set_mode'
  }
  const model = fromModels(state?.models)
  if (model) {
    options.push(model)
    apply.model = 'set_model'
  }
  return { options, apply, native: false }
}

/** Finds a setting by id; otherwise the first one in the AA category (so a selection still lands on the matching picker when Agents use different ids). */
export function findOption(config: readonly ConfigOption[], id: string): ConfigOption | undefined {
  return config.find(o => o.id === id) ?? config.find(o => o.category === id)
}

/** Why `value` is not a valid choice for `id`; undefined when it is valid. */
export function choiceError(config: readonly ConfigOption[], id: string, value: string | boolean): string | undefined {
  const option = findOption(config, id)
  if (option === undefined) return `unknown setting ${id} (available: ${config.map(o => o.id).join(', ') || 'none'})`
  if (option.type === 'boolean') return typeof value === 'boolean' || value === 'true' || value === 'false' ? undefined : `${option.name} takes true or false`
  if (!option.values?.some(o => o.value === value)) {
    return `${option.name} has no value ${String(value)} (available: ${option.values?.map(o => o.value).join(', ') ?? ''})`
  }
  return undefined
}

/** A copy of `config` with the current value of `id` set to `value` (unknown ids are left unchanged). */
export function withCurrent(config: readonly ConfigOption[], id: string, value: string | boolean): ConfigOption[] {
  return config.map(o => (o.id === id ? { ...o, currentValue: value } : o))
}

export function sameConfig(a: readonly ConfigOption[], b: readonly ConfigOption[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const SELECTION_PREFIX = 'acp-selection:'

/** A model selection ID may also encode the reasoning effort. */
export function decodeAcpSelection(value: string): { model: string; effort?: string } {
  if (!value.startsWith(SELECTION_PREFIX)) return { model: value }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(SELECTION_PREFIX.length), 'base64url').toString('utf8'))
    if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
      return { model: decoded[0], effort: decoded[1] }
    }
  } catch {
    // fall through to the error below
  }
  fail('invalid_selection', '模型与推理强度选择无效。')
}


/**
 * Applies initial per-category selections (model / effort / permission...) to the session config options.
 * Each category must map to exactly one option, and the value must be within the allowed range. Returns the
 * assignments in category order.
 */
export function selectionsToConfig(config: readonly ConfigOption[], selections: Readonly<Record<string, string | null>>, codec?: SelectionCodec): Array<{ optionId: string; value: string }> {
  const flat: Record<string, string | null> = { ...selections }
  const model = flat.model
  if (model !== undefined && model !== null) {
    const decoded = codec ? decodeModelSelection(config, model, codec) : decodeAcpSelection(model)
    if (decoded.effort !== undefined && flat.effort !== undefined && flat.effort !== null && flat.effort !== decoded.effort) {
      fail('configuration_conflict', '模型选择与推理强度不一致。')
    }
    flat.model = decoded.model
    if (decoded.effort !== undefined) flat.effort = decoded.effort
  }
  const out: Array<{ optionId: string; value: string }> = []
  for (const [category, value] of Object.entries(flat)) {
    if (value === null || value === undefined) continue
    const permission = category === 'permission' && codec ? decodePermissionSelection(config, value, codec) : undefined
    const matches = config.filter(option => option.category === category)
    if (matches.length !== 1) fail('configuration_mapping_unavailable', '该选择没有唯一且无损的 Agent 配置映射。')
    const option = matches[0]!
    const resolved = permission ?? value
    if (choiceError(config, option.id, resolved) !== undefined) fail('invalid_configuration_value', '配置值不在当前可用范围。')
    out.push({ optionId: option.id, value: resolved })
  }
  return out
}

function decodeModelSelection(config: readonly ConfigOption[], selectionId: string, codec: SelectionCodec): { model: string; effort?: string } {
  const models = config.find(o => o.category === 'model' && o.type === 'select')?.values ?? []
  const efforts = config.find(o => o.category === 'effort' && o.type === 'select')?.values ?? []
  for (const model of models) {
    if (codec.modelSelectionId(model.value, null) === selectionId) return { model: model.value }
    for (const effort of efforts) if (codec.modelSelectionId(model.value, effort.value) === selectionId) return { model: model.value, effort: effort.value }
  }
  return fail('invalid_selection', '模型选择不在当前可用范围。')
}

function decodePermissionSelection(config: readonly ConfigOption[], selectionId: string, codec: SelectionCodec): string {
  for (const value of config.find(o => o.category === 'permission' && o.type === 'select')?.values ?? []) {
    if (codec.permissionSelectionId(value.value) === selectionId) return value.value
  }
  return fail('invalid_selection', '权限选择不在当前可用范围。')
}

/**
 * Replaces the current config with the full config the Agent just reported: options derived from legacy
 * modes / models (`set_mode` / `set_model`) are not in configOptions, so they are kept as they are when the new list
 * lacks them, until the Agent reports a new modes state.
 */
export function replaceConfig(current: NormalizedConfig, next: NormalizedConfig): NormalizedConfig {
  const kept = current.options.filter(o => (current.apply[o.id] === 'set_mode' || current.apply[o.id] === 'set_model')
    && next.apply[o.id] === undefined && !next.options.some(n => n.category === o.category))
  const apply: Record<string, ConfigApply> = { ...next.apply }
  for (const option of kept) apply[option.id] = current.apply[option.id]!
  return { options: [...next.options, ...kept], apply, native: next.native }
}
