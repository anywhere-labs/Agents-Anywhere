import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjection from '@deepseek-ai/dsh-session-projection'

/** Only the paid model is scripted; session, inbox, loop and persistence are official. */
export class TextAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  release: (() => void) | undefined
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

export async function mountAgents(ctx: Context, adapter: TextAdapter): Promise<void> {
  await ctx.plugin(LlmRuntime).await()
  await ctx.plugin(SessionProjection).await()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(AgentRegistry).await()
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(AgentDefaultModel, { provider: 'test', model: 'text' }).await()
  ctx.llm.registerAdapter(['test'], adapter)
}
