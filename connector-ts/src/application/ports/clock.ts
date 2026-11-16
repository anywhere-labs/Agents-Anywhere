/** Wall clock and id source, injected so use cases and tests stay deterministic. */
export interface Clock {
  /** ISO 8601 UTC timestamp. */
  nowIso(): string
  nowMs(): number
}

export interface IdSource {
  /** A random id with the given prefix (`qmsg_`, `turn_`, `goal_`). */
  newId(prefix: string): string
}
