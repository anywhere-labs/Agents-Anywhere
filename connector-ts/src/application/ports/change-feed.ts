/**
 * Committed-change notifications (04-connector.md §7). The store publishes `(sessionId, fromSeq, toSeq)`
 * after each commit; subscribers are the local host (Desktop reads its own store) and `Sessions/watch`
 * streams the Server opened. Nothing here is persisted: a subscriber that falls behind catches up from
 * the store by cursor.
 */
export interface ChangeNotice {
  sessionId: string
  fromSeq: number
  toSeq: number
  resetSeq: number
  /** The fence moved in this commit. */
  reset: boolean
}

export interface ChangeFeed {
  publish(notice: ChangeNotice): void
  /** Subscribes to one session (`*` for all); returns the unsubscribe function. */
  subscribe(sessionId: string, listener: (notice: ChangeNotice) => void): () => void
}
