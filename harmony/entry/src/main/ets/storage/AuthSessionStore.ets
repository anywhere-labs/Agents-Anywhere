import { AAPreferenceNames, AAPreferenceStore } from './AAPreferences';
import { ParsedAuthResponse } from '../api/AuthDtos';
import { normalizeServerOrigin } from '../api/ServerOrigin';

/**
 * Credential storage.
 *
 * Ported from `feature/auth/AuthSessionStore.kt`.
 *
 * Android keeps this in the app-private `agents_anywhere_auth` SharedPreferences
 * file and this client keeps the same keys in the app-private HarmonyOS
 * `preferences` store. The values never leave the app sandbox on either
 * platform.
 *
 * Hardening note: HarmonyOS additionally offers `@kit.AssetStoreKit`, which
 * encrypts secrets at rest and excludes them from backups. Moving `access_token`
 * and `refresh_token` there is tracked as a Phase 5 item; it is deliberately not
 * done in the first pass because it turns every read into an async call and the
 * login gate (`hasAuthSession`) is currently synchronous by design.
 */
export class AuthSessionStore {
  private readonly store: AAPreferenceStore;

  constructor() {
    this.store = new AAPreferenceStore(AAPreferenceNames.AUTH);
  }

  private static readonly KEY_SERVER_URL: string = 'server_url';
  private static readonly KEY_ACCESS_TOKEN: string = 'access_token';
  private static readonly KEY_TOKEN_TYPE: string = 'token_type';
  private static readonly KEY_USER_ID: string = 'user_id';
  private static readonly KEY_ROLE: string = 'role';
  private static readonly KEY_REFRESH_TOKEN: string = 'refresh_token';
  private static readonly KEY_REFRESH_EXPIRES_AT: string = 'refresh_expires_at';

  /**
   * Reads the saved server as a normalized origin.
   *
   * Android re-normalizes on read so a value written by an older build cannot
   * leak a path or trailing slash into URL construction.
   */
  readServerUrl(): string {
    const raw: string = this.store.getString(AuthSessionStore.KEY_SERVER_URL, '');
    if (raw.length === 0) {
      return '';
    }
    const normalized: string | null = normalizeServerOrigin(raw);
    return normalized === null ? '' : normalized;
  }

  readAccessToken(): string {
    return this.store.getString(AuthSessionStore.KEY_ACCESS_TOKEN, '');
  }

  readTokenType(): string {
    return this.store.getString(AuthSessionStore.KEY_TOKEN_TYPE, '');
  }

  readUserId(): string {
    return this.store.getString(AuthSessionStore.KEY_USER_ID, '');
  }

  readRole(): string {
    return this.store.getString(AuthSessionStore.KEY_ROLE, '');
  }

  /** True once both a server and a token are present; drives the initial route. */
  hasAuthSession(): boolean {
    return this.readServerUrl().length > 0 && this.readAccessToken().length > 0;
  }

  /** Persists only the server, used while the sign-in flow is still in progress. */
  saveServerUrl(serverUrl: string): void {
    const origin: string | null = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      throw new Error('Server URL must be an HTTP(S) origin.');
    }
    this.store.setString(AuthSessionStore.KEY_SERVER_URL, origin);
  }

  /** Persists an OAuth / password session. */
  saveAuthSession(serverUrl: string, auth: ParsedAuthResponse): void {
    const origin: string | null = normalizeServerOrigin(serverUrl);
    if (origin === null) {
      throw new Error('Server URL must be an HTTP(S) origin.');
    }
    this.store.setString(AuthSessionStore.KEY_SERVER_URL, origin);
    this.store.setString(AuthSessionStore.KEY_ACCESS_TOKEN, auth.accessToken);
    this.store.setString(AuthSessionStore.KEY_TOKEN_TYPE, auth.tokenType);
    this.store.setString(AuthSessionStore.KEY_USER_ID, auth.userId);
    this.store.setString(AuthSessionStore.KEY_ROLE, auth.role);
  }

  /**
   * Persists a QR sign-in session, which is the only flow that also yields a
   * refresh token and its expiry.
   */
  saveMobileAuthSession(
    serverUrl: string,
    auth: ParsedAuthResponse,
    refreshToken: string,
    refreshExpiresAt: string,
  ): void {
    this.saveAuthSession(serverUrl, auth);
    this.store.setString(AuthSessionStore.KEY_REFRESH_TOKEN, refreshToken);
    this.store.setString(AuthSessionStore.KEY_REFRESH_EXPIRES_AT, refreshExpiresAt);
  }

  /**
   * Signs out. The server URL survives so the next sign-in pre-fills it,
   * matching Android's `clearAuthSession`.
   */
  clearAuthSession(): void {
    const serverUrl: string = this.store.getString(AuthSessionStore.KEY_SERVER_URL, '');
    this.store.clear();
    if (serverUrl.length > 0) {
      this.store.setString(AuthSessionStore.KEY_SERVER_URL, serverUrl);
    }
  }

  /**
   * Clears the session only when the failing bearer token is still the stored
   * one. A 401 that raced a re-login must not sign out the new credential.
   */
  clearAuthSessionIfTokenMatches(token: string): boolean {
    if (token.length === 0 || this.readAccessToken() !== token) {
      return false;
    }
    this.clearAuthSession();
    return true;
  }
}
