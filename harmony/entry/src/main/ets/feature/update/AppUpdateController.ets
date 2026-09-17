import { AndroidAppRelease } from '../../api/AppUpdatesApi';
import { compareUpdateVersions } from '../../api/UpdateVersion';
import { AAPreferenceNames, AAPreferenceStore } from '../../storage/AAPreferences';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { AppUpdatesApi } from '../../api/AppUpdatesApi';
import { AppConfig } from '../../config/AppConfig';
import { AALog } from '../../common/AAAppLog';

/**
 * The in-app update check.
 *
 * Port of `feature/update/AppUpdateViewModel.kt`.
 *
 * Android also downloads and installs the APK; HarmonyOS has neither an APK nor
 * a silent install, so the port keeps the whole *decision* half — check, the
 * prompt, and the "ignore this version" preference — and stops at "open the
 * download page" (see the deviation table).
 *
 * Two guards are load-bearing and are reproduced exactly: a check belongs to one
 * server *and* one generation, so a slow answer for a server the user has since
 * signed out of is dropped, and an ignored version is remembered per server.
 */

export interface AppUpdateStatePatch {
  checking?: boolean;
  checked?: boolean;
  release?: AndroidAppRelease | null;
  promptVisible?: boolean;
  checkFailed?: boolean;
  ignoring?: boolean;
  ignoreFailed?: boolean;
  downloadUnavailable?: boolean;
}

export class AppUpdateState {
  /** True while a check is in flight. */
  readonly checking: boolean;
  /** True once a check has answered, either way. */
  readonly checked: boolean;
  /** The newer release, or `null` when this client is current. */
  readonly release: AndroidAppRelease | null;
  /** True while the prompt dialog is up. */
  readonly promptVisible: boolean;
  readonly checkFailed: boolean;
  readonly ignoring: boolean;
  readonly ignoreFailed: boolean;
  /** True when `AppConfig` still carries the placeholder download address. */
  readonly downloadUnavailable: boolean;

  constructor(patch: AppUpdateStatePatch) {
    this.checking = patch.checking === true;
    this.checked = patch.checked === true;
    this.release = patch.release !== undefined ? patch.release : null;
    this.promptVisible = patch.promptVisible === true;
    this.checkFailed = patch.checkFailed === true;
    this.ignoring = patch.ignoring === true;
    this.ignoreFailed = patch.ignoreFailed === true;
    this.downloadUnavailable = patch.downloadUnavailable === true;
  }

  static empty(): AppUpdateState {
    return new AppUpdateState({});
  }

  copy(patch: AppUpdateStatePatch): AppUpdateState {
    return new AppUpdateState({
      checking: patch.checking !== undefined ? patch.checking : this.checking,
      checked: patch.checked !== undefined ? patch.checked : this.checked,
      release: patch.release !== undefined ? patch.release : this.release,
      promptVisible: patch.promptVisible !== undefined ? patch.promptVisible : this.promptVisible,
      checkFailed: patch.checkFailed !== undefined ? patch.checkFailed : this.checkFailed,
      ignoring: patch.ignoring !== undefined ? patch.ignoring : this.ignoring,
      ignoreFailed: patch.ignoreFailed !== undefined ? patch.ignoreFailed : this.ignoreFailed,
      downloadUnavailable: patch.downloadUnavailable !== undefined
        ? patch.downloadUnavailable : this.downloadUnavailable,
    });
  }

  /** True while an action is running, which disables both dialog buttons. */
  busy(): boolean {
    return this.ignoring;
  }
}

export class AppUpdateController {
  private readonly api: AppUpdatesApi;
  private readonly sessionStore: AuthSessionStore;
  private readonly store: AAPreferenceStore;
  private stateValue: AppUpdateState = AppUpdateState.empty();
  private currentServer: string = '';
  private generation: number = 0;
  private sessionActive: boolean = false;
  /** Notified whenever the state changes, so the shell can redraw. */
  onStateChange: (state: AppUpdateState) => void = () => {};

  constructor(api: AppUpdatesApi, sessionStore: AuthSessionStore) {
    this.api = api;
    this.sessionStore = sessionStore;
    this.store = new AAPreferenceStore(AAPreferenceNames.APP_UPDATES);
  }

  state(): AppUpdateState {
    return this.stateValue;
  }

  private setState(next: AppUpdateState): void {
    this.stateValue = next;
    this.onStateChange(next);
  }

  /** The ignored version key for the server currently signed in to. */
  private ignoredVersionKey(): string {
    return `ignored:${this.currentServer}`;
  }

  private authenticatedServer(): string {
    if (!this.sessionActive || !this.sessionStore.hasAuthSession()) {
      return '';
    }
    const serverUrl: string = this.sessionStore.readServerUrl();
    return serverUrl.trim().length > 0 ? serverUrl : '';
  }

  private isCurrentSession(serverUrl: string, generation: number): boolean {
    return generation === this.generation && serverUrl === this.currentServer
      && this.authenticatedServer() === serverUrl;
  }

