/**
 * The DSH plugin route's ACP dialect (DSH-4, contracts/dsh-bridge/3.0): the plugin is an ACP
 * Agent inside the DSH host, so the generic ACP engine (B's `runtime/acp/`) drives it and this
 * dialect only reads and writes the `_meta.dsh` conventions.
 *
 * - Items: every assistant, reasoning and tool update names its item (`_meta.dsh.itemId`), the
 *   same for stream chunks, the committed message and a later replay (§6). A committed message
 *   replaces its item whole; a new stream attempt on an item starts it over.
 * - User messages: AA's own prompt carries `requestId = clientMessageId`, and history replays the
 *   message with that `requestId`, so both land on the item the engine wrote (`userItemId`).
 * - Writer changes ride `session_info_update` (`_meta.dsh.writer`, §9).
 * - Plan reviews arrive as `session/request_permission` with `_meta.dsh.planningReview` (§10).
 */
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Capability, HistoryItem, InteractionKind, NewSessionSpec, PromptInput, RuntimeError, RuntimeEvent,
  WriterState } from '../../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../../acp/client.js'
import type { AcpDialect, ItemIdentity, SessionContext } from '../../../acp/dialect.js'
import { JsonRpcError } from '../../../acp/jsonrpc.js'
import { contentText, translateUpdate as genericTranslate } from '../../../acp/mapping.js'
import { defaultIdentity } from '../../../acp/session.js'
import { acpFingerprint } from '../../../../domain/identity/index.js'
import { GENERIC_CLIENT_CAPABILITIES } from '../../generic/dialect.js'

export const DSH_BRIDGE_PROTOCOL = '3.0'

export interface DshFeatures {
  queue: boolean, steer: boolean, continue: boolean, planning: boolean, questions: boolean,
  attachments: boolean, fileUploads: boolean, agentPresets: boolean, permissionPresets: boolean
}

const dshMeta = (value: unknown): JsonRecord => asRecord(asRecord(asRecord(value)._meta).dsh)

/** `_meta.dsh.features` of the plugin's initialize answer (§2); all false when absent. */
export function featuresOf(info: AgentInfo): DshFeatures {
  const raw = asRecord(asRecord(info.meta.dsh).features)
  const flag = (name: keyof DshFeatures) => raw[name] === true
  return { queue: flag('queue'), steer: flag('steer'), continue: flag('continue'), planning: flag('planning'), questions: flag('questions'),
    attachments: flag('attachments'), fileUploads: flag('fileUploads'), agentPresets: flag('agentPresets'), permissionPresets: flag('permissionPresets') }
}

function writerState(value: unknown): WriterState | undefined {
  if (value === 'host') return { holder: 'self' }
  if (value === 'external') return { holder: 'external', by: 'dsh' }
  if (value === 'none') return { holder: 'none' }
  return undefined
}

const ERROR_CODES: Readonly<Record<string, { code: string, retryable?: boolean }>> = {
  writer_held: { code: 'writer_held', retryable: true },
  session_not_found: { code: 'session_not_found' },
  invalid_params: { code: 'invalid_argument' },
  unsupported: { code: 'runtime_unsupported' },
  dsh_unavailable: { code: 'runtime_unavailable', retryable: true },
}

