import { AuthApi } from '../api/AuthApi';
import { AppUpdatesApi } from '../api/AppUpdatesApi';
import { AppUpdateController } from '../feature/update/AppUpdateController';
import { DevicesApi } from '../api/DevicesApi';
import { FilesApi } from '../api/FilesApi';
import { HttpTransport } from '../api/HttpTransport';
import { ProjectsApi } from '../api/ProjectsApi';
import { RealtimeApi } from '../api/RealtimeApi';
import { SessionsApi } from '../api/SessionsApi';
import { TerminalApi } from '../api/TerminalApi';
import { AuthController } from '../feature/auth/AuthController';
import { DashboardRealtimeController } from '../feature/realtime/DashboardRealtimeController';
import { DevicesController } from '../feature/devices/DevicesController';
import { FilesController } from '../feature/files/FilesController';
import { SessionsController } from '../feature/sessions/SessionsController';
import { ProjectSessionLoader } from '../feature/sessions/ProjectSessionLoader';
import { SessionDetailController } from '../feature/sessiondetail/SessionDetailController';
import { SessionRealtimeController } from '../feature/realtime/SessionRealtimeController';
import { TerminalController } from '../feature/terminal/TerminalController';
import { RemoteTerminalPool } from '../feature/terminal/RemoteTerminalPool';
import { AuthSessionStore } from '../storage/AuthSessionStore';
import { RealtimeClientIdStore } from '../storage/RealtimeClientIdStore';
import { UiPreferences } from '../storage/UiPreferences';

/**
 * Dependency assembly.
 *
 * Android builds the same graph inside `AgentsAnywhereApp` with `remember` calls
 * keyed on the account. A single holder keeps the wiring in one place so the
 * composition root stays about layout and navigation.
 *
 * The 401 callback is injected because it belongs to the app scope: a rejected
 * token must clear the stored credential and send the user back to the sign-in
 * screen, no matter which request failed.
 */
export class AppServices {
  readonly sessionStore: AuthSessionStore;
  readonly transport: HttpTransport;
  readonly authApi: AuthApi;
  readonly authController: AuthController;
  readonly sessionsApi: SessionsApi;
  readonly projectsApi: ProjectsApi;
  readonly devicesApi: DevicesApi;
  readonly filesApi: FilesApi;
  readonly realtimeApi: RealtimeApi;
  readonly terminalApi: TerminalApi;
  readonly sessionsController: SessionsController;
  readonly devicesController: DevicesController;
  readonly filesController: FilesController;
  readonly projectSessionLoader: ProjectSessionLoader;
  readonly sessionDetailController: SessionDetailController;
  readonly sessionRealtime: SessionRealtimeController;
  readonly dashboardRealtime: DashboardRealtimeController;
  readonly terminalController: TerminalController;
  readonly terminalPool: RemoteTerminalPool;
  readonly appUpdatesApi: AppUpdatesApi;
  readonly appUpdates: AppUpdateController;
  readonly uiPreferences: UiPreferences;
  readonly realtimeClientId: RealtimeClientIdStore;

  constructor(onUnauthorized: (accessToken: string) => void) {
    this.sessionStore = new AuthSessionStore();
    this.transport = new HttpTransport(onUnauthorized);
    this.authApi = new AuthApi(this.transport);
    this.authController = new AuthController(this.sessionStore, this.transport, this.authApi);
    this.sessionsApi = new SessionsApi(this.transport);
    this.projectsApi = new ProjectsApi(this.transport);
    this.devicesApi = new DevicesApi(this.transport);
    this.filesApi = new FilesApi(this.transport);
    this.realtimeApi = new RealtimeApi(this.transport);
    this.terminalApi = new TerminalApi(this.transport);
    // Both realtime controllers share one client id, so it is built first.
    this.realtimeClientId = new RealtimeClientIdStore();
    this.sessionsController = new SessionsController(
      this.sessionsApi, this.projectsApi, this.devicesApi, this.filesApi, this.sessionStore,
    );
    this.devicesController = new DevicesController(this.devicesApi, this.sessionStore);
    this.filesController = new FilesController(this.filesApi, this.sessionStore);
    this.projectSessionLoader = new ProjectSessionLoader(this.sessionsApi, this.sessionStore);
    this.sessionDetailController = new SessionDetailController(this.sessionsApi, this.sessionStore);
    this.sessionRealtime = new SessionRealtimeController(
      this.realtimeApi, this.sessionsApi, this.sessionStore, this.realtimeClientId,
    );
    this.dashboardRealtime = new DashboardRealtimeController(
      this.realtimeApi, this.sessionStore, this.realtimeClientId,
    );
    this.terminalController = new TerminalController(this.terminalApi, this.sessionStore);
    // One controller per device survives navigation, so a terminal can be left
    // and come back to without killing the shell.
    this.terminalPool = new RemoteTerminalPool(this.terminalController);
    this.appUpdatesApi = new AppUpdatesApi(this.transport);
    this.appUpdates = new AppUpdateController(this.appUpdatesApi, this.sessionStore);
    this.uiPreferences = new UiPreferences();
  }

  /** The stored session, or an empty string when signed out. */
  serverUrl(): string {
    return this.sessionStore.readServerUrl();
  }

  accessToken(): string {
    return this.sessionStore.readAccessToken();
  }

  hasAuthSession(): boolean {
    return this.sessionStore.hasAuthSession();
  }

  /** Stops every long-lived connection; called on sign-out. */
  disposeConnections(): void {
    this.dashboardRealtime.stop();
    this.sessionRealtime.stop();
    this.projectSessionLoader.reset();
    this.terminalPool.disposeLocal();
    this.appUpdates.syncSession(false);
  }
}
