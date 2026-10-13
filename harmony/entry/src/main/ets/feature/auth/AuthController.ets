import { deviceInfo } from '@kit.BasicServicesKit';
import { AAApiError } from '../../api/ApiError';
import { AuthApi } from '../../api/AuthApi';
import {
  ParsedAuthMe, ParsedAuthResponse, ParsedMobileLoginExchange, ParsedMobileLoginStatus,
} from '../../api/AuthDtos';
import { HttpTransport } from '../../api/HttpTransport';
import { AuthSessionStore } from '../../storage/AuthSessionStore';
import { AALog } from '../../common/AAAppLog';
import {
  createWebLoginSession, LoginServer, MobileLoginQrPayload, parseMobileLoginQr,
  parseWebLoginCallback, resolveLoginServer, WebLoginSession,
} from './WebLoginModels';

/**
 * Sign-in workflows.
 *
 * Port of `feature/auth/AuthController.kt`.
 *
 * Composes the auth resource client into the three user-visible operations:
 * embedded web sign-in with PKCE, QR sign-in, and sign-out. No UI state lives
 * here; the screens own their own progress and error fields.
 */
export class AuthController {
  private readonly sessionStore: AuthSessionStore;
  private readonly authApi: AuthApi;

  constructor(sessionStore: AuthSessionStore, transport: HttpTransport, authApi: AuthApi) {
    this.sessionStore = sessionStore;
    this.authApi = authApi;
  }

  /** The saved server origin, or an empty string when signed out. */
  savedServerUrl(): string {
    return this.sessionStore.readServerUrl();
  }

  hasAuthSession(): boolean {
    return this.sessionStore.hasAuthSession();
  }

  /**
   * Validates the address and prepares a PKCE session.
   *
   * The two preflight calls exist so the embedded browser is only opened for an
   * address that is both a working API and a working web-login host; otherwise
   * the user stares at a blank web view.
   */
  async startWebLogin(serverUrl: string): Promise<WebLoginSession> {
    const loginServer: LoginServer = resolveLoginServer(serverUrl);
    try {
      await this.authApi.requireHealthyServer(loginServer.serverUrl);
      await this.authApi.requireWebLoginHost(loginServer.webOrigin);
    } catch (error) {
      throw asApiError(error, 'Could not reach the server.');
    }
    this.sessionStore.saveServerUrl(loginServer.serverUrl);
    return createWebLoginSession(loginServer);
  }

  /**
   * Validates the redirect, trades the code, and persists the session.
   *
   * `GET /auth/me` runs because the OAuth response carries only the token, while
   * the client needs the account identity to render the profile drawer.
   */
  async completeWebLogin(callbackUri: string, session: WebLoginSession): Promise<ParsedAuthResponse> {
    const code: string = parseWebLoginCallback(callbackUri, session);
    try {
      const token = await this.authApi.exchangeOAuthCode(session.serverUrl, code, session.codeVerifier);
      const me: ParsedAuthMe = await this.authApi.me(session.serverUrl, token.accessToken);
      const auth: ParsedAuthResponse = {
        userId: me.userId,
        email: me.email,
        displayName: me.displayName,
        emailVerified: me.emailVerified,
        role: me.role,
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        serverTime: me.serverTime,
      };
      this.sessionStore.saveAuthSession(session.serverUrl, auth);
      return auth;
    } catch (error) {
      throw asApiError(error, 'Could not complete web sign-in.');
    }
  }

  /**
   * Approves a scanned QR login token.
   *
   * `deviceName` is sent so the desktop approval prompt can name the phone that
   * is asking to sign in.
   */
  async requestMobileLoginFromQr(
    qrValue: string,
    deviceName: string = '',
  ): Promise<MobileLoginQrPayload> {
    const payload: MobileLoginQrPayload = parseMobileLoginQr(qrValue);
    this.sessionStore.saveServerUrl(payload.serverUrl);
    await this.authApi.mobileLoginRequest(
      payload.serverUrl,
      payload.userId,
      payload.loginToken,
      deviceName.length > 0 ? deviceName : AuthController.currentDeviceName(),
    );
    return payload;
  }

  async mobileLoginStatus(serverUrl: string, loginToken: string): Promise<ParsedMobileLoginStatus> {
    return this.authApi.mobileLoginStatus(serverUrl, loginToken);
  }

  /** Trades an approved QR token for a session, which is the only flow with a refresh token. */
  async completeMobileLogin(payload: MobileLoginQrPayload): Promise<ParsedAuthResponse> {
    const exchange: ParsedMobileLoginExchange = await this.authApi.mobileLoginExchange(
      payload.serverUrl, payload.userId, payload.loginToken,
    );
    this.sessionStore.saveMobileAuthSession(
      payload.serverUrl, exchange.auth, exchange.refreshToken, exchange.expiresAt,
    );
    return exchange.auth;
  }

  /** Validates the stored session on resume; a failure surfaces as a toast. */
  async me(serverUrl: string, token: string): Promise<ParsedAuthMe> {
    return this.authApi.me(serverUrl, token);
  }

  /**
   * Clears the credential but keeps the server address, so the next sign-in
   * pre-fills the address the user already chose.
   */
  signOut(): void {
    this.sessionStore.clearAuthSession();
  }

  /**
   * Clears the session only when the failing token is still current, so a 401
   * that raced a re-login cannot sign out the new credential.
   */
  signOutIfTokenMatches(token: string): boolean {
    return this.sessionStore.clearAuthSessionIfTokenMatches(token);
  }

  /**
   * `<Manufacturer> <Model>`, the label shown on the desktop approval prompt.
   *
   * Android builds this from `Build.MANUFACTURER` and `Build.MODEL`; the
   * HarmonyOS equivalents are `manufacture` and `productModel`.
   */
  static currentDeviceName(): string {
    try {
      const manufacturer: string = deviceInfo.manufacture ?? '';
      const model: string = deviceInfo.productModel ?? '';
      const parts: string[] = [];
      if (manufacturer.length > 0) {
        parts.push(manufacturer.charAt(0).toUpperCase() + manufacturer.substring(1));
      }
      if (model.length > 0) {
        parts.push(model);
      }
      const joined: string = parts.join(' ');
      return joined.length > 0 ? joined : 'HarmonyOS';
    } catch (error) {
      AALog.warn(`Could not read the device name: ${error instanceof Error ? error.message : 'unknown'}`);
      return 'HarmonyOS';
    }
  }
}

/**
 * Normalizes any thrown value into an `AAApiError`.
 *
 * An `AAApiError` already carries the Server's or a validation message, so it is
 * passed through; anything else becomes the caller's fallback copy. This keeps
 * the exact three-tier message behaviour Android has: specific preflight error,
 * Server message, then generic fallback.
 */
function asApiError(error: Object, fallbackMessage: string): AAApiError {
  if (error instanceof AAApiError) {
    return error;
  }
  return new AAApiError(fallbackMessage);
}
