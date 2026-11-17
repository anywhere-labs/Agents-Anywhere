import { IdentityInputError } from './errors.js'
import type { JsonValue } from './python-json.js'
import { pyGet, pyTruthy, type JsonObject } from './python-values.js'
import { acpFingerprint } from './session.js'

const MESSAGE_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'])
const TOOL_UPDATES = new Set(['tool_call', 'tool_call_update'])

function objectOrEmpty(value: JsonValue): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Identity half of acp/infrastructure/projection.py `Projection.apply`, one instance per
 * (session, connection epoch). `apply` returns the item id the update lands on, or null when v2
 * returns no item.
 *
 * - A verified `_meta.aa.timelineItem` wins and keeps the Agent's id; stale revisions are dropped.
 * - Verified messageId / toolCallId give replay-stable ids.
 * - Otherwise ids are connection-local (epoch + message index), never merged across replays.
 */
export class AcpProjectionIdentity {
  private readonly revisions = new Map<string, number>()
  private messageIndex = 0
  private currentKind: string | null = null

  constructor(readonly sessionId: string, readonly epoch: string) {}

  apply(update: JsonObject): string | null {
    const verified = pyTruthy(pyGet(update, 'aaProjectionVerified'))
    const native = pyGet(objectOrEmpty(pyGet(objectOrEmpty(pyGet(update, '_meta')), 'aa')), 'timelineItem')
    if (pyTruthy(native) && verified) {
      const item = objectOrEmpty(native)
      const id = pyGet(item, 'id')
      const type = pyGet(item, 'type')
      if (typeof id !== 'string' || (type !== 'message' && type !== 'tool')) {
        throw new IdentityInputError('Invalid AA native projection identity')
      }
      const revision = pyGet(item, 'revision')
      if (typeof revision !== 'number') throw new IdentityInputError('native timeline item revision must be a number')
      const old = this.revisions.get(id)
      if (old !== undefined && revision <= old) return null
      this.revisions.set(id, revision)
      return id
    }
    const kind = pyGet(update, 'sessionUpdate')
    let key: string
    if (typeof kind === 'string' && MESSAGE_UPDATES.has(kind)) {
      if (this.currentKind !== kind) {
        this.messageIndex += 1
        this.currentKind = kind
      }
      const messageId = pyGet(update, 'messageId')
      key = pyTruthy(messageId) && verified
        ? acpFingerprint([this.sessionId, kind, messageId])
        : acpFingerprint([this.sessionId, this.epoch, kind, this.messageIndex])
      if (pyGet(objectOrEmpty(pyGet(update, 'content')), 'type') !== 'text') return null
    } else if (typeof kind === 'string' && TOOL_UPDATES.has(kind)) {
      this.currentKind = null
      if (!Object.hasOwn(update, 'toolCallId')) throw new IdentityInputError('toolCallId is required')
      const toolId = pyGet(update, 'toolCallId')
      key = verified
        ? acpFingerprint([this.sessionId, 'tool', toolId])
        : acpFingerprint([this.sessionId, this.epoch, 'tool', toolId])
    } else {
      return null
    }
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    return key
  }

  /**
   * Identity half of projection.py `Projection.finish`: the turn is over, so the next message
   * update starts a new item even when it has the same kind as the last one (the user echo that
   * would otherwise separate two assistant messages is filtered on live delivery).
   */
  finish(): void {
    this.currentKind = null
  }
}

/**
 * acp/profiles/pi/history.py `timeline`: Pi native history item id. `suffix` is the content block
 * index (a number) for message blocks, else 'result' | 'bash' | the entry type.
 */
export function piHistoryItemId(sessionId: string, entry: JsonObject, entryIndex: number, suffix: string | number): string {
  const entryId = pyGet(entry, 'id')
  const key: JsonValue = pyTruthy(entryId) ? entryId : `legacy:${entryIndex}:${acpFingerprint(entry)}`
  return acpFingerprint([sessionId, 'pi', key, suffix])
}
