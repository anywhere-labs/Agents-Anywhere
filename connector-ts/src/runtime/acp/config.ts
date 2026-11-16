// ported from effi-crew cloud/agentd/src/conv/session-config.ts @30f8334
//
// 一个 ACP Agent 的会话设置（模式、模型、思考强度…），整理成端口里的 ConfigOption 列表。
// 来源优先级：
//   1. `configOptions`（session/new|load|resume 响应、`config_option_update`、`session/set_config_option` 响应）；
//   2. 旧的 `modes`（→ id "mode"，用 `session/set_mode` 设置，`current_mode_update` 更新）与不稳定的
//      `models`（→ id "model"，用 `session/set_model` 设置），给没有 (1) 的 Agent。
// 与 agentd 的差别：category 映射到 AA 的 model / effort / permission / mode / collaboration_mode / other；
// 布尔项保留布尔值（端口的 ConfigOption.type = 'boolean'）。

import type { ConfigOption } from '../../application/ports/runtime-session.js'
import { fail } from './errors.js'
import { asRecord, type JsonRecord } from './client.js'

/** 一个设置怎么下发给 Agent。 */
export type ConfigApply = 'option' | 'boolean' | 'set_mode' | 'set_model'

export interface NormalizedConfig {
  readonly options: ConfigOption[]
  /** config id → 下发方式。 */
  readonly apply: Record<string, ConfigApply>
  /** Agent 给了 configOptions（此时忽略旧的 modes / models）。 */
  readonly native: boolean
}

/** session/new|load|resume 响应里关于设置的部分。 */
export interface AgentConfigState {
  readonly configOptions?: unknown
  readonly modes?: unknown
  readonly models?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** ACP category（以及常见的 id）→ AA 目录类别。方言可以在 normalize 之后再改。 */
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

/** 整理一个 ACP 配置项；看不懂的形状返回 undefined。 */
export function fromConfigOption(raw: unknown): { option: ConfigOption; apply: ConfigApply } | undefined {
  const option = asRecord(raw)
  const id = text(option.id)
  if (id === undefined) return undefined
  const description = text(option.description)
  // ACP 的 category 是保留枚举；AA 自己的类别放在 `_meta.aa.selectionCategory`（v2 ConfigurationService.observe）。
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
 * 旧的 session modes 以什么配置项出现。缺省是 `mode` / Mode / mode 类别，且只在 Agent 没给 configOptions 时出现；
 * 方言给了这个说明时，即使有 configOptions，只要其中没有同类别的项，也把 modes 补成一项（v2 Command Code 把权限放在 modes 里）。
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

/** 会话报告的设置。`configOptions` 优先于旧的 modes / models。 */
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

/** 按 id 找设置；找不到时按 AA 类别找第一个（不同 Agent 的 id 不同时，选择仍能落到对应的选择器上）。 */
export function findOption(config: readonly ConfigOption[], id: string): ConfigOption | undefined {
  return config.find(o => o.id === id) ?? config.find(o => o.category === id)
}

/** `value` 不是 `id` 的合法选择时的原因；合法时 undefined。 */
export function choiceError(config: readonly ConfigOption[], id: string, value: string | boolean): string | undefined {
  const option = findOption(config, id)
  if (option === undefined) return `unknown setting ${id} (available: ${config.map(o => o.id).join(', ') || 'none'})`
  if (option.type === 'boolean') return typeof value === 'boolean' || value === 'true' || value === 'false' ? undefined : `${option.name} takes true or false`
  if (!option.values?.some(o => o.value === value)) {
    return `${option.name} has no value ${String(value)} (available: ${option.values?.map(o => o.value).join(', ') ?? ''})`
  }
  return undefined
}

/** `config` 的副本，`id` 的当前值改成 `value`（未知 id 不变）。 */
export function withCurrent(config: readonly ConfigOption[], id: string, value: string | boolean): ConfigOption[] {
  return config.map(o => (o.id === id ? { ...o, currentValue: value } : o))
}

export function sameConfig(a: readonly ConfigOption[], b: readonly ConfigOption[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const SELECTION_PREFIX = 'acp-selection:'

/** acp/domain/catalogs.py `decode_selection`：模型选择 ID 可能同时编码了推理强度。 */
export function decodeAcpSelection(value: string): { model: string; effort?: string } {
  if (!value.startsWith(SELECTION_PREFIX)) return { model: value }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(SELECTION_PREFIX.length), 'base64url').toString('utf8'))
    if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
      return { model: decoded[0], effort: decoded[1] }
    }
  } catch {
    // 落到下面的错误
  }
  fail('invalid_selection', '模型与推理强度选择无效。')
}


/**
 * acp/domain/configuration.py `merge_legacy`：按类别给出的初始选择（model / effort / permission…）
 * 落到会话配置项上。每个类别必须恰好对应一个配置项，值必须在可选范围内。返回按类别顺序的赋值。
 */
export function selectionsToConfig(config: readonly ConfigOption[], selections: Readonly<Record<string, string | null>>): Array<{ optionId: string; value: string }> {
  const flat: Record<string, string | null> = { ...selections }
  const model = flat.model
  if (model !== undefined && model !== null) {
    const decoded = decodeAcpSelection(model)
    if (decoded.effort !== undefined && flat.effort !== undefined && flat.effort !== null && flat.effort !== decoded.effort) {
      fail('configuration_conflict', '模型选择与推理强度不一致。')
    }
    flat.model = decoded.model
    if (decoded.effort !== undefined) flat.effort = decoded.effort
  }
  const out: Array<{ optionId: string; value: string }> = []
  for (const [category, value] of Object.entries(flat)) {
    if (value === null || value === undefined) continue
    const matches = config.filter(option => option.category === category)
    if (matches.length !== 1) fail('configuration_mapping_unavailable', '该选择没有唯一且无损的 Agent 配置映射。')
    const option = matches[0]!
    if (choiceError(config, option.id, value) !== undefined) fail('invalid_configuration_value', '配置值不在当前可用范围。')
    out.push({ optionId: option.id, value })
  }
  return out
}

/**
 * 用 Agent 新报告的完整配置替换当前配置：由旧 modes / models 得来的项（`set_mode` / `set_model`）
 * 不在 configOptions 里，新列表没有它们时保留原样，直到 Agent 报告新的 modes 状态。
 */
export function replaceConfig(current: NormalizedConfig, next: NormalizedConfig): NormalizedConfig {
  const kept = current.options.filter(o => (current.apply[o.id] === 'set_mode' || current.apply[o.id] === 'set_model')
    && next.apply[o.id] === undefined && !next.options.some(n => n.category === o.category))
  const apply: Record<string, ConfigApply> = { ...next.apply }
  for (const option of kept) apply[option.id] = current.apply[option.id]!
  return { options: [...next.options, ...kept], apply, native: next.native }
}
