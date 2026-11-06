import { webSocket } from '@kit.NetworkKit';
import { RealtimeApi, sessionScope, TicketScope } from '../../api/RealtimeApi';
import { RemoteWsTicket } from '../../api/RealtimeDtos';
import {
  eventCursorSequence, parseSessionMessage, RemoteSessionEvent, RemoteSessionEvents,
  SessionEventType,
} from '../../api/SessionEventDtos';
import { SessionsApi } from '../../api/SessionsApi';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { RealtimeClientIdStore } from '../../storage/RealtimeClientIdStore';
import { reconnectDelayMillis } from './DashboardRealtimeController';
import { AALog } from '../../common/AAAppLog';

/**
 * Session realtime channel.
 *
 * Port of `feature/realtime/SessionRealtimeController.kt`.
 *
 * This is what makes the detail screen live: without it the user has to leave and
 * re-enter a session to see new messages.
 *
 * Three behaviours carry most of the correctness:
 *
 *  - **Batching.** Events are delivered in a fixed 34 ms window (about 30 Hz),
 *    closed by whichever of three limits is reached first. The window is never
 *    extended by a late message, so a busy stream cannot starve the UI.
 *  - **Recovery.** A reconnect does not replay from zero: it walks
 *    `/sessions/{id}/events` from the last known cursor, at most 8 pages, and
 *    asks for a full snapshot when the Server says so or when the walk runs out.
 *  - **Generations.** Each connection and each runtime refresh carries a
 *    generation, so a late response from a superseded connection cannot write
 *    into the session the user is now looking at.
 */

/** Fixed batching window: one frame at roughly 30 Hz. */
const EVENT_BATCH_WINDOW_MS: number = 34;
/** Most timeline upserts delivered in one batch. */
const MAX_TIMELINE_EVENT_BATCH_SIZE: number = 100;
/** Hard cap on wire events per batch, whatever their type. */
const MAX_WIRE_EVENT_BATCH_SIZE: number = 128;
/** Recovery pages before falling back to a snapshot. */
const MAX_RECOVERY_PAGES: number = 8;
/** Processed event ids retained for de-duplication, and the trim target. */
const MAX_PROCESSED_EVENT_IDS: number = 1000;
const PROCESSED_EVENT_TRIM: number = 500;

export type SessionEventsListener = (events: RemoteSessionEvent[]) => void;
export type SessionCursorListener = (cursor: string) => void;
export type SessionSnapshotRequiredListener = (reason: string) => void;
export type SessionRuntimeRefreshListener = (connectionGeneration: number, refreshGeneration: number) => void;
export type SessionConnectionListener =
  (connected: boolean, recovering: boolean, attempt: number, error: string | null) => void;

export class SessionRealtimeController {
  private readonly realtimeApi: RealtimeApi;
  private readonly sessionsApi: SessionsApi;
  private readonly sessionStore: AuthSessionStore;
  private readonly clientIdStore: RealtimeClientIdStore;

  private running: boolean = false;
  private sessionId: string = '';
  private cursorProvider: () => string = () => 'seq:0';

  private generationSequence: number = 0;
  private activeConnectionGeneration: number = 0;
  private runtimeRefreshSequence: number = 0;
  private activeRuntimeRefreshGeneration: number = 0;

  private socket: webSocket.WebSocket | null = null;
  private waitTimer: number = -1;
  private pendingWaitResolve: (() => void) | null = null;
  private batchTimer: number = -1;
  private pendingBatch: RemoteSessionEvent[] = [];
  private pendingTimelineUpserts: number = 0;

  /** Per-connection guard: a snapshot is requested once per cursor. */
  private lastSnapshotRequiredCursor: string = '';
  private processedEventIds: string[] = [];
  private processedEventIdSet: Set<string> = new Set();

  private onEvents: SessionEventsListener = () => {};
  private onCursorAdvanced: SessionCursorListener = () => {};
  private onSnapshotRequired: SessionSnapshotRequiredListener = () => {};
  private onRuntimeRefreshRequired: SessionRuntimeRefreshListener = () => {};
  private onConnectionChanged: SessionConnectionListener = () => {};

