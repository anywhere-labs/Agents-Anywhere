import { RemoteRuntimeNotice } from '../../api/RuntimeDtos';
import { TimelineMessage } from './SessionTimelineProjection';

/**
 * Auto-follow rules for the conversation list.
 *
 * Port of `shouldAutoFollowRealtime` and `latestTimelineItemChanged` in
 * `ui/screens/sessiondetail/SessionMessages.kt` and `SessionDetailScreen.kt`.
 *
 * Android's list is reversed (index 0 is the newest message) and the screen
 * counts realtime updates in `streamLatestRequest` / `forceLatestRequest`. The
 * HarmonyOS list runs oldest-to-newest, so the same decision is expressed as a
 * scroll to the end; the *rules* are unchanged, and these two helpers are the
 * whole of the decision logic so they stay reviewable against the original.
 */

/**
 * True when a realtime update should pull the view to the newest message.
 *
 * Reading is not interrupted: a user who has scrolled away keeps their position
 * until they come back to the latest, and an update that arrives mid-gesture is
 * dropped rather than fighting the finger.
 */
export function shouldAutoFollowRealtime(
  hasRealtimeUpdate: boolean,
  autoFollowLatest: boolean,
  userPaused: boolean,
  scrolling: boolean,
): boolean {
  return hasRealtimeUpdate && autoFollowLatest && !userPaused && !scrolling;
}

/**
 * True when the newest visible conversation item changed.
 *
 * Only the last item is compared, because that is the one an auto-follow jump
 * is about; a late event that rewrites an older message must not move the view.
 */
export function latestTimelineItemChanged(
  before: TimelineMessage[],
  after: TimelineMessage[],
): boolean {
  const previous: TimelineMessage | null = before.length === 0 ? null : before[before.length - 1];
  const current: TimelineMessage | null = after.length === 0 ? null : after[after.length - 1];
  const previousId: string | null = previous === null ? null : previous.sourceItemId;
  const currentId: string | null = current === null ? null : current.sourceItemId;
  if (previousId !== currentId) {
    return true;
  }
  if (previous === null || current === null) {
    return previous === null && current === null ? false : true;
  }
  return previous.revision !== current.revision || previous.updatedSeq !== current.updatedSeq;
}

/**
 * True when the notice list changed.
 *
 * Android compares the two lists directly; notices are value types there, so a
 * change of id, revision or open state is what a comparison sees. Ids, revision
 * and status are compared here, which covers an arrival, a dismissal, a re-push
 * of the same notice and an answer that updates it in place.
 */
export function noticesChanged(
  before: RemoteRuntimeNotice[],
  after: RemoteRuntimeNotice[],
): boolean {
  if (before.length !== after.length) {
    return true;
  }
  for (let index = 0; index < before.length; index++) {
    const left: RemoteRuntimeNotice = before[index];
    const right: RemoteRuntimeNotice = after[index];
    if (left.noticeId !== right.noticeId || left.revision !== right.revision
      || left.updatedSeq !== right.updatedSeq || left.status !== right.status) {
      return true;
    }
  }
  return false;
}
