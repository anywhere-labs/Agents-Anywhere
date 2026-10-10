import { RemoteRuntimeCapabilitySet, RemoteRuntimeNotice, RuntimeStatus } from '../../api/RuntimeDtos';
import { RemoteSession } from '../../api/SessionsDtos';
import {
  TimelineMessage, TimelineRenderItem,
} from './SessionTimelineProjection';

/**
 * Session detail page state.
 *
 * Port of the state portion of `feature/sessiondetail/SessionDetailState.kt`.
 *
 * Replaced rather than mutated, for the same reason as `SessionsState`: ArkUI
 * tracks a `@State` field by reference.
 *
 * The timeline is held both as projected messages and as grouped render items,
 * because grouping depends on which notices are open and therefore has to be
 * recomputed whenever either changes.
 */

/** Optional overrides for `SessionDetailState.copy`. */
export interface SessionDetailStatePatch {
  /** Optional so callers can patch one field; `null` clears the session. */
  session?: RemoteSession | null;
  timeline?: TimelineMessage[];
  renderItems?: TimelineRenderItem[];
  notices?: RemoteRuntimeNotice[];
  capabilities?: RemoteRuntimeCapabilitySet;
  runtimeStatus?: string;
  eventCursor?: string;
  hasMore?: boolean;
  oldestOrderSeq?: number;
  latestOrderSeq?: number;
  loading?: boolean;
  initialized?: boolean;
  errorMessage?: string | null;
  sending?: boolean;
  interrupting?: boolean;
  takeoverBusy?: boolean;
  loadingOlder?: boolean;
  /** Sequence of the last notice event applied, used to reject older pushes. */
  noticesEventSequence?: number;
  /** `updatedSeq` of the applied runtime state, used for the same reason. */
  runtimeUpdatedSeq?: number;
  /** False until any runtime state has been applied. */
  runtimeLoaded?: boolean;
}

export class SessionDetailState {
  readonly session: RemoteSession | null;
  readonly timeline: TimelineMessage[];
  readonly renderItems: TimelineRenderItem[];
  readonly notices: RemoteRuntimeNotice[];
  readonly capabilities: RemoteRuntimeCapabilitySet;
  readonly runtimeStatus: string;
  /** Server cursor the realtime channel resumes from. */
  readonly eventCursor: string;
  readonly hasMore: boolean;
  /** Ordering bounds used for the history paging cursor. */
  readonly oldestOrderSeq: number;
  readonly latestOrderSeq: number;
  readonly loading: boolean;
  /** True once a snapshot has been applied, which gates realtime subscription. */
  readonly initialized: boolean;
  readonly errorMessage: string | null;
  readonly sending: boolean;
  readonly interrupting: boolean;
  readonly takeoverBusy: boolean;
  readonly loadingOlder: boolean;
  readonly noticesEventSequence: number;
  readonly runtimeUpdatedSeq: number;
  readonly runtimeLoaded: boolean;

  constructor(patch: Required<SessionDetailStatePatch>) {
    this.session = patch.session;
    this.timeline = patch.timeline;
    this.renderItems = patch.renderItems;
    this.notices = patch.notices;
    this.capabilities = patch.capabilities;
    this.runtimeStatus = patch.runtimeStatus;
    this.eventCursor = patch.eventCursor;
    this.hasMore = patch.hasMore;
    this.oldestOrderSeq = patch.oldestOrderSeq;
    this.latestOrderSeq = patch.latestOrderSeq;
    this.loading = patch.loading;
    this.initialized = patch.initialized;
    this.errorMessage = patch.errorMessage;
    this.sending = patch.sending;
    this.interrupting = patch.interrupting;
    this.takeoverBusy = patch.takeoverBusy;
    this.loadingOlder = patch.loadingOlder;
    this.noticesEventSequence = patch.noticesEventSequence;
    this.runtimeUpdatedSeq = patch.runtimeUpdatedSeq;
    this.runtimeLoaded = patch.runtimeLoaded;
  }

  static empty(): SessionDetailState {
    return new SessionDetailState({
      session: null,
      timeline: [],
      renderItems: [],
      notices: [],
      capabilities: { revision: 0, capabilities: [] },
      runtimeStatus: RuntimeStatus.UNKNOWN,
      eventCursor: 'seq:0',
      hasMore: false,
      oldestOrderSeq: 0,
      latestOrderSeq: 0,
      loading: false,
      initialized: false,
      errorMessage: null,
      sending: false,
      interrupting: false,
      takeoverBusy: false,
      loadingOlder: false,
      noticesEventSequence: 0,
      runtimeUpdatedSeq: 0,
      runtimeLoaded: false,
    });
  }

  copy(patch: SessionDetailStatePatch): SessionDetailState {
    return new SessionDetailState({
      session: patch.session !== undefined ? patch.session : this.session,
      timeline: patch.timeline ?? this.timeline,
      renderItems: patch.renderItems ?? this.renderItems,
      notices: patch.notices ?? this.notices,
      capabilities: patch.capabilities ?? this.capabilities,
      runtimeStatus: patch.runtimeStatus ?? this.runtimeStatus,
      eventCursor: patch.eventCursor ?? this.eventCursor,
      hasMore: patch.hasMore ?? this.hasMore,
      oldestOrderSeq: patch.oldestOrderSeq ?? this.oldestOrderSeq,
      latestOrderSeq: patch.latestOrderSeq ?? this.latestOrderSeq,
      loading: patch.loading ?? this.loading,
      initialized: patch.initialized ?? this.initialized,
      errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : this.errorMessage,
      sending: patch.sending ?? this.sending,
      interrupting: patch.interrupting ?? this.interrupting,
      takeoverBusy: patch.takeoverBusy ?? this.takeoverBusy,
      loadingOlder: patch.loadingOlder ?? this.loadingOlder,
      noticesEventSequence: patch.noticesEventSequence ?? this.noticesEventSequence,
      runtimeUpdatedSeq: patch.runtimeUpdatedSeq ?? this.runtimeUpdatedSeq,
      runtimeLoaded: patch.runtimeLoaded ?? this.runtimeLoaded,
    });
  }

  /** The session id, or an empty string before the first load. */
  sessionId(): string {
    return this.session === null ? '' : this.session.id;
  }

  /** True while a turn is in flight, which decides interrupt vs send. */
  isTurnActive(): boolean {
    return this.runtimeStatus === RuntimeStatus.RUNNING
      || this.runtimeStatus === RuntimeStatus.WAITING
      || this.runtimeStatus === RuntimeStatus.PENDING
      || this.runtimeStatus === RuntimeStatus.STOPPING
      || this.runtimeStatus === RuntimeStatus.WAITING_APPROVAL
      || this.runtimeStatus === RuntimeStatus.BLOCKED;
  }

  /** Open notices only, which is what the blocking stack and cards show. */
  openNotices(): RemoteRuntimeNotice[] {
    const open: RemoteRuntimeNotice[] = [];
    for (const notice of this.notices) {
      if (notice.status === 'open') {
        open.push(notice);
      }
    }
    return open;
  }
}
