import type { ChangeFeed, ConversationStore } from '../application/ports/index.js'
import { PAGE_BUDGET, SNAPSHOT_LIMIT } from '../domain/conversation/index.js'
import type { ChangesEvent } from '../generated/device-meshcall/v1_0/changes-event.js'
import { changesEvent, snapshotEvent, timelineEvents } from './client-shape.js'

export interface WatchDeps {
  readonly store: ConversationStore
  readonly feed: ChangeFeed
  readonly now: () => string
}

export interface WatchRequest {
  readonly sessionId: string
  readonly afterSeq: number
  readonly byteBudget?: number
}

/**
 * `Sessions/watch` (06-protocols.md §3.4): opening the stream subscribes, cancelling it unsubscribes. The stream
 * reads committed changes from the store at the consumer's pace, so a slow Server never holds up the Runtime and
 * every item carries its latest state (agentd's WatcherQueue rule). Gaps before `afterSeq` are not filled here:
 * clients catch up through the Server with their own cursors.
 */
export async function* watchSession(deps: WatchDeps, request: WatchRequest, signal: AbortSignal): AsyncGenerator<ChangesEvent> {
  let dirty = true
  let wake: (() => void) | undefined
  const unsubscribe = deps.feed.subscribe(request.sessionId, () => {
    dirty = true
    const resolve = wake
    wake = undefined
    resolve?.()
  })
  const onAbort = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const budget = request.byteBudget ?? PAGE_BUDGET
  let cursor = request.afterSeq
  try {
    while (!signal.aborted) {
      if (!dirty) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
        continue
      }
      dirty = false
      for (;;) {
        if (signal.aborted) return
        const page = await deps.store.timeline.changesSince(request.sessionId, cursor, 500, budget)
        if (page.snapshotRequired) {
          // A reset or a deletion in the range: the subscriber must replace what it has.
          const latest = await deps.store.timeline.read(request.sessionId, 'latest', null, SNAPSHOT_LIMIT, budget)
          yield changesEvent({
            sessionId: request.sessionId,
            fromSeq: cursor + 1,
            toSeq: latest.headSeq,
            resetSeq: latest.resetSeq,
            events: [snapshotEvent(request.sessionId, latest.headSeq, latest.items, latest.hasMore, deps.now())],
          })
          cursor = latest.headSeq
          break
        }
        if (page.items.length === 0) {
          cursor = Math.max(cursor, page.toSeq)
          break
        }
        yield changesEvent({
          sessionId: request.sessionId,
          fromSeq: cursor + 1,
          toSeq: page.toSeq,
          resetSeq: page.resetSeq,
          events: timelineEvents(request.sessionId, page.items, deps.now()),
        })
        cursor = page.toSeq
        if (page.complete) break
      }
    }
  } finally {
    unsubscribe()
    signal.removeEventListener('abort', onAbort)
  }
}
