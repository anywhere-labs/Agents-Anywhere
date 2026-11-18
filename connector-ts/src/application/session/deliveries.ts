import { createHash } from 'node:crypto'

import type { JsonObject, TimelineDraft, TimelineItem } from '../../domain/conversation/index.js'
import type { JsonValue } from '../../domain/identity/index.js'
import type { AttachmentInfo, PromptAttachment } from '../ports/index.js'
import { TimelineProjector } from '../projection.js'
import type { RuntimeBindings } from './bindings.js'
import type { AttachmentRef, SessionKernel } from './kernel.js'

/** Id of a user message the platform writes itself (failed sends, Runtimes that do not name the item). */
export function platformUserItemId(sessionId: string, clientMessageId: string): string {
  return `aa_user_${createHash('sha256').update(`${sessionId}\0${clientMessageId}`).digest('hex').slice(0, 32)}`
}

/** A sent attachment as a Timeline user message shows it (`content.attachments[]`); never its key or local path. */
export function attachmentInfo(ref: { fileId: string; name?: string | null; mediaType?: string | null; size?: number | null; sha256?: string | null }): AttachmentInfo {
  return {
    fileId: ref.fileId,
    name: ref.name ?? ref.fileId,
    mediaType: ref.mediaType ?? 'application/octet-stream',
    ...(typeof ref.size === 'number' ? { size: ref.size } : {}),
    ...(typeof ref.sha256 === 'string' && ref.sha256 !== '' ? { sha256: ref.sha256 } : {}),
  }
}

function hasAttachments(content: JsonObject): boolean {
  return Array.isArray(content.attachments) && content.attachments.length > 0
}

function attachmentsJson(attachments: readonly AttachmentInfo[]): JsonValue[] {
  return attachments.map(info => ({ ...info }))
}

/**
 * The delivery side every send shares (direct, queued, recovered): the delivery's progress to `started`, the user
 * message the platform writes for it, and the attachments as the Runtime gets them.
 */
export class DeliveryRecords {
  public constructor(private readonly kernel: SessionKernel, private readonly bindings: RuntimeBindings) {}

  /**
   * A platform attachment as the Runtime gets it: the local file, plus its platform identity (`info`), which a
   * Runtime that records it natively (Pi) keeps so that history and replay show the same attachment.
   */
  public async resolveAttachment(sessionId: string, ref: AttachmentRef): Promise<PromptAttachment> {
    const attachment = await this.kernel.deps.attachments!(sessionId, ref)
    return { ...attachment, info: attachmentInfo(ref) }
  }

  /** A send that never reached the Runtime is still shown, as a failed user message with what it carried. */
  public async writeFailedUserMessage(sessionId: string, clientMessageId: string, text: string, code: string, message: string, attachments: readonly AttachmentInfo[] = []): Promise<void> {
    await this.putUserMessage(sessionId, platformUserItemId(sessionId, clientMessageId), clientMessageId, text, 'failed', {
      ...(attachments.length > 0 ? { attachments: attachmentsJson(attachments) } : {}),
      error: { code, message },
    })
  }

  /**
   * The user message of an accepted delivery, with the attachments it carried, unless the Runtime already echoed
   * it; an echo that does not name the attachments gets them. The adapter's `userItemId` follows the Runtime's v2
   * identity rule, so a later echo updates the same item.
   */
  public async writeUserMessage(sessionId: string, clientMessageId: string, text: string, userItemId: string | null, attachments: readonly AttachmentInfo[] = []): Promise<void> {
    const existing = await this.kernel.deps.store.timeline.findByClientMessageId(sessionId, clientMessageId)
    if (existing !== null && existing.role === 'user' && existing.status !== 'failed') {
      if (attachments.length > 0 && !hasAttachments(existing.content)) await this.attach(sessionId, existing, attachmentsJson(attachments), [])
      return
    }
    await this.putUserMessage(sessionId, userItemId ?? platformUserItemId(sessionId, clientMessageId), clientMessageId, text, 'done',
      attachments.length > 0 ? { attachments: attachmentsJson(attachments) } : {})
  }

