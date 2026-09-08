import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-commands'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { BridgeError } from './errors.js'
import { decodeModelSelection, decodePermissionSelection, modelSelectionId, permissionSelectionId, type Selections, type ModelSelection } from './selections.js'
import { record } from './types.js'

/** Official configuration writes are immediate; the Agent owns their execution timing. */
export class RuntimeConfiguration {
  constructor(private ctx: Context) {}

  get canSelectModel(): boolean { return Boolean(this.ctx.get('sessionController') && this.ctx.get('llm')) }
  get canSelectPermission(): boolean { return Boolean(this.ctx.get('sessionController') && this.ctx.get('permissionPresets') && this.ctx.get('commands')) }

  controller() {
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH Session Controller is required for configuration and messaging.')
    return controller
  }

  async agent(id: SessionId): Promise<Agent> {
    const found = await this.controller().resolveAgent(id)
    if ('error' in found) throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH could not activate this session. Retry when the session is available.', true)
    return found.agent
  }

  async validate(selections: Selections, initial = false): Promise<void> {
    if (initial && !selections.model) throw new BridgeError('INVALID_PARAMS', 'Choose a model in AA before creating a DSH session.')
    if (initial && this.ctx.get('permissionPresets') && !selections.permission) {
      throw new BridgeError('INVALID_PARAMS', 'Choose permissions in AA before creating a DSH session.')
    }
    if (selections.model) {
      if (!this.canSelectModel) this.controller()
      const selection = decodeModelSelection(selections.model)
      try {
        await this.ctx.get('llm')!.resolveCallConfig({ provider: selection.provider, model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}) })
      } catch {
        throw new BridgeError('INVALID_PARAMS', 'DSH rejected this provider, model or effort. Refresh the model list and select an available combination.')
      }
    }
    if (selections.permission) {
      const preset = decodePermissionSelection(selections.permission)
      const service = this.ctx.get('permissionPresets')
      if (!service || !service.names.includes(preset)) throw new BridgeError('INVALID_PARAMS', 'This DSH permission preset is unavailable. Refresh the permission list.')
      if (!initial && !this.canSelectPermission) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH does not provide the live permission command.')
    }
  }

  async validatePreset(id: unknown): Promise<string> {
    if (typeof id !== 'string' || !id || id.length > 256) throw new BridgeError('INVALID_PARAMS', 'Choose a default Agent mode in the AA Runtime configuration.')
    const presets = this.ctx.get('agentPresets')
    if (!presets) throw new BridgeError('UNSUPPORTED_OPERATION', 'DSH Agent presets are unavailable.')
    const preset = (await presets.list()).find(preset => preset.id === id)
    if (!preset || preset.broken) throw new BridgeError('INVALID_PARAMS', 'The configured Agent mode is missing or cannot be loaded. Choose another mode in AA Runtime configuration.')
    return preset.id
  }

  async apply(agent: Agent, selections: Selections, initial: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (selections.model) {
      const requested = decodeModelSelection(selections.model)
      const current = this.ctx.get('sessionProjections')!.snapshot(agent.session, ['modelSelection']).values.modelSelection?.next
      if (!current || modelSelectionId(current) !== selections.model) {
        await this.controller().selectModel({ sessionId: agent.id, ...requested })
      }
    }
    if (selections.permission) {
      const preset = decodePermissionSelection(selections.permission)
      if (initial) this.ctx.get('permissionPresets')!.set(agent.session, preset)
      else if (this.ctx.get('permissionPresets')!.current(agent.session) !== preset) {
        const commands = this.ctx.get('commands')
        if (!commands?.find(agent, 'permission')) throw new BridgeError('UNSUPPORTED_OPERATION', 'This Agent does not provide the permission command.')
        const execution = await commands.execute(agent, `/permission ${preset}`, [], signal)
        if (execution?.result.kind !== 'success') throw new BridgeError('DSH_SERVICE_UNAVAILABLE', 'DSH could not apply this permission preset. Refresh the current session state.', true)
      }
    }
    await this.ctx.sessions.flush(agent.session)
  }

  /** Official projections work for cold sessions too, without resuming their Agent. */
  async state(id: SessionId, snapshot?: SessionLogSnapshot) {
    const live = this.ctx.sessions.get(id)
    const log = snapshot ?? (live ? undefined : await this.ctx.sessionQuery.readSession(id))
    const projections = this.ctx.get('sessionProjections')
    const projected = projections && (live ? projections.snapshot(live, ['modelSelection', 'permissions', 'agentPreset'])
      : projections.restore({}, log!.events, SessionLogOffset(0), log!.session, log!.inheritedEventCount).snapshot)
    const events = live?.snapshotEvents() ?? log!.events
    const header = live?.header ?? log!.session
    const rawModel = projected?.values.modelSelection?.next
    const lastUsed = projected?.values.modelSelection?.lastUsed
    // Old logs without the projection still expose their actual last request, never a global default.
    const request = record(record(events.findLast(event => event.type === 'request/header')?.data).header).config
    const model = rawModel ?? modelFromRecord(request)
    const permission = projected?.values.permissions?.currentValue
    const presetEvent = events.findLast(event => event.type === 'agent-preset/selected')
    const agentPreset = projected?.values.agentPreset ?? (presetEvent?.type === 'agent-preset/selected' ? presetEvent.data.agentPreset : header.agentPreset)
    return { selections: {
      ...(model ? { model: modelSelectionId(model) } : {}),
      ...(permission ? { permission: permissionSelectionId(permission) } : {}),
    }, metadata: { configurationSeq: Number(projected?.asOfSeq ?? events.at(-1)?.seq ?? -1),
      agentPreset: agentPreset ?? null, cwd: header.cwd ?? null,
      ...(model ? { modelSelection: model } : {}),
      ...(permission ? { permissionPreset: { id: permission, name: this.ctx.get('permissionPresets')?.optionOf(permission).name ?? permission, selectable: permission !== 'custom' } } : {}),
      ...(lastUsed ? { lastUsedModel: lastUsed } : {}),
      ...(permission === 'custom' ? { permission: { id: 'custom', name: 'Custom', selectable: false } } : {}),
    } }
  }
}

function modelFromRecord(value: unknown): ModelSelection | undefined {
  const model = record(value)
  if (typeof model.provider !== 'string' || typeof model.model !== 'string') return
  return { provider: model.provider, model: model.model, ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}) }
}
