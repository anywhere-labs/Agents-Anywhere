import { AAApiError } from './ApiError';
import { HttpTransport } from './HttpTransport';
import { normalizeServerOrigin } from './ServerOrigin';
import {
  AuthConfigDto, AuthMeDto, EmailCodeDto, MobileLoginExchangeDto, MobileLoginStatusDto,
  OAuthTokenDto, ParsedAuthConfig, ParsedAuthMe, ParsedEmailCode, ParsedMobileLoginExchange,
  ParsedMobileLoginStatus, ParsedOAuthToken, parseAuthConfig, parseAuthMe, parseEmailCode,
  parseMobileLoginExchange, parseMobileLoginStatus, parseOAuthToken,
} from './AuthDtos';
import { booleanOr, optionalString, requireString, stringOr } from './ApiJson';

/**
 * Auth and account resource client.
 *
 * Port of the auth portion of `api/Auth.kt` / `AuthDtos.kt`.
 *
 * One method maps to one Server resource; no user workflow lives here. Requiring
 * a healthy Server and a reachable web-login host is validation the sign-in flow
 * needs before it opens a browser, so those two helpers sit here rather than in
 * the controller.
 */

/** The OAuth client id registered for the mobile clients. */
export const OAUTH_CLIENT_ID: string = 'agents-anywhere-mobile';
/** The redirect target, identical across Android, iOS, desktop and HarmonyOS. */
export const OAUTH_REDIRECT_URI: string = 'agents-anywhere://oauth/callback';

export class AuthApi {
  private readonly transport: HttpTransport;

  constructor(transport: HttpTransport) {
    this.transport = transport;
  }

  /**
   * Confirms the address serves an Agents Anywhere API.
   * A user typing a random host gets a specific message instead of a timeout.
   */
  async requireHealthyServer(serverUrl: string): Promise<void> {
    const body: Object = await this.transport.getJson(serverUrl, '/health');
    const status: string = stringOr((body as HealthLike).status, '');
    if (status !== 'ok') {
      throw new AAApiError('The address did not return a healthy Agents Anywhere server.');
    }
  }

  /** Confirms the origin actually serves the web sign-in page. */
  async requireWebLoginHost(webOrigin: string): Promise<void> {
    await this.transport.requireHtmlDocument(webOrigin, '/');
  }

  async config(serverUrl: string): Promise<ParsedAuthConfig> {
    const body: Object = await this.transport.getJson(serverUrl, '/auth/config');
    return parseAuthConfig(body as AuthConfigDto);
  }

  async me(serverUrl: string, token: string): Promise<ParsedAuthMe> {
    const body: Object = await this.transport.getJson(serverUrl, '/auth/me', token);
    return parseAuthMe(body as AuthMeDto);
  }

  /** PKCE authorization-code exchange. Carries no bearer token. */
  async exchangeOAuthCode(
    serverUrl: string,
    code: string,
    codeVerifier: string,
  ): Promise<ParsedOAuthToken> {
    if (code.length === 0) {
      throw new AAApiError('Missing authorization code.');
    }
    const fields: Map<string, string> = new Map();
    fields.set('grant_type', 'authorization_code');
    fields.set('code', code);
    fields.set('client_id', OAUTH_CLIENT_ID);
    fields.set('redirect_uri', OAUTH_REDIRECT_URI);
    fields.set('code_verifier', codeVerifier);
    const body: Object = await this.transport.postForm(serverUrl, '/oauth/token', fields);
    return parseOAuthToken(body as OAuthTokenDto);
  }

  /** Approves a scanned QR login token for this device. */
  async mobileLoginRequest(
    serverUrl: string,
    userId: string,
    loginToken: string,
    deviceName: string,
  ): Promise<ParsedMobileLoginStatus> {
    const body: MobileLoginRequest = { userId: userId, loginToken: loginToken };
    if (deviceName.length > 0) {
      body.deviceName = deviceName;
    }
    try {
      const response: Object = await this.transport.postJson(
        serverUrl, '/auth/mobile-login/request', '', body, 15_000,
      );
      return parseMobileLoginStatus(response as MobileLoginStatusDto);
    } catch (error) {
      throw translateQrError(error);
    }
  }

