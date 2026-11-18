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
 * - A failed turn (`turnEvent.reason.kind == "error"`, §7) leaves a non-blocking card; its "continue" action is
 *   `_dsh/session/continue`.
 */
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Capability, HistoryItem, InteractionAnswer, InteractionKind, InteractionRefusal, NewSessionSpec, PromptInput, RuntimeError,
  RuntimeEvent, WriterState } from '../../../../application/ports/runtime-session.js'
import { negotiatedCapabilities } from '../../../acp/capabilities.js'
import { asRecord, type AgentInfo, type JsonRecord } from '../../../acp/client.js'
import type { AcpDialect, DialectCardSession, ItemIdentity, SessionContext } from '../../../acp/dialect.js'
import { JsonRpcError } from '../../../acp/jsonrpc.js'
import { contentText, translateUpdate as genericTranslate } from '../../../acp/mapping.js'
import { defaultIdentity } from '../../../acp/session.js'
import { acpFingerprint } from '../../../../domain/identity/index.js'
import { GENERIC_CLIENT_CAPABILITIES } from '../../generic/dialect.js'
import { DSH_SELECTIONS } from '../selections.js'

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
      finish: () => fallback.finish?.(),
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
    selections: DSH_SELECTIONS,
    // An external (DSH UI) turn ends with the plugin's turnEvent, not after a quiet period (§7).
    endsAutonomousTurn: update => update.sessionUpdate === 'session_info_update'
      && asRecord(dshMeta(update).turnEvent).phase === 'ended',
    newSessionParams: (spec: NewSessionSpec) => {
      if (!spec.preferredNativeSessionId) throw new JsonRpcError(-32602, 'The DSH plugin route needs the native session ID AA assigns (contracts/dsh-bridge/3.0 §3).')
      return { _meta: { dsh: { sessionId: spec.preferredNativeSessionId } } }
    },
    // `delivery: turn`: the prompt answers when the turn that took it ends (§8).
    promptParams: delivery => ({ _meta: { dsh: { requestId: delivery.clientMessageId, delivery: 'turn' } } }),
    promptBlocks: (input: PromptInput) => promptBlocks(input),
    steer: 'extension',
    echoesUserPrompt: true,
    translateUpdate(update, context, turn) {
      const meta = dshMeta(update)
      if (update.sessionUpdate === 'session_info_update') {
        const writer = writerState(meta.writer)
        if (writer) return [{ type: 'writer.changed', writer }]
        // Turn boundaries (§7) are the engine's: it owns AA's turns and infers external ones. A failed
        // turn leaves a card behind, live only (a replayed failure is history).
        if (meta.turnEvent !== undefined) return turn.replay === true ? [] : turnFailureCard(asRecord(meta.turnEvent), featuresOf(context.info), turn.turnId)
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
    respondCard: (interactionId, answer, session) => {
      const seq = turnFailureSeq(interactionId)
      return seq === undefined ? undefined : continueTurn(seq, interactionId, answer, session, dialect)
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
    async readNativeHistory(ref, window, connection) {
      const { client } = await connection()
      const sessionId = `history:${ref.nativeSessionId}`
      const { updates } = await client.capture(ref.nativeSessionId, () => client.request('session/load', {
        sessionId: ref.nativeSessionId, cwd: ref.locator ?? process.cwd(), mcpServers: [] }, { timeoutMs: 120_000 }))
      await client.request('session/close', { sessionId: ref.nativeSessionId }, { timeoutMs: 15_000 }).catch(() => undefined)
      const info: AgentInfo = { protocolVersion: 1, agentCapabilities: {}, agentInfo: {}, authMethods: [], meta: {} }
      const context: SessionContext = { sessionId, nativeSessionId: ref.nativeSessionId, epoch: `history:${sessionId}`, info }
      const ids = identity(context)
      const items: HistoryItem[] = []
      for (const update of updates) {
        const events = dialect.translateUpdate!(update, context, { replay: true })
          ?? genericTranslate(update, { identity: ids, replay: true, suppressUserEcho: false, config: [] })
        for (const event of events) {
          if (event.type === 'message.delta' || event.type === 'message.completed' || event.type === 'tool.started'
            || event.type === 'tool.updated' || event.type === 'notice') items.push({ ...event, replay: true })
        }
      }
      attempts.delete(`${context.epoch}\u0000${context.nativeSessionId}`)
      return { items: window.limit > 0 && items.length > window.limit ? items.slice(-window.limit) : items }
    },
  }
  return dialect
}

/** Card action that asks DSH to continue a failed turn without resending the message (§7). */
export const CONTINUE_ACTION = 'continue'
const CONTINUE_METHOD = '_dsh/session/continue'
const CARD_PREFIX = 'dsh_turn_failed_'

/** The failure card of the turn whose `turn/end` has native seq `seq`; one per turn, the same on every route. */
export function turnFailureCardId(seq: number): string { return `${CARD_PREFIX}${seq}` }

function turnFailureSeq(interactionId: string): number | undefined {
  if (!interactionId.startsWith(CARD_PREFIX)) return undefined
  const seq = Number(interactionId.slice(CARD_PREFIX.length))
  return Number.isSafeInteger(seq) && seq >= 0 && turnFailureCardId(seq) === interactionId ? seq : undefined
}

export function isTurnFailureCard(interactionId: string): boolean { return turnFailureSeq(interactionId) !== undefined }

/**
 * The card a failed DSH turn leaves (`turnEvent.reason.kind == "error"`). It offers "continue" only when the
 * plugin can continue turns (`features.continue`) and DSH would continue this one (`continuable`).
 */
export function turnFailureCard(turnEvent: JsonRecord, features: DshFeatures, turnId?: string): RuntimeEvent[] {
  if (turnEvent.phase !== 'ended') return []
  const reason = asRecord(turnEvent.reason)
  const seq = turnEvent.seq
  if (reason.kind !== 'error' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return []
  const message = typeof reason.message === 'string' && reason.message.trim() ? reason.message : undefined
  const continuable = features.continue && turnEvent.continuable === true
  return [{
    type: 'interaction.opened',
    ...(turnId !== undefined ? { turnId } : {}),
    interactionId: turnFailureCardId(seq),
    kind: 'execution_error',
    title: 'DSH 本轮执行失败',
    body: message ?? '本轮执行失败，没有生成回复。',
    ...(continuable ? { options: [{ id: CONTINUE_ACTION, label: '继续', kind: 'other' as const }] } : {}),
    context: { kind: 'execution_error', outcome: 'failed', turnEndReason: 'error', ...(message !== undefined ? { error: { message } } : {}) },
    metadata: { source: 'dsh.turn.failed', turnEndSeq: seq },
  }]
}

const CONTINUE_UNAVAILABLE: InteractionRefusal = {
  refused: { code: 'dsh_continue_unavailable', message: '这一轮已无法继续生成，请重新发送消息。' },
  closes: true,
}

/**
 * "Continue" on a failure card: `_dsh/session/continue`. The plugin derives the request identity from the
 * session and seq, so answering twice runs the turn once; `unavailable` (a newer turn, DSH refuses) closes the card.
 */
async function continueTurn(seq: number, interactionId: string, answer: InteractionAnswer, session: DialectCardSession,
  dialect: AcpDialect): Promise<InteractionRefusal | undefined> {
  if (answer.kind !== 'option' || answer.optionId !== CONTINUE_ACTION) {
    return { refused: { code: 'invalid_argument', message: 'This card only offers to continue the turn.' }, closes: false }
  }
  let result: JsonRecord
  try {
    result = asRecord(await session.request(CONTINUE_METHOD, { sessionId: session.nativeSessionId, turnEndSeq: seq }))
  } catch (error) {
    // An error answer is definite; a timeout or a dropped connection leaves the outcome unknown.
    if (!(error instanceof JsonRpcError)) throw error
    if (error.code === -32601) return { refused: { code: 'runtime_unsupported', message: 'This DSH plugin cannot continue a failed turn.' }, closes: true }
    return { refused: dialect.classifyError?.(error) ?? { code: 'runtime_operation_failed', message: error.message }, closes: false }
  }
  if (result.outcome !== 'accepted') return CONTINUE_UNAVAILABLE
  session.emit({ type: 'interaction.resolved', interactionId, resolution: 'answered', answeredBy: 'self' })
  return undefined
}

/** What the plugin would refuse in this input, checked before it is sent (B opens the turn first). */
export function pluginPromptProblem(input: PromptInput): RuntimeError | undefined {
  if (input.attachments?.some(item => item.kind === 'inline' && !item.mimeType.startsWith('image/'))) {
    return { code: 'invalid_attachment', message: 'DSH takes inline images only; send other files as files.' }
  }
  return undefined
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
