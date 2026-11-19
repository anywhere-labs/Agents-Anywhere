import type { ReviewRunRepository } from '../application/ports/collab.js'
import type { RuntimeKv } from '../application/ports/conversation-store.js'
import type { ReviewRun } from '../domain/collab/review.js'

const NAMESPACE = ':agents-anywhere:collaborative-review:v1'

function readRun(value: unknown): { run: ReviewRun; pendingTimeline?: boolean } {
  const { pendingTimeline, ...run } = value as ReviewRun & { pendingTimeline?: boolean }
  return { run, ...(pendingTimeline === undefined ? {} : { pendingTimeline }) }
}

/** Review runs live with the supervisor's Connector state in the local SQLite store. */
export function reviewRuns(kv: RuntimeKv): ReviewRunRepository {
  return {
    get: async sessionId => {
      const value = await kv.get(NAMESPACE, sessionId)
      return value == null ? null : readRun(value).run
    },
    unfinishedDispatches: async () => (await kv.entries(NAMESPACE))
      .map(({ key, value }) => ({ sessionId: key, ...readRun(value) }))
      .filter(({ run, pendingTimeline }) => pendingTimeline || (run.phase !== 'delivered' && run.phase !== 'blocked')),
    save: (sessionId, run, pendingTimeline) => kv.set(NAMESPACE, sessionId, pendingTimeline ? { ...run, pendingTimeline } : run),
  }
}