  async mobileLoginStatus(serverUrl: string, loginToken: string): Promise<ParsedMobileLoginStatus> {
    const body: MobileLoginStatusRequest = { loginToken: loginToken };
    try {
      const response: Object = await this.transport.postJson(
        serverUrl, '/auth/mobile-login/status', '', body, 15_000,
      );
      return parseMobileLoginStatus(response as MobileLoginStatusDto);
    } catch (error) {
      throw translateQrError(error);
    }
  }

  async mobileLoginExchange(
    serverUrl: string,
    userId: string,
    loginToken: string,
  ): Promise<ParsedMobileLoginExchange> {
    const body: MobileLoginRequest = { userId: userId, loginToken: loginToken };
    try {
      const response: Object = await this.transport.postJson(
        serverUrl, '/auth/mobile-login/exchange', '', body, 15_000,
      );
      return parseMobileLoginExchange(response as MobileLoginExchangeDto);
    } catch (error) {
      throw translateQrError(error);
    }
  }

  async updateDisplayName(serverUrl: string, token: string, displayName: string): Promise<ParsedAuthMe> {
    const body: DisplayNameRequest = { displayName: displayName.trim() };
    const response: Object = await this.transport.putJson(serverUrl, '/auth/me/profile', token, body);
    return parseAuthMe(response as AuthMeDto);
  }

  async updateAvatar(serverUrl: string, token: string, avatar: string): Promise<ParsedAuthMe> {
    const body: AvatarRequest = { avatar: avatar };
    const response: Object = await this.transport.putJson(serverUrl, '/auth/me/avatar', token, body);
    return parseAuthMe(response as AuthMeDto);
  }

  async clearAvatar(serverUrl: string, token: string): Promise<ParsedAuthMe> {
    const response: Object = await this.transport.deleteJson(serverUrl, '/auth/me/avatar', token);
    return parseAuthMe(response as AuthMeDto);
  }

  async sendEmailCode(serverUrl: string, token: string, email: string): Promise<ParsedEmailCode> {
    const body: EmailCodeRequest = { email: email.trim(), purpose: 'bind' };
    const response: Object = await this.transport.postJson(serverUrl, '/auth/email-code', token, body, 15_000);
    return parseEmailCode(response as EmailCodeDto);
  }

  async bindEmail(
    serverUrl: string,
    token: string,
    email: string,
    code: string | null,
  ): Promise<ParsedAuthMe> {
    const body: EmailBindRequest = { email: email.trim() };
    const trimmedCode: string | null = optionalString(code ?? undefined);
    if (trimmedCode !== null) {
      body.code = trimmedCode.trim();
    }
    const response: Object = await this.transport.putJson(serverUrl, '/auth/me/email', token, body);
    return parseAuthMe(response as AuthMeDto);
  }

  async changePassword(serverUrl: string, token: string, newPassword: string): Promise<void> {
    const body: PasswordRequest = { newPassword: newPassword };
    await this.transport.postJson(serverUrl, '/auth/change-password', token, body, 15_000);
  }

  /** The health payload used by the update check. */
  async health(serverUrl: string): Promise<HealthLike> {
    const body: Object = await this.transport.getJson(serverUrl, '/health');
    return body as HealthLike;
  }

  /** The normalized origin for a user-entered address, or null when invalid. */
  static originOf(serverUrl: string): string | null {
    return normalizeServerOrigin(serverUrl);
  }
}

/**
 * The QR flow reports a dead token as 401 in all three calls, and the status
 * poll can also see 404 once the request has been reaped. Both mean the same
 * thing to the user.
 */
function translateQrError(error: Object): AAApiError {
  const apiError: AAApiError = error instanceof AAApiError
    ? error
    : new AAApiError('Invalid or expired QR code.', 401);
  if (apiError.statusCode === 401 || apiError.statusCode === 404) {
    return new AAApiError('Invalid or expired QR code.', apiError.statusCode);
  }
  return apiError;
}

/** Minimal shape needed to read the health status without a full DTO. */
export interface HealthLike {
  status?: string;
  version?: string;
}

interface MobileLoginRequest {
  userId: string;
  loginToken: string;
  deviceName?: string;
}

interface MobileLoginStatusRequest {
  loginToken: string;
}

interface DisplayNameRequest {
  displayName: string;
}

interface AvatarRequest {
  avatar: string;
}

interface EmailCodeRequest {
  email: string;
  purpose: string;
}

interface EmailBindRequest {
  email: string;
  code?: string;
}

interface PasswordRequest {
  newPassword: string;
}

/** Re-exported so callers do not need to reach into the DTO module for booleans. */
export { booleanOr, requireString };
