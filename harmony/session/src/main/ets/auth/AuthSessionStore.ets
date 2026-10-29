import { preferences } from '@kit.ArkData';
import { Context } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { normalizeServerOrigin } from 'common';

const STORE_NAME = 'agents_anywhere_auth';
const KEY_SERVER_URL = 'server_url';
const KEY_ACCESS_TOKEN = 'access_token';
const KEY_TOKEN_TYPE = 'token_type';
const KEY_USER_ID = 'user_id';
const KEY_ROLE = 'role';
const LOG_TAG = 'AgentsAnywhere.Auth';

export class AuthSessionStore {
  private static instance: AuthSessionStore | null = null;
  private store: preferences.Preferences | null = null;
  private readyPromise: Promise<void> | null = null;
  private initError: string = '';

  static getInstance(): AuthSessionStore {
    if (AuthSessionStore.instance === null) {
      AuthSessionStore.instance = new AuthSessionStore();
    }
    return AuthSessionStore.instance;
  }

  init(context: Context): void {
    if (this.readyPromise !== null) {
      return;
    }
    this.readyPromise = preferences.getPreferences(context, { name: STORE_NAME })
      .then((value: preferences.Preferences) => {
        this.store = value;
      })
      .catch((error: BusinessError) => {
        this.initError = error.message;
        hilog.error(0x0000, LOG_TAG, `getPreferences("${STORE_NAME}") failed: ${error.message}`);
      });
  }

  async waitUntilReady(): Promise<void> {
    const promise = this.readyPromise;
    if (promise !== null) {
      await promise;
    }
  }

  readServerUrl(): string {
    const origin = normalizeServerOrigin(this.readString(KEY_SERVER_URL, ''));
    return origin === null ? '' : origin;
  }

  readAccessToken(): string {
    return this.readString(KEY_ACCESS_TOKEN, '');
  }

  readUserId(): string {
    return this.readString(KEY_USER_ID, '');
  }

  readRole(): string {
    return this.readString(KEY_ROLE, '');
  }

  hasAuthSession(): boolean {
    return this.readServerUrl().length > 0 && this.readAccessToken().length > 0;
  }

  saveServerUrl(serverUrl: string): void {
    const origin = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      return;
    }
    this.putString(KEY_SERVER_URL, origin);
  }

  saveAuthSession(serverUrl: string, userId: string, role: string,
    accessToken: string, tokenType: string): void {
    const origin = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      return;
    }
    this.putString(KEY_SERVER_URL, origin);
    this.putString(KEY_ACCESS_TOKEN, accessToken);
    this.putString(KEY_TOKEN_TYPE, tokenType);
    this.putString(KEY_USER_ID, userId);
    this.putString(KEY_ROLE, role);
  }

  clearAuthSession(): void {
    const serverUrl = this.readServerUrl();
    const store = this.requireStore();
    store.clearSync();
    if (serverUrl.length > 0) {
      store.putSync(KEY_SERVER_URL, serverUrl);
    }
    this.scheduleFlush();
  }

  clearAuthSessionIfTokenMatches(accessToken: string): boolean {
    const current = this.readAccessToken();
    if (accessToken.length === 0 || current !== accessToken) {
      return false;
    }
    this.clearAuthSession();
    return true;
  }

  private requireStore(): preferences.Preferences {
    const store = this.store;
    if (store === null) {
      if (this.initError.length > 0) {
        throw new Error(`Auth session storage failed to initialize: ${this.initError}`);
      }
      throw new Error('Auth session storage is not ready yet.');
    }
    return store;
  }

  private readString(key: string, fallback: string): string {
    const store = this.requireStore();
    const value = store.getSync(key, fallback);
    if (typeof value === 'string') {
      return value;
    }
    return fallback;
  }

  private putString(key: string, value: string): void {
    const store = this.requireStore();
    store.putSync(key, value);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    const store = this.store;
    if (store === null) {
      return;
    }
    store.flush().catch(() => {
    });
  }
}
