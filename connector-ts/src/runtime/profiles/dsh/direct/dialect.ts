/**
 * The direct route's ACP dialect: DSH's automation ACP (`dsh --profile acp`, D7) driven by B's
 * generic ACP engine. DSH sends whole committed messages, never echoes AA's prompt, admits one
 * prompt per session (the session engine queues the rest) and rejects empty prompts.
 *
 * DSH's write lock: a `session/resume` of a session another DSH process holds fails with a bare
 * `-32603` (S7). `DshRuntime` names it `writer_held`; see `writerHeld()`.
 */
import type { PromptInput, RuntimeError } from '../../../../application/ports/runtime-session.js'
import { acpFingerprint } from '../../../../domain/identity/index.js'
import type { AcpDialect, SessionContext } from '../../../acp/dialect.js'
import { JsonRpcError } from '../../../acp/jsonrpc.js'
import { contentText } from '../../../acp/mapping.js'
import { DIRECT_ROUTE_REASON, directCapabilities } from '../capabilities.js'
import { DSH_SELECTIONS } from '../selections.js'

/**
 * Item ids of the direct route. Every agent chunk is a whole committed message, so each one is its own item:
 * DSH's `messageId` when it sends one, else a per-session counter under the connection epoch (the generic rule
 * would merge consecutive chunks of one kind into a single item, and a fresh rule per update numbers them all 1).
 */
function directItemId(counters: WeakMap<SessionContext, { n: number }>, context: SessionContext, kind: string, messageId: unknown): string {
  if (typeof messageId === 'string' && messageId !== '') return acpFingerprint([context.sessionId, 'dsh', kind, messageId])
  let counter = counters.get(context)
  if (counter === undefined) {
    counter = { n: 0 }
    counters.set(context, counter)
  }
  counter.n += 1
  return acpFingerprint([context.sessionId, context.epoch, 'dsh', kind, counter.n])
}

export function dshDirectDialect(): AcpDialect {
  const counters = new WeakMap<SessionContext, { n: number }>()
  return {
    runtime: 'dsh',
    agentTools: true,
    clientCapabilities: () => ({ fs: { readTextFile: false, writeTextFile: false }, terminal: false }),
    capabilities: info => directCapabilities(info),
    selections: DSH_SELECTIONS,
    steer: 'none',
    echoesUserPrompt: false,
    // Each agent chunk is a whole committed message (S7): the item is complete, not a stream.
    translateUpdate(update, context) {
      if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') return undefined
      const text = contentText(update.content)
      if (text === undefined) return undefined
      const itemId = directItemId(counters, context, String(update.sessionUpdate), update.messageId)
      return [{ type: 'message.completed', itemId, role: update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant', text }]
    },
    classifyError: (error): RuntimeError | undefined => {
      if (error instanceof JsonRpcError && error.code === -32602) return { code: 'invalid_argument', message: error.message }
      return undefined
    },
  }
}

/**
 * What DSH would refuse in this input, checked before it is sent: B's engine has already opened
 * the turn by the time it builds the prompt blocks.
 */
export function directPromptProblem(input: PromptInput): RuntimeError | undefined {
  if (input.attachments?.some(item => item.kind !== 'inline' || !item.mimeType.startsWith('image/'))) {
    return { code: 'runtime_unsupported', message: `DSH direct mode takes text and images only. ${DIRECT_ROUTE_REASON}` }
  }
  // DSH rejects empty prompts (-32602).
  if (!input.text.trim() && !input.attachments?.length) return { code: 'invalid_argument', message: 'A DSH prompt needs text or an image.' }
  return undefined
}

/** Whether an open failure is DSH's write lock (another DSH process has the session open). */
export function isWriterHeld(error: unknown): boolean {
  return error instanceof JsonRpcError && error.code === -32603
}

/**
 * The write lock as AA sees it. Without the plugin AA cannot take the session from DSH Desktop
 * or `dsh web`; it can only say so (04 §5.6: DSH Desktop open without the plugin only gets a notice).
 */
export function writerHeld(nativeSessionId: string): RuntimeError {
  return { code: 'writer_held', retryable: true,
    message: '这个 DSH 会话正在 DSH Desktop 或 dsh web 中打开。关闭它，或在 DSH 中安装 Agents Anywhere 插件后即可在 AA 中继续。',
    details: { nativeSessionId, hint: 'install_dsh_plugin' } }
}
