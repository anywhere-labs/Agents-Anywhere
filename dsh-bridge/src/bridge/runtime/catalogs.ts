import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { contentHash, decodeModelSelectionId, decodePermissionSelectionId, modelSelectionId, permissionSelectionId } from '../projection/identity.js'
import type { MetadataStore } from '../persistence/metadata.js'
import { BridgeError } from '../wire/errors.js'
import type { ModelCatalogItem, PermissionCatalogItem } from '../wire/protocol.js'

/** Immutable model and permission catalogs plus their durable revision. */
export interface CatalogSnapshot {
  revision: number
  models: ModelCatalogItem[]
  permissions: PermissionCatalogItem[]
}

/** Builds, validates, and fingerprints catalogs from mounted DSH services. */
export class CatalogManager {
  private snapshot: CatalogSnapshot | undefined
  private refreshPromise: Promise<CatalogSnapshot> | undefined

  /**
   * @param ctx - Bridge context with llm/default-model/permission services.
   * @param metadata - Durable catalog revision owner.
   */
  constructor(private readonly ctx: Context, private readonly metadata: MetadataStore) {}

  /** Return the current snapshot, refreshing it once when absent. */
  async current(): Promise<CatalogSnapshot> {
    return this.snapshot ?? await this.refresh()
  }

  /** Rebuild both catalogs and advance the revision only on semantic change. */
  async refresh(): Promise<CatalogSnapshot> {
    if (this.refreshPromise !== undefined) return await this.refreshPromise
    const operation = this.build()
    this.refreshPromise = operation
    try {
      const snapshot = await operation
      this.snapshot = snapshot
      return snapshot
    } finally {
      this.refreshPromise = undefined
    }
  }

  /** Resolve a model selection ID against the current enabled catalog. */
  async resolveModel(id: string): Promise<ModelSelection> {
    const decoded = decodeModelSelectionId(id)
    const snapshot = await this.current()
    const item = snapshot.models.find(candidate => candidate.selectionId === id)
    if (item === undefined || !item.enabled) throw invalidSelection('model')
    return decoded
  }

  /** Resolve and validate the configured default model. */
  async defaultModel(): Promise<ModelSelection> {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return await this.resolveModel(modelSelectionId(selection))
  }

  /** Resolve a permission selection ID against switchable presets. */
  async resolvePermission(id: string): Promise<string> {
    const preset = decodePermissionSelectionId(id)
    const snapshot = await this.current()
    if (!snapshot.permissions.some(item => item.selectionId === id && item.enabled)) throw invalidSelection('permission')
    return preset
  }

  /** Encode the effective permission of an existing Session log. */
  permissionFor(events: Parameters<Context['permissionPresets']['current']>[0]): string {
    return permissionSelectionId(this.ctx.permissionPresets.current(events))
  }

  private async build(): Promise<CatalogSnapshot> {
    const models: ModelCatalogItem[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      const listed = await this.ctx.llm.listModels(provider.id)
      for (const model of listed) {
        const resolved = await this.ctx.llm.resolveModelInfo(provider.id, model.id)
        models.push(...modelItems(resolved))
      }
    }
    const permissions = this.ctx.permissionPresets.names.map((preset): PermissionCatalogItem => {
      const option = this.ctx.permissionPresets.optionOf(preset)
      return {
        selectionId: permissionSelectionId(preset),
        preset,
        name: option.name,
        ...(option.description === undefined ? {} : { description: option.description }),
        enabled: true,
      }
    })
    const custom = this.ctx.permissionPresets.optionOf('custom')
    permissions.push({
      selectionId: permissionSelectionId('custom'),
      preset: 'custom',
      name: custom.name,
      ...(custom.description === undefined ? {} : { description: custom.description }),
      enabled: false,
    })
    const fingerprint = contentHash({ models, permissions })
    const revision = await this.metadata.catalogRevision(fingerprint)
    return { revision, models, permissions }
  }
}

function modelItems(info: LlmResolvedModelInfo): ModelCatalogItem[] {
  const modalities = info.inputModalities?.map(String)
  const enabled = modalities === undefined || modalities.includes('text')
  const common = {
    provider: info.provider,
    model: info.id,
    description: info.description,
    enabled,
    disabledReason: enabled ? undefined : 'This bridge version supports text input only.',
    contextWindow: info.context?.contextWindow,
    inputModalities: modalities,
  }
  const selections: ModelSelection[] = [
    { provider: info.provider, model: info.id },
    ...(info.reasoning?.efforts ?? []).map(effort => ({
      provider: info.provider,
      model: info.id,
      reasoningEffort: effort.id,
    })),
  ]
  return selections.map((selection) => {
    const effort = info.reasoning?.efforts.find(candidate => candidate.id === selection.reasoningEffort)
    return {
      selectionId: modelSelectionId(selection),
      provider: common.provider,
      model: common.model,
      reasoningEffort: selection.reasoningEffort === undefined ? null : String(selection.reasoningEffort),
      name: effort === undefined ? info.name : `${info.name} · ${effort.name}`,
      ...(common.description === undefined ? {} : { description: common.description }),
      enabled: common.enabled,
      ...(common.disabledReason === undefined ? {} : { disabledReason: common.disabledReason }),
      ...(common.contextWindow === undefined ? {} : { contextWindow: common.contextWindow }),
      ...(common.inputModalities === undefined ? {} : { inputModalities: common.inputModalities }),
    }
  })
}

function invalidSelection(kind: string): BridgeError {
  return new BridgeError('INVALID_SELECTION', `The ${kind} selection is unavailable in the current catalog.`, { retryable: false })
}
