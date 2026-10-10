import { webSocket } from '@kit.NetworkKit';
import { RealtimeApi, dashboardScope, TicketScope } from '../../api/RealtimeApi';
import { DashboardSnapshot } from '../../api/RealtimeDtos';
import { RemoteWsTicket } from '../../api/RealtimeDtos';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { RealtimeClientIdStore } from '../../storage/RealtimeClientIdStore';
import { AALog } from '../../common/AAAppLog';

/**
 * Dashboard realtime channel.
 *
 * Port of `feature/realtime/DashboardRealtimeController.kt`.
 *
 * The dashboard socket is the primary list transport: the Server pushes whole
 * snapshots rather than deltas, so there is no fixed polling loop. HTTP is only
 * the fallback when the socket cannot deliver a first snapshot.
 *
 * Retry pacing, in milliseconds, matching Android exactly:
 *
 * | attempt | delay        |
 * | ------- | ------------ |
 * | 0       | 1000–1250    |
 * | 1       | 2000–2500    |
 * | 2       | 4000–5000    |
 * | 3       | 8000–10000   |
 * | 4       | 16000–20000  |
 * | ≥5      | 30000 exact  |
 *
 * The wait is interruptible so regaining connectivity reconnects immediately
 * instead of serving out the remaining backoff.
 */

/** How long to wait for the first snapshot before falling back to HTTP. */
const INITIAL_SNAPSHOT_TIMEOUT_MS: number = 2500;
const MAX_BACKOFF_ATTEMPT: number = 30;

export type DashboardSnapshotListener = (snapshot: DashboardSnapshot) => void;
export type ConnectionListener = (connected: boolean, attempt: number) => void;
export type InitialFailureListener = () => void;

/** The retry delay Android computes for a given attempt. */
export function reconnectDelayMillis(attempt: number): number {
  const capped: number = Math.min(attempt, 5);
  const base: number = Math.min(1000 * Math.pow(2, capped), 30_000);
  const jitter: number = base * 0.25 * Math.random();
  return Math.min(base + jitter, 30_000);
}

export class DashboardRealtimeController {
  private readonly realtimeApi: RealtimeApi;
  private readonly sessionStore: AuthSessionStore;
  private readonly clientIdStore: RealtimeClientIdStore;

  private onSnapshot: DashboardSnapshotListener = () => {};
  private onConnectionChanged: ConnectionListener = () => {};
  private onInitialFailure: InitialFailureListener = () => {};

  private running: boolean = false;
  private generation: number = 0;
  private socket: webSocket.WebSocket | null = null;
  private waitTimer: number = -1;
  private pendingWaitResolve: (() => void) | null = null;

  constructor(
    realtimeApi: RealtimeApi,
    sessionStore: AuthSessionStore,
    clientIdStore: RealtimeClientIdStore,
  ) {
    this.realtimeApi = realtimeApi;
    this.sessionStore = sessionStore;
    this.clientIdStore = clientIdStore;
  }

  /** Starts the loop. Calling it while running replaces the previous loop. */
  start(
    onSnapshot: DashboardSnapshotListener,
    onConnectionChanged: ConnectionListener,
    onInitialFailure: InitialFailureListener,
  ): void {
    this.stop();
    this.onSnapshot = onSnapshot;
    this.onConnectionChanged = onConnectionChanged;
    this.onInitialFailure = onInitialFailure;
    this.running = true;
    this.generation += 1;
    const generation: number = this.generation;
    void this.runLoop(generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.cancelWait();
    this.closeSocket();
  }

  /** Cancels any pending backoff and reconnects immediately. */
  requestImmediateReconnect(): void {
    if (!this.running) {
      return;
    }
    this.closeSocket();
    this.cancelWait();
  }

  private async runLoop(generation: number): Promise<void> {
    let attempt: number = 0;
    while (this.running && generation === this.generation) {
      const serverUrl: string = this.sessionStore.readServerUrl();
      const token: string = this.sessionStore.readAccessToken();
      if (serverUrl.length === 0 || token.length === 0) {
        // Signed out; the loop ends and a later start() will resume it.
        return;
      }

      let opened: boolean = false;
      try {
        const scope: TicketScope = dashboardScope();
        const ticket: RemoteWsTicket = await this.realtimeApi.createTicket(
          serverUrl, token, this.clientIdStore.clientId(), scope,
        );
        if (!this.running || generation !== this.generation) {
          return;
        }
        const url: string = this.realtimeApi.dashboardSocketUrl(serverUrl, ticket.ticket);
        const received: boolean = await this.consumeSocket(url, generation, attempt);
        opened = received;
      } catch (error) {
        AALog.warn(`Dashboard socket failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }

      if (!this.running || generation !== this.generation) {
        return;
      }
      this.onConnectionChanged(false, attempt);
      attempt = opened ? 0 : Math.min(attempt + 1, MAX_BACKOFF_ATTEMPT);
      await this.wait(reconnectDelayMillis(attempt));
    }
  }

  /**
   * Runs one socket lifetime.
   *
   * Returns true when at least one frame arrived, which is what resets the
   * backoff: a socket that opened and then died still counts as progress.
   */
  private consumeSocket(url: string, generation: number, attempt: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket: webSocket.WebSocket = webSocket.createWebSocket();
      this.socket = socket;
      let received: boolean = false;
      let settled: boolean = false;
      let snapshotTimer: number = -1;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (snapshotTimer !== -1) {
          clearTimeout(snapshotTimer);
          snapshotTimer = -1;
        }
        try {
          socket.off('message');
          socket.off('open');
          socket.off('close');
          socket.off('error');
          socket.close({ code: 1000, reason: 'replace' });
        } catch (error) {
          AALog.debug('Dashboard socket cleanup failed');
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        resolve(received);
      };

      socket.on('open', () => {
        if (generation !== this.generation) {
          finish();
          return;
        }
        this.onConnectionChanged(true, 0);
      });

      socket.on('message', (error, value: string | ArrayBuffer) => {
        if (generation !== this.generation) {
          finish();
          return;
        }
        if (typeof value !== 'string') {
          return;
        }
        const snapshot: DashboardSnapshot | null = this.realtimeApi.parseDashboard(value);
        if (snapshot !== null) {
          received = true;
          this.onSnapshot(snapshot);
        } else if (!received) {
          // Keep waiting for the first snapshot; other frames are ignored.
          return;
        }
      });

      socket.on('close', () => finish());
      socket.on('error', () => finish());

      socket.connect(url, (error) => {
        if (error !== undefined && error !== null && error.code !== 0) {
          finish();
          return;
        }
        // If nothing usable arrives in time, ask the app to fall back to HTTP.
        snapshotTimer = setTimeout(() => {
          if (generation !== this.generation) {
            return;
          }
          if (!received) {
            this.onInitialFailure();
          }
        }, INITIAL_SNAPSHOT_TIMEOUT_MS);
        void attempt;
      });
    });
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
      AALog.debug('Dashboard socket close failed');
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
