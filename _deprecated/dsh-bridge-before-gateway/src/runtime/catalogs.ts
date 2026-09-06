import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { MetadataStore } from '../persistence/metadata.js'
import {
  contentHash,
  decodeModelSelectionId,
  decodePermissionSelectionId,
  modelSelectionId,
  permissionSelectionId,
} from '../projection/identity.js'
import { BridgeError } from '../wire/errors.js'
import type { ModelCatalogItem, PermissionCatalogItem } from './types.js'

export interface CatalogSnapshot {
  revision: number
  models: ModelCatalogItem[]
  permissions: PermissionCatalogItem[]
}

export class CatalogManager {
  private snapshot: CatalogSnapshot | undefined
  private refreshPromise: Promise<CatalogSnapshot> | undefined

  constructor(private readonly ctx: Context, private readonly metadata: MetadataStore) {}

  async current(): Promise<CatalogSnapshot> {
    return this.snapshot ?? await this.refresh()
  }

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

  async resolveModel(id: string, signal?: AbortSignal): Promise<ModelSelection> {
    const selection = decodeModelSelectionId(id)
    let info: LlmResolvedModelInfo
    try {
      info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
    } catch (error: unknown) {
      throw invalidSelection('model', error)
    }
    if (!supportsText(info)) throw invalidSelection('model')
    if (selection.reasoningEffort !== undefined
      && !info.reasoning?.efforts.some(item => item.id === selection.reasoningEffort)) {
      throw invalidSelection('reasoning effort')
    }
    return selection
  }

  async defaultModel(signal?: AbortSignal): Promise<ModelSelection> {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return await this.resolveModel(modelSelectionId(selection), signal)
  }

  async resolvePermission(id: string): Promise<string> {
    const preset = decodePermissionSelectionId(id)
    if (!this.ctx.permissionPresets.names.includes(preset)) throw invalidSelection('permission')
    return preset
  }

  permissionFor(events: Parameters<Context['permissionPresets']['current']>[0]): string {
    return permissionSelectionId(this.ctx.permissionPresets.current(events))
  }

  private async build(): Promise<CatalogSnapshot> {
    const models: ModelCatalogItem[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      const listed = await this.ctx.llm.listModels(provider.id)
      for (const model of listed) {
        const info = await this.ctx.llm.resolveModelInfo(provider.id, model.id)
        models.push(modelItem(info))
      }
    }
    const permissions = this.ctx.permissionPresets.names.map((preset): PermissionCatalogItem => {
      const option = this.ctx.permissionPresets.optionOf(preset)
      return {
        id: preset,
        title: option.name,
        selectionId: permissionSelectionId(preset),
        enabled: true,
        ...(option.description === undefined ? {} : { description: option.description }),
        metadata: { preset },
      }
    })
    const custom = this.ctx.permissionPresets.optionOf('custom')
    permissions.push({
      id: 'custom',
      title: custom.name,
      selectionId: permissionSelectionId('custom'),
      enabled: false,
      disabledReason: 'Custom permission combinations are observable but cannot be selected through Bridge 1.0.',
      ...(custom.description === undefined ? {} : { description: custom.description }),
      metadata: { preset: 'custom' },
    })
    const fingerprint = contentHash({ models, permissions })
    const revision = await this.metadata.catalogRevision(fingerprint)
    return { revision, models, permissions }
  }
}

function modelItem(info: LlmResolvedModelInfo): ModelCatalogItem {
  const enabled = supportsText(info)
  const baseSelection: ModelSelection = { provider: info.provider, model: info.id }
  return {
    id: modelSelectionId(baseSelection),
    title: info.name,
    selectionId: modelSelectionId(baseSelection),
    enabled,
    reasoningItems: (info.reasoning?.efforts ?? []).map(effort => ({
      id: String(effort.id),
      title: effort.name,
      selectionId: modelSelectionId({ ...baseSelection, reasoningEffort: effort.id }),
      enabled,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    })),
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(enabled ? {} : { disabledReason: 'Bridge protocol 1.0 supports text input only.' }),
    metadata: {
      provider: info.provider,
      model: info.id,
      ...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
      ...(info.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] }),
      ...(info.reasoning?.defaultEffort === undefined
        ? {}
        : { defaultReasoningSelectionId: modelSelectionId({ ...baseSelection, reasoningEffort: info.reasoning.defaultEffort }) }),
    },
  }
}

function supportsText(info: LlmResolvedModelInfo): boolean {
  return info.inputModalities === undefined || info.inputModalities.includes('text')
}

function invalidSelection(kind: string, cause?: unknown): BridgeError {
  return new BridgeError('INVALID_SELECTION', `The ${kind} selection is unavailable in the current DSH Host.`, {
    retryable: false,
  }, cause === undefined ? undefined : { cause })
}
