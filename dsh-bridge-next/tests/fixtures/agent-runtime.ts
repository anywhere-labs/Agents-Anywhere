import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Commands from '@deepseek-ai/dsh-commands'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import Approval from '@deepseek-ai/dsh-user-approval'
import Shell from '@deepseek-ai/dsh-shell'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { modelSelectionId, permissionSelectionId } from '../../src/host/dsh-runtime/selections.js'

export const initialSelections = { model: modelSelectionId({ provider: 'test', model: 'text' }), permission: permissionSelectionId('workspace-write') }

/** No shell tools are registered in this fixture. Unexpected shell execution fails. */
class UnusedShell extends Shell {
  override get sandboxMode() { return 'workspace-write' as const }
  resolve(): never { throw new Error('Unexpected shell execution') }
  async run(): Promise<never> { throw new Error('Unexpected shell execution') }
  start(): never { throw new Error('Unexpected shell execution') }
}

/** Only the paid model is scripted; session, inbox, loop and persistence are official. */
export class TextAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  release: (() => void) | undefined
  override async listModels(provider: string) {
    return ['text', 'thinking'].map(id => ({ provider, id, name: id === 'text' ? 'Text' : 'Thinking' }))
  }
  override async resolveModel(provider: string, model: string) {
    if (model === 'invalid') throw new Error('Unavailable model')
    return { provider, id: model, name: model, ...(model === 'thinking' ? { reasoning: {
      efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('low'),
    } } : {}) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '你' }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { this.release = undefined; reject(options.signal?.reason ?? new Error('aborted')) }
      this.release = () => { options.signal?.removeEventListener('abort', abort); resolve() }
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
    })
    yield { type: 'text-delta', index: 0, text: '好' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function mountAgents(ctx: Context, adapter: LlmAdapter): Promise<void> {
  await ctx.plugin(LlmRuntime).await()
  await ctx.plugin(SessionProjection).await()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(AgentRegistry).await()
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'text' }).await()
  ctx.llm.registerAdapter(['test'], adapter)
  const root = await mkdtemp(join(tmpdir(), 'aa-dsh-composition-'))
  ctx.on('dispose', () => rm(root, { recursive: true, force: true }))
  await ctx.plugin(SettingsFile, { dshHome: root, watch: false }).await()
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  ctx.loader.builtins.include = Include
  await writeFile(join(root, 'agent.mjs'), 'export default function () {}\n')
  for (const id of ['standard', 'minimal']) {
    const directory = join(root, 'presets', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'agent.cordis.yml'), `- name: ${pathToFileURL(join(root, 'agent.mjs')).href}\n`)
    await writeFile(join(directory, 'preset.yml'), `name: ${id}\n`)
  }
  await ctx.plugin(AgentPresets, { default: 'minimal', roots: [{ path: join(root, 'presets'), trust: 'system' }], includeShippedRoot: false, includeUserRoot: false }).await()
  await ctx.plugin(Attachments, { dshHome: root }).await()
  await ctx.plugin(Commands).await()
  await ctx.plugin(UnusedShell).await()
  await ctx.plugin(Approval, { policy: 'ask' }).await()
  await ctx.plugin(PermissionPresets, { defaultPreset: 'danger-full-access' }).await()
  // In-process route registry only; this fixture never serves browser HTTP requests.
  new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
  await ctx.plugin(FileUploads).await()
  await ctx.plugin(SessionController).await()
}