  constructor(
    realtimeApi: RealtimeApi,
    sessionsApi: SessionsApi,
    sessionStore: AuthSessionStore,
    clientIdStore: RealtimeClientIdStore,
  ) {
    this.realtimeApi = realtimeApi;
    this.sessionsApi = sessionsApi;
    this.sessionStore = sessionStore;
    this.clientIdStore = clientIdStore;
  }

  /**
   * Starts the loop for one session.
   *
   * `cursorProvider` is read on every reconnect so recovery resumes from the
   * latest position the reducer has advanced to, not from the position captured
   * when the screen opened.
   */
  start(
    sessionId: string,
    cursorProvider: () => string,
    onEvents: SessionEventsListener,
    onCursorAdvanced: SessionCursorListener,
    onSnapshotRequired: SessionSnapshotRequiredListener,
    onRuntimeRefreshRequired: SessionRuntimeRefreshListener,
    onConnectionChanged: SessionConnectionListener,
  ): void {
    this.stop();
    this.sessionId = sessionId;
    this.cursorProvider = cursorProvider;
    this.onEvents = onEvents;
    this.onCursorAdvanced = onCursorAdvanced;
    this.onSnapshotRequired = onSnapshotRequired;
    this.onRuntimeRefreshRequired = onRuntimeRefreshRequired;
    this.onConnectionChanged = onConnectionChanged;
    this.running = true;
    this.generationSequence += 1;
    const generation: number = this.generationSequence;
    void this.runLoop(generation);
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.generationSequence += 1;
    this.activeConnectionGeneration = 0;
    this.activeRuntimeRefreshGeneration = 0;
    this.cancelWait();
    this.clearBatch();
    this.closeSocket();
  }

  requestImmediateReconnect(): void {
    if (!this.running) {
      return;
    }
    this.closeSocket();
    this.cancelWait();
  }

  /** True when `generation` still owns the connection. */
  isCurrentConnection(generation: number): boolean {
    return this.activeConnectionGeneration === generation;
  }

  /** True when this runtime refresh is still the newest one. */
  isCurrentRuntimeRefresh(connectionGeneration: number, refreshGeneration: number): boolean {
    return this.activeConnectionGeneration === connectionGeneration
      && this.activeRuntimeRefreshGeneration === refreshGeneration;
  }

