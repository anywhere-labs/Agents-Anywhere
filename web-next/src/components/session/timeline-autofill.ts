/**
 * The first page of a session can be shorter than the viewport. Nothing can be
 * scrolled then, so the scroll handler that loads older pages never runs and
 * the rest of the history stays unreachable. Ask for another page until the
 * timeline can actually scroll, or until the history runs out.
 */
export function needsOlderTimelinePage(
  viewport: { scrollHeight: number; clientHeight: number } | null,
  hasMore: boolean,
): boolean {
  if (!hasMore || !viewport) return false
  // A hidden timeline reports 0 for both sizes; that is not a short page.
  if (viewport.clientHeight <= 0) return false
  return viewport.scrollHeight <= viewport.clientHeight
}
