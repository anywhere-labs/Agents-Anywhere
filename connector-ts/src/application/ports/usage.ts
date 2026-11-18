/** Platform activity the use cases count for the Server's usage statistics (`usage.report`): counters, never content. */
export type UsageEventName = 'message.sent' | 'session.created' | 'turn.ended' | 'approval.requested' | 'approval.resolved' | 'runtime.error'

export interface UsageFact {
  readonly name: UsageEventName
  readonly sessionId: string
  readonly runtimeType: string
  readonly runtimeId: string
  /** `turn.ended`: `completed` / `interrupted` / `failed`; `approval.resolved`: `resolved` / `expired`. */
  readonly outcome?: string
  /** Turn start to end, or approval opened to resolved, when known. */
  readonly durationMs?: number | null
}

export interface UsageSink {
  count(fact: UsageFact): void
  /** Reports what was counted so far without waiting for the next period. */
  flush(): Promise<void>
}
