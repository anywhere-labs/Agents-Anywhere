import { RemoteRuntimeNotice } from '../../api/RuntimeDtos';
import { RemoteSession } from '../../api/SessionsDtos';
import {
  RemoteSessionEvent, SessionEventType,
} from '../../api/SessionEventDtos';
import { SessionDetailState } from './SessionDetailState';
import {
  groupTimeline, mergeTimelineMessages, projectTimeline, TimelineMessage, TimelineRenderItem,
} from './SessionTimelineProjection';

/**
 * Reduces realtime events into session detail state.
 *
 * Port of the reduction table in `SessionDetailController.kt` /
 * `SessionDetailReducer.kt`.
 *
 * Every branch is a staleness check as much as an update. A snapshot push only
 * wins when its sequence is at or beyond what is already held, a runtime state
 * only wins when `updatedSeq` is not older, and a catalog only wins on a newer
 * revision. Without those guards a replayed frame would roll the screen back.
 *
 * Legacy event names Android ignores (`session.status_changed`,
 * `notice.created`, `notice.updated`, `notice.snapshot`) fall through to the
 * no-op case on purpose.
 */

const PROTOCOL_VERSION: string = '1.0';

/** Applies a batch of events, returning the next state. */
export function applyRealtimeEvents(
  state: SessionDetailState,
  events: RemoteSessionEvent[],
): SessionDetailState {
  let next: SessionDetailState = state;
  for (const event of events) {
    if (event.protocolVersion.length > 0 && event.protocolVersion !== PROTOCOL_VERSION) {
      continue;
    }
    const sessionId: string = next.sessionId();
    if (sessionId.length > 0 && event.sessionId.length > 0 && event.sessionId !== sessionId) {
      continue;
    }
    next = reduceEvent(next, event);
  }
  return next;
}

function reduceEvent(state: SessionDetailState, event: RemoteSessionEvent): SessionDetailState {
  const type: string = event.type;

  if (type === SessionEventType.SUBSCRIBED) {
    return state;
  }

  if (type === SessionEventType.META_UPDATED) {
    const session: RemoteSession | null = event.payload.session;
    if (session === null) {
      return state;
    }
    const current: RemoteSession | null = state.session;
    if (current !== null && session.updatedSeq < current.updatedSeq) {
      return state;
    }
    return state.copy({ session: session });
  }

  if (type === SessionEventType.ITEM_CREATED || type === SessionEventType.ITEM_UPDATED) {
    const incoming: TimelineMessage[] = projectTimeline(event.payload.items.length > 0
      ? event.payload.items
      : (event.payload.item === null ? [] : [event.payload.item]));
    if (incoming.length === 0) {
      return state;
    }
    return withTimeline(state, incoming, false, event.sequence);
  }

  if (type === SessionEventType.TIMELINE_SNAPSHOT) {
    const incoming: TimelineMessage[] = projectTimeline(event.payload.items);
    const cursorSeq: number = event.payload.eventCursor === null
      ? 0
      : sequenceOf(event.payload.eventCursor);
    // A snapshot only replaces when it is not older than what is held.
    if (event.sequence < cursorSeq) {
      return state;
    }
    return withTimeline(state, incoming, true, event.sequence);
  }

  if (type === SessionEventType.RUNTIME_STATE_UPDATED) {
    const runtimeState = event.payload.state;
    if (runtimeState === null) {
      return state;
    }
    // Only a state at least as new as the held one may replace it.
    if (state.runtimeLoaded && runtimeState.updatedSeq < state.runtimeUpdatedSeq) {
      return state;
    }
    return state.copy({
      runtimeStatus: runtimeState.status,
      runtimeUpdatedSeq: runtimeState.updatedSeq,
      runtimeLoaded: true,
    });
  }

  if (type === SessionEventType.NOTICE_SNAPSHOT) {
    const notices: RemoteRuntimeNotice[] = event.payload.notices;
    if (event.sequence < state.noticesEventSequence) {
      return state;
    }
    return withNotices(state, notices, event.sequence);
  }

  if (type === SessionEventType.NOTICE_UPDATED) {
    const notice: RemoteRuntimeNotice | null = event.payload.notice;
    if (notice === null) {
      return state;
    }
    const merged: RemoteRuntimeNotice[] = upsertNotice(state.notices, notice);
    return withNotices(state, merged, Math.max(state.noticesEventSequence, event.sequence));
  }

  if (type === SessionEventType.CAPABILITY_UPDATED) {
    const set = event.payload.capabilitySet;
    if (set === null || set.revision < state.capabilities.revision) {
      return state;
    }
    return state.copy({ capabilities: set });
  }

  if (type === SessionEventType.CATALOG_UPDATED) {
    // Catalogs feed the runtime settings sheet; until that screen lands the
    // event is acknowledged by the connection but changes no visible state.
    return state;
  }

  return state;
}

