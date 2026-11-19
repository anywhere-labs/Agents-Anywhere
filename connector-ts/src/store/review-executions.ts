import type { RuntimeKv } from '../application/ports/conversation-store.js'
import type { ReviewExecutionRepository } from '../application/ports/review.js'
import type { ReviewExecution } from '../domain/collab/review-execution.js'

const NAMESPACE = ':agents-anywhere:review-executions:v1'

export function reviewExecutions(kv: RuntimeKv): ReviewExecutionRepository {
  const list = async () => (await kv.entries(NAMESPACE)).map(row => row.value as ReviewExecution)
  return {
    get: async id => (await kv.get(NAMESPACE, id) as ReviewExecution | undefined) ?? null,
    bySession: async sessionId => (await list()).find(execution => execution.sessionId === sessionId) ?? null,
    list,
    save: execution => kv.set(NAMESPACE, execution.id, execution),
  }
}