export function dshPluginDialect(): AcpDialect {
  /** Per session: the stream attempt each item is showing (a new attempt starts the item over). */
  const attempts = new Map<string, Map<string, string>>()
  const attemptsOf = (context: SessionContext) => {
    const key = `${context.epoch}\u0000${context.nativeSessionId}`
    let map = attempts.get(key)
    if (!map) attempts.set(key, map = new Map())
    return map
  }

  // User items are keyed by the native session, not the AA session: a history read (which has
  // no AA session yet), a full replay and AA's own prompt all name the same item.
  const identity = (context: SessionContext): ItemIdentity => {
    const fallback = defaultIdentity(context)
    const userItemId = (clientMessageId: string) => acpFingerprint([context.nativeSessionId, 'dsh.user', clientMessageId])
    return {
      itemFor(update) {
        const meta = dshMeta(update)
        if (update.sessionUpdate === 'user_message_chunk') {
          if (typeof meta.requestId === 'string') return userItemId(meta.requestId)
          const messageId = asRecord(update).messageId
          if (typeof messageId === 'string' && messageId) return acpFingerprint([context.nativeSessionId, 'dsh.user.message', messageId])
          return fallback.itemFor(update)
        }
        return typeof meta.itemId === 'string' ? meta.itemId : null
      },
      userItemId,
    }
  }

  const dialect: AcpDialect = {
    runtime: 'dsh',
    clientCapabilities: () => structuredClone(GENERIC_CLIENT_CAPABILITIES),
    capabilities: info => {
      const features = featuresOf(info)
      const base = negotiatedCapabilities(info, { steer: features.steer, forms: features.questions, permissionCatalog: features.permissionPresets })
      const extra: Capability[] = [
        { id: 'session.plan_review', supported: features.planning },
        { id: 'catalog.model', supported: true },
        { id: 'catalog.effort', supported: true },
      ]
      return [...base.filter(item => item.id !== 'runtime.attachment'),
        { id: 'runtime.attachment', supported: features.attachments || features.fileUploads,
          ...(features.attachments || features.fileUploads ? { parameters: { image: features.attachments, files: features.fileUploads } } : {}) },
        ...extra]
    },
    identity,
    newSessionParams: (spec: NewSessionSpec) => {
      if (!spec.preferredNativeSessionId) throw new JsonRpcError(-32602, 'The DSH plugin route needs the native session ID AA assigns (contracts/dsh-bridge/3.0 §3).')
      return { _meta: { dsh: { sessionId: spec.preferredNativeSessionId } } }
    },
    // `delivery: turn`: the prompt answers when the turn that took it ends (§8).
    promptParams: delivery => ({ _meta: { dsh: { requestId: delivery.clientMessageId, delivery: 'turn' } } }),
    promptBlocks: (input: PromptInput) => promptBlocks(input),
    steer: 'extension',
    echoesUserPrompt: true,
    translateUpdate(update, context) {
      const meta = dshMeta(update)
      if (update.sessionUpdate === 'session_info_update') {
        const writer = writerState(meta.writer)
        if (writer) return [{ type: 'writer.changed', writer }]
        // Turn boundaries (§7) are the engine's: it owns AA's turns and infers external ones.
        if (meta.turnEvent !== undefined) return []
        return undefined
      }
      if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') return undefined
      const itemId = typeof meta.itemId === 'string' ? meta.itemId : undefined
      if (!itemId) return meta.abandoned !== undefined ? [] : undefined
      const role = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
      const text = contentText(update.content) ?? ''
      const shown = attemptsOf(context)
      if (meta.committed !== undefined) {
        shown.delete(itemId)
        return [{ type: 'message.completed', itemId, role, text }]
      }
      if (meta.transient === true) {
        const attempt = typeof meta.attemptId === 'string' ? meta.attemptId : ''
        const events: RuntimeEvent[] = []
        // A retry streams into the same item: drop what the abandoned attempt showed.
        if (shown.has(itemId) && shown.get(itemId) !== attempt) events.push({ type: 'message.completed', itemId, role, text: '' })
        shown.set(itemId, attempt)
        if (text) events.push({ type: 'message.delta', itemId, role, text })
        return events
      }
      return undefined
    },
    interactionKind: (method, params): InteractionKind | undefined => {
      if (method === 'session/request_permission' && dshMeta(params).planningReview !== undefined) return 'plan_review'
      return undefined
    },
    classifyError: (error): RuntimeError | undefined => {
      if (!(error instanceof JsonRpcError)) return undefined
      const data = asRecord(error.data)
      const known = typeof data.code === 'string' ? ERROR_CODES[data.code] : undefined
      if (!known) return undefined
      return { code: known.code, message: error.message, ...(known.retryable ? { retryable: true } : {}) }
    },
    // Read-only history with the same item IDs as live delivery: load attaches without taking the
    // writer lock, close only detaches (invariant I1).
    async readNativeHistory(client, ref, sessionId) {
      const { updates } = await client.capture(ref.nativeSessionId, () => client.request('session/load', {
        sessionId: ref.nativeSessionId, cwd: ref.locator ?? process.cwd(), mcpServers: [] }, { timeoutMs: 120_000 }))
      await client.request('session/close', { sessionId: ref.nativeSessionId }, { timeoutMs: 15_000 }).catch(() => undefined)
      const info: AgentInfo = { protocolVersion: 1, agentCapabilities: {}, agentInfo: {}, authMethods: [], meta: {} }
      const context: SessionContext = { sessionId, nativeSessionId: ref.nativeSessionId, epoch: `history:${sessionId}`, info }
      const ids = identity(context)
      const items: HistoryItem[] = []
      for (const update of updates) {
        const events = dialect.translateUpdate!(update, context)
          ?? genericTranslate(update, { identity: ids, replay: true, suppressUserEcho: false, config: [] })
        for (const event of events) {
          if (event.type === 'message.delta' || event.type === 'message.completed' || event.type === 'tool.started'
            || event.type === 'tool.updated' || event.type === 'notice') items.push({ ...event, replay: true })
        }
      }
      attempts.delete(`${context.epoch}\u0000${context.nativeSessionId}`)
      return { items }
    },
  }
  return dialect
}

/** Text, inline images, image files read inline, other files as `resource_link` + `_meta.dsh.upload` (§8). */
export function promptBlocks(input: PromptInput): JsonRecord[] {
  const blocks: JsonRecord[] = []
  if (input.text !== '') blocks.push({ type: 'text', text: input.text })
  for (const attachment of input.attachments ?? []) {
    if (attachment.kind === 'inline') {
      if (!attachment.mimeType.startsWith('image/')) throw new JsonRpcError(-32602, 'DSH takes inline images only; send other files as files.')
      blocks.push({ type: 'image', mimeType: attachment.mimeType, data: attachment.data })
    } else if (attachment.kind === 'file') {
      if (attachment.mimeType.startsWith('image/')) {
        blocks.push({ type: 'image', mimeType: attachment.mimeType, data: readFileSync(attachment.path).toString('base64') })
        continue
      }
      const name = attachment.name ?? attachment.path.split(/[\\/]/).pop() ?? 'file'
      blocks.push({ type: 'resource_link', uri: pathToFileURL(attachment.path).href, name, mimeType: attachment.mimeType,
        _meta: { dsh: { upload: { path: attachment.path, name, mimeType: attachment.mimeType, size: statSync(attachment.path).size } } } })
    } else {
      blocks.push({ type: 'resource_link', uri: attachment.uri, name: attachment.name ?? attachment.uri, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) })
    }
  }
  return blocks
}