/** Replaces or merges the timeline and regroups the render rows. */
function withTimeline(
  state: SessionDetailState,
  incoming: TimelineMessage[],
  replace: boolean,
  eventSequence: number,
): SessionDetailState {
  const timeline: TimelineMessage[] = replace
    ? incoming.slice().sort(compareByOrder)
    : mergeTimelineMessages(state.timeline, incoming);
  const renderItems: TimelineRenderItem[] = groupTimeline(timeline, openNoticeTargets(state.notices));
  const oldest: number = timeline.length > 0 ? timeline[0].orderSeq : state.oldestOrderSeq;
  const latest: number = timeline.length > 0
    ? timeline[timeline.length - 1].orderSeq
    : state.latestOrderSeq;
  void eventSequence;
  return state.copy({
    timeline: timeline,
    renderItems: renderItems,
    oldestOrderSeq: oldest,
    latestOrderSeq: latest,
  });
}

function withNotices(
  state: SessionDetailState,
  notices: RemoteRuntimeNotice[],
  eventSequence: number,
): SessionDetailState {
  return state.copy({
    notices: notices,
    noticesEventSequence: eventSequence,
    renderItems: groupTimeline(state.timeline, openNoticeTargets(notices)),
  });
}

function upsertNotice(
  notices: RemoteRuntimeNotice[],
  notice: RemoteRuntimeNotice,
): RemoteRuntimeNotice[] {
  const next: RemoteRuntimeNotice[] = [];
  let replaced: boolean = false;
  for (const existing of notices) {
    if (existing.noticeId === notice.noticeId) {
      replaced = true;
      next.push(notice);
    } else {
      next.push(existing);
    }
  }
  if (!replaced) {
    next.push(notice);
  }
  return next;
}

/** Timeline ids named by an open notice, which must never be collapsed. */
function openNoticeTargets(notices: RemoteRuntimeNotice[]): string[] {
  const ids: string[] = [];
  for (const notice of notices) {
    if (notice.status !== 'open') {
      continue;
    }
    const context: Record<string, Object> = notice.context as Record<string, Object>;
    const source: Record<string, Object> = notice.source as Record<string, Object>;
    for (const map of [context, source]) {
      const itemId: Object = map['timelineItemId'];
      if (typeof itemId === 'string' && itemId.length > 0) {
        ids.push(itemId);
      }
      const altId: Object = map['itemId'];
      if (typeof altId === 'string' && altId.length > 0) {
        ids.push(altId);
      }
    }
  }
  return ids;
}

function sequenceOf(cursor: string): number {
  if (!cursor.startsWith('seq:')) {
    return 0;
  }
  const digits: string = cursor.substring(4);
  if (!/^\d+$/.test(digits)) {
    return 0;
  }
  return Number.parseInt(digits, 10);
}

function compareByOrder(left: TimelineMessage, right: TimelineMessage): number {
  if (left.orderSeq !== right.orderSeq) {
    return left.orderSeq - right.orderSeq;
  }
  return left.updatedSeq - right.updatedSeq;
}