  /**
   * Tells the controller whether a session is live.
   *
   * Signing in to a different server drops the previous answer; signing out
   * clears everything, so a stale prompt cannot survive a sign-out.
   */
  syncSession(allowed: boolean): void {
    this.sessionActive = allowed;
    const serverUrl: string = this.authenticatedServer();
    if (serverUrl.length === 0) {
      this.resetSession();
      return;
    }
    if (serverUrl !== this.currentServer) {
      this.resetSession();
      this.sessionActive = true;
      void this.checkForUpdate(true, false);
    }
  }

  private resetSession(): void {
    this.generation += 1;
    this.sessionActive = false;
    this.currentServer = '';
    this.setState(AppUpdateState.empty());
  }

  /**
   * Checks for a newer build.
   *
   * `showPrompt` decides whether a found release opens the dialog; the check
   * itself is skipped while one is already running against the same server.
   */
  async checkForUpdate(showPrompt: boolean, forcePrompt: boolean = false): Promise<void> {
    const serverUrl: string = this.authenticatedServer();
    if (serverUrl.length === 0) {
      this.resetSession();
      return;
    }
    if (this.stateValue.ignoring) {
      return;
    }
    if (this.stateValue.checking && serverUrl === this.currentServer) {
      return;
    }
    this.generation += 1;
    const generation: number = this.generation;
    if (serverUrl !== this.currentServer) {
      this.setState(AppUpdateState.empty());
    }
    this.currentServer = serverUrl;
    this.setState(this.stateValue.copy({ checking: true, checkFailed: false }));

    let release: AndroidAppRelease | null;
    try {
      release = await this.api.check(serverUrl, AppConfig.CLIENT_VERSION_NAME);
    } catch (error) {
      if (!this.isCurrentSession(serverUrl, generation)) {
        return;
      }
      AALog.debug(`Update check failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.setState(this.stateValue.copy({ checking: false, checked: true, checkFailed: true }));
      return;
    }
    if (!this.isCurrentSession(serverUrl, generation)) {
      return;
    }
    const ignoredVersion: string = this.store.getString(this.ignoredVersionKey(), '');
    // A release is ignored only when the stored name is the *same* version, so
    // ignoring 2.0.1 does not silence 2.0.2.
    let ignored: boolean = false;
    if (release !== null && ignoredVersion.length > 0) {
      const comparison: number | null = compareUpdateVersions(ignoredVersion, release.versionName);
      ignored = comparison !== null && comparison === 0;
    }
    this.setState(this.stateValue.copy({
      checking: false,
      checked: true,
      release: release,
      promptVisible: release !== null
        && (this.stateValue.promptVisible || (showPrompt && (!ignored || forcePrompt))),
      checkFailed: false,
      ignoreFailed: false,
      downloadUnavailable: false,
    }));
  }

  /** Opens the prompt, checking first when there is nothing to show. */
  showUpdatePrompt(): void {
    if (this.authenticatedServer() !== this.currentServer || this.currentServer.length === 0) {
      void this.checkForUpdate(true, true);
      return;
    }
    if (this.stateValue.release !== null) {
      this.setState(this.stateValue.copy({ promptVisible: true }));
      return;
    }
    void this.checkForUpdate(true, true);
  }

  /** Remembers the offered version as ignored, per server. */
  ignoreVersion(): void {
    const serverUrl: string = this.authenticatedServer();
    const release: AndroidAppRelease | null = this.stateValue.release;
    if (serverUrl.length === 0 || release === null || serverUrl !== this.currentServer) {
      return;
    }
    if (this.stateValue.ignoring) {
      return;
    }
    const generation: number = this.generation;
    const preferenceKey: string = this.ignoredVersionKey();
    this.setState(this.stateValue.copy({ ignoring: true, ignoreFailed: false }));
    try {
      this.store.setString(preferenceKey, release.versionName);
    } catch (error) {
      AALog.warn(`Ignoring the version failed: ${error instanceof Error ? error.message : 'unknown'}`);
      if (!this.isCurrentSession(serverUrl, generation)) {
        return;
      }
      this.setState(this.stateValue.copy({ ignoring: false, ignoreFailed: true }));
      return;
    }
    if (!this.isCurrentSession(serverUrl, generation)) {
      return;
    }
    const stillShowing: boolean = preferenceKey === this.ignoredVersionKey()
      && this.stateValue.release !== null
      && (this.stateValue.release as AndroidAppRelease).versionName === release.versionName;
    this.setState(this.stateValue.copy({
      ignoring: false,
      ignoreFailed: false,
      promptVisible: stillShowing ? false : this.stateValue.promptVisible,
    }));
  }

  /** Hides the prompt without ignoring the version, after "update now". */
  markPromptHandled(): void {
    this.setState(this.stateValue.copy({ promptVisible: false }));
  }

  /** Flags the placeholder download address, which Android reports in the dialog. */
  reportDownloadUnavailable(): void {
    this.setState(this.stateValue.copy({ downloadUnavailable: true, promptVisible: true }));
  }
}