  /** Commits `item` with `attachments` in its content (and the deletes), keeping its position. */
  private async attach(sessionId: string, item: TimelineItem, attachments: JsonValue[], deletes: string[]): Promise<void> {
    const deps = this.kernel.deps
    const draft: TimelineDraft = {
      id: item.id,
      type: item.type,
      status: item.status,
      role: item.role,
      orderSeq: item.orderSeq,
      content: { ...item.content, attachments },
      source: item.source,
      createdAt: item.createdAt,
      ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
      ...(item.blobRefs !== undefined ? { blobRefs: item.blobRefs } : {}),
    }
    const commit = await deps.store.timeline.apply(sessionId, { upserts: [draft], deletes, at: deps.clock.nowIso() })
    this.kernel.publish(commit)
  }

  private async putUserMessage(sessionId: string, id: string, clientMessageId: string, text: string, status: 'done' | 'failed', extra: Record<string, unknown>): Promise<void> {
    const deps = this.kernel.deps
    const binding = this.bindings.get(sessionId)
    const at = deps.clock.nowIso()
    const draft: Omit<TimelineDraft, 'orderSeq'> = {
      id,
      type: 'message',
      status,
      role: 'user',
      content: { kind: 'markdown', format: 'markdown', text, isThinking: false, clientMessageId, ...(extra as Record<string, never>) },
      source: { runtime: binding === undefined ? 'platform' : 'platform', clientMessageId },
      createdAt: at,
      completedAt: at,
    }
    const stored = await deps.store.timeline.get(sessionId, id)
    const projector = binding?.projector ?? new TimelineProjector('platform', null, await deps.store.timeline.latest(sessionId), () => at)
    if (stored !== null) projector.remember(stored)
    await this.kernel.commit(sessionId, { upserts: [projector.platform(stored !== null ? { ...draft, orderSeq: stored.orderSeq, createdAt: stored.createdAt } : draft)] })
  }

  public async settleDeliveryStarted(sessionId: string, clientMessageId: string, _userItemId: string | null, _text?: string): Promise<void> {
    const deps = this.kernel.deps
    const current = await deps.store.deliveries.get(sessionId, clientMessageId)
    if (current === null || current.state === 'started') return
    if (current.state === 'accepted') await deps.store.deliveries.transition(sessionId, clientMessageId, 'sending', { at: deps.clock.nowIso() })
    const after = await deps.store.deliveries.get(sessionId, clientMessageId)
    if (after?.state === 'sending') await deps.store.deliveries.transition(sessionId, clientMessageId, 'started', { at: deps.clock.nowIso() })
  }

  /**
   * The Runtime echoed a user message under its own id after the platform wrote one under the platform id
   * (an adapter that did not report `userItemId`): keep the Runtime's item, drop the platform copy.
   */
  public async adoptUserEcho(sessionId: string, clientMessageId: string, itemId: string): Promise<void> {
    const deps = this.kernel.deps
    const platformId = platformUserItemId(sessionId, clientMessageId)
    if (itemId === platformId) return
    const copy = await deps.store.timeline.get(sessionId, platformId)
    if (copy === null || copy.status === 'failed') return
    // The platform copy named the attachments; an echo that does not keeps them.
    const echo = hasAttachments(copy.content) ? await deps.store.timeline.get(sessionId, itemId) : null
    if (echo !== null && !hasAttachments(echo.content)) {
      await this.attach(sessionId, echo, copy.content.attachments as JsonValue[], [platformId])
      return
    }
    const commit = await deps.store.timeline.apply(sessionId, { upserts: [], deletes: [platformId], at: deps.clock.nowIso() })
    this.kernel.publish(commit)
  }
}
