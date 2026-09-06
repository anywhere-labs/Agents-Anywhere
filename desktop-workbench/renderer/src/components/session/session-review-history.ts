export type ReviewHistoryState<T> = {
  items: T[]
  hasMore: boolean | null
  error: string | null
  resetVersion: number | null
}

export type ReviewTimelineState<T> = {
  items: T[]
  hasMore: boolean
  resetVersion: number
}

export function nextTimelineResetVersion(current: number, authoritativeReset: boolean): number {
  return authoritativeReset ? current + 1 : current
}

export function emptyReviewHistory<T>(resetVersion: number | null = null): ReviewHistoryState<T> {
  return {
    items: [],
    hasMore: null,
    error: null,
    resetVersion,
  }
}

export function reviewHistoryForResetVersion<T>(
  history: ReviewHistoryState<T>,
  resetVersion: number,
): ReviewHistoryState<T> {
  return history.resetVersion === resetVersion
    ? history
    : emptyReviewHistory(resetVersion)
}

export function combineReviewTimeline<T>(
  history: ReviewHistoryState<T>,
  timeline: ReviewTimelineState<T>,
  mergeItems: (historyItems: T[], timelineItems: T[]) => T[],
): { items: T[]; hasMore: boolean; error: string | null } {
  const currentHistory = reviewHistoryForResetVersion(history, timeline.resetVersion)
  return {
    items: mergeItems(currentHistory.items, timeline.items),
    hasMore: currentHistory.hasMore ?? timeline.hasMore,
    error: currentHistory.error,
  }
}

export function updateReviewHistoryForResetVersion<T>(
  history: ReviewHistoryState<T>,
  resetVersion: number,
  update: (current: ReviewHistoryState<T>) => ReviewHistoryState<T>,
): ReviewHistoryState<T> {
  if (history.resetVersion !== resetVersion) return history
  return update(history)
}
