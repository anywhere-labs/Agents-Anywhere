import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { modelSelectionId, permissionSelectionId } from './selections.js'
import { BridgeError } from './errors.js'

export interface ReasoningItem { id: string, title: string, selectionId: string, enabled: boolean, description?: string }
export interface ModelItem {
  id: string, title: string, selectionId: string, enabled: boolean, disabledReason?: string, description?: string,
  reasoningItems: ReasoningItem[], metadata: { provider: string, providerName: string, model: string, modelName: string, reasoningEffort: null },
}
export interface ModelCatalog {
  runtime: 'dsh', revision: number, models: ModelItem[],
  metadata: { failures: { provider: string, name: string, message: string }[], routableProviders: string[] },
}

/** The AA directory intentionally never reads DSH's remembered selections. */
export class RuntimeCatalogs {
  private generation = 0
  private loadedAt = 0
  private pending: Promise<ModelCatalog> | undefined
  private cached: ModelCatalog | undefined
  private fingerprint = ''
  constructor(private ctx: Context, private changed: () => void) {}

  invalidate(): void { this.loadedAt = 0; this.generation++; this.changed() }

  models(force = false): Promise<ModelCatalog> {
    if (this.pending) return this.pending
    if (!force && this.cached && Date.now() - this.loadedAt < 5_000) return Promise.resolve(this.cached)
    const generation = this.generation
    const pending = this.readModels().then(catalog => {
      const fingerprint = JSON.stringify({ models: catalog.models, metadata: catalog.metadata })
      const changed = fingerprint !== this.fingerprint
      catalog.revision = changed ? Math.max(Date.now(), (this.cached?.revision ?? 0) + 1) : this.cached!.revision
      this.fingerprint = fingerprint; this.cached = catalog
      if (generation === this.generation) this.loadedAt = Date.now()
      if (changed) this.changed()
      return catalog
    }).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  private async readModels(): Promise<ModelCatalog> {
    const llm = this.ctx.get('llm')
    if (!llm) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH model service is unavailable.')
    const providers = llm.listProviders()
    const failures: ModelCatalog['metadata']['failures'] = []
    const groups = await Promise.all(providers.map(async provider => {
      try {
        const models = await llm.listModels(provider.id)
        return await Promise.all(models.map(async model => {
          const selection = { provider: provider.id, model: model.id }
          const entry: ModelItem = {
            id: modelSelectionId(selection), title: model.name || model.id, selectionId: modelSelectionId(selection), enabled: true,
            ...(model.description ? { description: model.description } : {}), reasoningItems: [],
            metadata: { provider: provider.id, providerName: provider.name || provider.id, model: model.id, modelName: model.name || model.id, reasoningEffort: null },
          }
          try {
            const info = await llm.resolveModelInfo(provider.id, model.id)
            entry.reasoningItems = (info.reasoning?.efforts ?? []).map(effort => ({
              id: effort.id, title: effort.name || effort.id, enabled: true,
              selectionId: modelSelectionId({ ...selection, reasoningEffort: effort.id }),
              ...(effort.description ? { description: effort.description } : {}),
            }))
          } catch {
            entry.enabled = false; entry.disabledReason = 'DSH could not read this model’s capabilities.'
          }
          return entry
        }))
      } catch {
        const message = 'DSH could not load this provider’s models. Refresh to retry.'
        failures.push({ provider: provider.id, name: provider.name, message })
        return (this.cached?.models.filter(item => item.metadata.provider === provider.id) ?? []).map(item => ({ ...item, enabled: false, disabledReason: message }))
      }
    }))
    const models = groups.flat()
    labelModels(models)
    return { runtime: 'dsh', revision: 0, models, metadata: { failures, routableProviders: providers.map(provider => provider.id) } }
  }

  permissions() {
    const service = this.ctx.get('permissionPresets')
    if (!service) throw new BridgeError('UNSUPPORTED_OPERATION', 'This DSH deployment does not provide permission presets.')
    return { runtime: 'dsh', revision: 3, permissions: service.names.map(preset => {
      const option = service.optionOf(preset)
      return { id: permissionSelectionId(preset), title: option.name, selectionId: permissionSelectionId(preset),
        description: option.description, enabled: true, metadata: { preset } }
    }) }
  }

  async agentPresets() {
    const service = this.ctx.get('agentPresets')
    if (!service) throw new BridgeError('UNSUPPORTED_OPERATION', 'This DSH deployment does not provide Agent presets.')
    const presets = (await service.list()).map(preset => ({
      id: preset.id, name: preset.name || preset.id, description: preset.description,
      enabled: !preset.broken, disabledReason: preset.broken,
    }))
    const initial = presets.some(preset => preset.id === 'standard' && preset.enabled) ? 'standard' : undefined
    return { runtime: 'dsh', revision: 3, presets,
      configField: { type: 'string', minLength: 1, title: '新会话默认模式',
        description: '仅用于以后创建的会话，已有会话保持原模式。',
        ...(initial ? { default: initial } : {}),
        enum: presets.map(preset => preset.id) },
      uiField: { component: 'select', options: presets.map(preset => ({ value: preset.id, label: preset.name,
        description: preset.description, disabled: !preset.enabled, disabledReason: preset.disabledReason })) },
    }
  }
}

/** Label the full directory before search/pagination so filtering cannot change identities or labels. */
export function labelModels(models: ModelItem[]): void {
  for (const item of models) {
    const { provider, providerName, model, modelName } = item.metadata
    const sameName = models.filter(candidate => candidate.metadata.modelName === modelName)
    const multipleProviders = sameName.some(candidate => candidate.metadata.provider !== provider)
    const duplicateProviderName = sameName.some(candidate => candidate.metadata.provider !== provider && candidate.metadata.providerName === providerName)
    const duplicateModelName = sameName.some(candidate => candidate.metadata.provider === provider && candidate.metadata.model !== model)
    const routeLabel = duplicateProviderName ? `${providerName} / ${provider}` : providerName
    item.title = `${modelName}${multipleProviders ? `（${routeLabel}）` : ''}${duplicateModelName ? ` [${model}]` : ''}`
  }
}
