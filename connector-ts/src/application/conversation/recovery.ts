import { interaction as interactionRules } from '../../domain/conversation/index.js'
import type { QueueService } from '../queue/queue-service.js'
import type { DeliveryRecords } from '../session/deliveries.js'
import type { AttachmentRef, SessionKernel } from '../session/kernel.js'
import type { TurnLifecycle } from '../session/turns.js'
import type { MessageService } from './messages.js'

/** What a Connector restart leaves behind, settled once before the device serves anything. */
export class Recovery {
  public constructor(
    private readonly kernel: SessionKernel,
    private readonly deliveries: DeliveryRecords,
    private readonly turns: TurnLifecycle,
    private readonly queue: QueueService,
    private readonly messages: MessageService,
  ) {}

  /**
   * After a restart: deliveries left in `sending` settle as started (evidence) or unknown; queue items left in
   * `sending` fail with `queue_dispatch_unknown`; open interactions are shown as expired; turns that were
   * running are closed as failed. Nothing the Runtime may have seen is resent. Deliveries left in `accepted`
   * never reached the Runtime: they are handed off now from what they kept, or rejected when nothing was kept.
   */
  public async recover(): Promise<void> {
    const store = this.kernel.deps.store
    const at = this.kernel.deps.clock.nowIso()
    const resume: Array<() => void> = []
    for (const { delivery, pending } of await store.deliveries.acceptedPending()) {
      if (pending === null) {
        await store.deliveries.transition(delivery.sessionId, delivery.clientMessageId, 'rejected', { at, errorCode: 'connector_restarted' })
        await this.deliveries.writeFailedUserMessage(delivery.sessionId, delivery.clientMessageId, '', 'connector_restarted', 'The Connector restarted before this message reached the agent.')
        continue
      }
      resume.push(() => this.messages.handOff(delivery.sessionId, delivery.clientMessageId, pending.content, pending.attachments as unknown as AttachmentRef[], pending.open))
    }
    for (const delivery of await store.deliveries.inFlight()) {
      const evidence = await store.timeline.findByClientMessageId(delivery.sessionId, delivery.clientMessageId)
      await store.deliveries.transition(delivery.sessionId, delivery.clientMessageId, evidence !== null ? 'started' : 'unknown', { at, ...(evidence === null ? { errorCode: 'delivery_outcome_unknown' } : {}) })
    }
    for (const queue of await store.queues.nonEmpty()) {
      for (const item of queue.items) {
        if (item.status !== 'sending') continue
        const evidence = await store.timeline.findByClientMessageId(queue.sessionId, item.clientMessageId)
        await this.queue.apply(queue.sessionId, evidence !== null ? { kind: 'markSent', messageId: item.messageId } : { kind: 'markFailed', messageId: item.messageId, error: { code: 'queue_dispatch_unknown', message: 'The Connector restarted during the dispatch.' } })
      }
    }
    for (const interaction of await store.interactions.allActive()) {
      await store.interactions.save(interactionRules.expire(interaction, 'connector_restarted', at))
    }
    for (const session of await store.sessions.list()) {
      if (session.activeTurn !== null) await this.turns.onSessionLost(session.sessionId, { code: 'connector_restarted', message: 'The Connector restarted during this turn.' })
    }
    for (const start of resume) start()
  }
}