  private async runLoop(generation: number): Promise<void> {
    let attempt: number = 0;
    let hasConnected: boolean = false;
    while (this.running && generation === this.generationSequence) {
      const serverUrl: string = this.sessionStore.readServerUrl();
      const token: string = this.sessionStore.readAccessToken();
      if (serverUrl.length === 0 || token.length === 0 || this.sessionId.length === 0) {
        return;
      }

      let opened: boolean = false;
      try {
        const scope: TicketScope = sessionScope(this.sessionId);
        const ticket: RemoteWsTicket = await this.realtimeApi.createTicket(
          serverUrl, token, this.clientIdStore.clientId(), scope,
        );
        if (!this.running || generation !== this.generationSequence) {
          return;
        }
        const url: string = this.realtimeApi.sessionSocketUrl(serverUrl, this.sessionId, ticket.ticket);
        opened = await this.consumeSocket(url, generation, hasConnected);
        hasConnected = hasConnected || opened;
      } catch (error) {
        AALog.warn(`Session socket failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }

      if (!this.running || generation !== this.generationSequence) {
        return;
      }
      this.onConnectionChanged(false, false, attempt, null);
      attempt = opened ? 0 : Math.min(attempt + 1, 30);
      await this.wait(reconnectDelayMillis(attempt));
    }
  }

  /** Runs one socket lifetime; resolves true when at least one frame arrived. */
  private consumeSocket(url: string, generation: number, hasConnected: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket: webSocket.WebSocket = webSocket.createWebSocket();
      this.socket = socket;
      const connectionGeneration: number = ++this.generationSequence;
      this.activeConnectionGeneration = connectionGeneration;
      this.lastSnapshotRequiredCursor = '';
      let received: boolean = false;
      let settled: boolean = false;
      let subscribed: boolean = hasConnected;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearBatch();
        try {
          socket.off('message');
          socket.off('open');
          socket.off('close');
          socket.off('error');
          socket.close({ code: 1000, reason: 'replace' });
        } catch (error) {
          AALog.debug('Session socket cleanup failed');
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        if (this.activeConnectionGeneration === connectionGeneration) {
          this.activeConnectionGeneration = 0;
          this.activeRuntimeRefreshGeneration = 0;
        }
        resolve(received);
      };

      socket.on('open', () => {
        if (generation !== this.generationSequence) {
          finish();
          return;
        }
        this.onConnectionChanged(true, hasConnected, 0, null);
        if (hasConnected) {
          // A reconnect recovers before the first frame arrives, because the
          // Server may only send a snapshot and never a `session.subscribed`.
          void this.recoverAndRefresh(generation, connectionGeneration);
        }
      });

      socket.on('message', (error, value: string | ArrayBuffer) => {
        if (generation !== this.generationSequence || typeof value !== 'string') {
          return;
        }
        const event: RemoteSessionEvent | null = parseSessionMessage(value);
        if (event === null) {
          return;
        }
        received = true;

        // Control events act immediately rather than through the batch window.
        if (event.type === SessionEventType.SUBSCRIBED && !subscribed) {
          subscribed = true;
          this.onConnectionChanged(true, true, 0, null);
          void this.recoverAndRefresh(generation, connectionGeneration);
          return;
        }
        if (event.type === SessionEventType.SESSION_REFETCH) {
          this.requestSnapshotOnce('session.refetch_required', connectionGeneration);
          return;
        }
        if (event.type === SessionEventType.RUNTIME_REFETCH) {
          this.refreshRuntime(generation, connectionGeneration);
          return;
        }

        this.enqueue(event, generation);
      });

      socket.on('close', () => finish());
      socket.on('error', () => finish());

      socket.connect(url, (error) => {
        if (error !== undefined && error !== null && error.code !== 0) {
          finish();
        }
      });
    });
  }

  /** First-connect and reconnect recovery, then a runtime refresh. */
  private async recoverAndRefresh(generation: number, connectionGeneration: number): Promise<void> {
    const cursor: string = this.cursorProvider();
    if (this.lastSnapshotRequiredCursor !== cursor) {
      await this.recoverFrom(cursor, generation);
    }
    this.refreshRuntime(generation, connectionGeneration);
  }

  /** Starts a runtime-only refresh guarded by a generation. */
  private refreshRuntime(generation: number, connectionGeneration: number): void {
    if (generation !== this.generationSequence) {
      return;
    }
    this.activeRuntimeRefreshGeneration = ++this.runtimeRefreshSequence;
    this.onRuntimeRefreshRequired(connectionGeneration, this.activeRuntimeRefreshGeneration);
  }

  private requestSnapshotOnce(reason: string, connectionGeneration: number): void {
    if (connectionGeneration !== this.activeConnectionGeneration) {
      return;
    }
    const cursor: string = this.cursorProvider();
    if (cursor === this.lastSnapshotRequiredCursor) {
      return;
    }
    this.lastSnapshotRequiredCursor = cursor;
    this.onSnapshotRequired(reason);
  }

  /** Walks `/events` from `cursor`, at most `MAX_RECOVERY_PAGES` times. */
  private async recoverFrom(cursor: string, generation: number): Promise<void> {
    const serverUrl: string = this.sessionStore.readServerUrl();
    const token: string = this.sessionStore.readAccessToken();
    let current: string = cursor;
    for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
      let response: RemoteSessionEvents;
      try {
        response = await this.sessionsApi.events(serverUrl, token, this.sessionId, current);
      } catch (error) {
        AALog.warn(`Event recovery failed: ${error instanceof Error ? error.message : 'unknown'}`);
        return;
      }
      if (!this.running || generation !== this.generationSequence) {
        return;
      }
      if (response.snapshotRequired) {
        this.onSnapshotRequired('events.snapshotRequired');
        return;
      }

      const ordered: RemoteSessionEvent[] = response.events.slice().sort(compareEvents);
      if (ordered.length > 0) {
        this.onEvents(ordered);
        this.markProcessed(ordered);
      }
      this.onCursorAdvanced(response.nextCursor);

      // Stop when the Server stops moving, matching Android's two checks.
      if (response.nextCursor === current) {
        return;
      }
      const nextSeq: number | null = eventCursorSequence(response.nextCursor);
      const lastSeq: number = ordered.length > 0 ? ordered[ordered.length - 1].sequence : 0;
      if (nextSeq !== null && lastSeq >= nextSeq) {
        return;
      }
      current = response.nextCursor;
    }
    this.onSnapshotRequired('events.recoveryLimit');
  }

  private enqueue(event: RemoteSessionEvent, generation: number): void {
    if (this.isProcessed(event.eventId)) {
      return;
    }
    this.pendingBatch.push(event);
    if (isTimelineUpsert(event)) {
      this.pendingTimelineUpserts += 1;
    }
    if (this.pendingBatch.length >= MAX_WIRE_EVENT_BATCH_SIZE
      || this.pendingTimelineUpserts >= MAX_TIMELINE_EVENT_BATCH_SIZE) {
      this.flushBatch(generation);
      return;
    }
    if (this.batchTimer === -1) {
      // The window is opened once and never extended, so a busy stream cannot
      // postpone delivery indefinitely.
      this.batchTimer = setTimeout(() => {
        this.flushBatch(generation);
      }, EVENT_BATCH_WINDOW_MS);
    }
  }

  private flushBatch(generation: number): void {
    if (this.batchTimer !== -1) {
      clearTimeout(this.batchTimer);
      this.batchTimer = -1;
    }
    const batch: RemoteSessionEvent[] = this.pendingBatch;
    this.pendingBatch = [];
    this.pendingTimelineUpserts = 0;
    if (batch.length === 0 || generation !== this.generationSequence) {
      return;
    }
    this.markProcessed(batch);
    this.onEvents(batch);
  }

  private clearBatch(): void {
    if (this.batchTimer !== -1) {
      clearTimeout(this.batchTimer);
      this.batchTimer = -1;
    }
    this.pendingBatch = [];
    this.pendingTimelineUpserts = 0;
  }

  private isProcessed(eventId: string): boolean {
    return this.processedEventIdSet.has(eventId);
  }

  /** Retains a bounded window of ids so a replayed frame is not applied twice. */
  private markProcessed(events: RemoteSessionEvent[]): void {
    for (const event of events) {
      if (event.eventId.length === 0 || this.processedEventIdSet.has(event.eventId)) {
        continue;
      }
      this.processedEventIds.push(event.eventId);
      this.processedEventIdSet.add(event.eventId);
    }
    if (this.processedEventIds.length > MAX_PROCESSED_EVENT_IDS) {
      const kept: string[] = this.processedEventIds.slice(-PROCESSED_EVENT_TRIM);
      this.processedEventIds = kept;
      this.processedEventIdSet = new Set(kept);
    }
  }

  private closeSocket(): void {
    const socket: webSocket.WebSocket | null = this.socket;
    this.socket = null;
    if (socket === null) {
      return;
    }
    try {
      socket.close({ code: 1000, reason: 'closed' });
    } catch (error) {
      AALog.debug('Session socket close failed');
    }
  }

  private wait(millis: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingWaitResolve = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = -1;
        this.pendingWaitResolve = null;
        resolve();
      }, millis);
    });
  }

  private cancelWait(): void {
    if (this.waitTimer !== -1) {
      clearTimeout(this.waitTimer);
      this.waitTimer = -1;
    }
    const resolve: (() => void) | null = this.pendingWaitResolve;
    this.pendingWaitResolve = null;
    if (resolve !== null) {
      resolve();
    }
  }
}

/** Timeline mutation events, which are what the batch cap counts. */
function isTimelineUpsert(event: RemoteSessionEvent): boolean {
  return event.type === SessionEventType.ITEM_CREATED
    || event.type === SessionEventType.ITEM_UPDATED
    || event.type === SessionEventType.TIMELINE_SNAPSHOT;
}

/** Sort by sequence then event id, matching Android's recovery ordering. */
export function compareEvents(left: RemoteSessionEvent, right: RemoteSessionEvent): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.eventId === right.eventId) {
    return 0;
  }
  return left.eventId < right.eventId ? -1 : 1;
}
