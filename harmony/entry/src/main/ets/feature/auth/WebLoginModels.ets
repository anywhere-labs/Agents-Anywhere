import { url, util } from '@kit.ArkTS';
import { AAApiError } from '../../api/ApiError';
import { OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI } from '../../api/AuthApi';
import { normalizeServerOrigin, usesLocalNetworkHost } from '../../api/ServerOrigin';
import { base64UrlNoPadding, randomBytes, sha256 } from '../../common/AAEncoding';
import { AALog } from '../../common/AAAppLog';
import { optionalString, requireString, stringOr } from '../../api/ApiJson';
import { AppConfig } from '../../config/AppConfig';

/**
 * Web sign-in session and callback validation, plus the QR login payload.
 *
 * Port of `feature/auth/WebLoginModels.kt`.
 *
 * The PKCE verifier and the anti-CSRF state live in memory only. Android stores
 * them on a per-session object that is never persisted, so a process death
 * invalidates an in-flight sign-in instead of leaving a reusable verifier on
 * disk; the same is true here.
 */

/** The state machine the host-choice screen drives. */
export enum WebLoginState {
  HostChoice = 0,
  WebLogin = 1,
  Exchanging = 2,
  Success = 3,
}

/**
 * One in-flight PKCE attempt.
 *
 * `callbackConsumed` is a one-shot latch: the redirect can be delivered twice
 * (cold start plus `onNewIntent`) and the authorization code must only be traded
 * once.
 */
export class WebLoginSession {
  readonly serverUrl: string;
  readonly oauthWebOrigin: string;
  readonly authorizeUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  private callbackConsumed: boolean = false;

  constructor(
    serverUrl: string,
    oauthWebOrigin: string,
    authorizeUrl: string,
    state: string,
    codeVerifier: string,
  ) {
    this.serverUrl = serverUrl;
    this.oauthWebOrigin = oauthWebOrigin;
    this.authorizeUrl = authorizeUrl;
    this.state = state;
    this.codeVerifier = codeVerifier;
  }

  /** Returns true exactly once, so a replayed callback is reported rather than reused. */
  consumeCallback(): boolean {
    if (this.callbackConsumed) {
      return false;
    }
    this.callbackConsumed = true;
    return true;
  }
}

/** The API origin and the web origin, which differ only on a local dev stack. */
export interface LoginServer {
  serverUrl: string;
  webOrigin: string;
}

/**
 * Resolves the user-entered address into the API origin and the web login origin.
 *
 * In a debug build, an `:8000` local-network address is served by the API while
 * the login page lives on `:5174`, matching `android/local.properties` guidance
 * for running the stack locally.
 */
export function resolveLoginServer(serverUrl: string): LoginServer {
  const origin: string | null = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    throw new AAApiError('Enter a valid backend address.');
  }
  if (AppConfig.isDebugBuild() && origin.startsWith('http://')) {
    const authority: string = origin.substring('http://'.length);
    const colonIndex: number = authority.lastIndexOf(':');
    if (colonIndex > 0 && authority.substring(colonIndex + 1) === '8000') {
      const host: string = authority.substring(0, colonIndex);
      if (usesLocalNetworkHost(host)) {
        return { serverUrl: origin, webOrigin: `http://${host}:5174` };
      }
    }
  }
  return { serverUrl: origin, webOrigin: origin };
}

/**
 * Builds a PKCE session.
 *
 * Verifier: 32 random bytes, base64url, unpadded. State: 24 random bytes.
 * Challenge: base64url(SHA-256(verifier)), unpadded. All three sizes match the
 * Android implementation so the Server sees identical parameters.
 */
export async function createWebLoginSession(loginServer: LoginServer): Promise<WebLoginSession> {
  const codeVerifier: string = base64UrlNoPadding(randomBytes(32));
  const state: string = base64UrlNoPadding(randomBytes(24));
  const verifierBytes: Uint8Array = new util.TextEncoder().encodeInto(codeVerifier);
  const challengeBytes: Uint8Array = await sha256(verifierBytes);
  const codeChallenge: string = base64UrlNoPadding(challengeBytes);

  const query: string[] = [
    'response_type=code',
    `client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}`,
    `redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`,
    `code_challenge=${encodeURIComponent(codeChallenge)}`,
    'code_challenge_method=S256',
    'scope=profile',
    `state=${encodeURIComponent(state)}`,
  ];
  const authorizeUrl: string = `${loginServer.webOrigin}/#/mobile-oauth?${query.join('&')}`;
  return new WebLoginSession(
    loginServer.serverUrl, loginServer.webOrigin, authorizeUrl, state, codeVerifier,
  );
}

/**
 * Validates the OAuth redirect and returns the authorization code.
 *
 * Every rejection path mirrors Android's copy, because these messages tell the
 * user whether to retry, whether the server is misconfigured, or whether they
 * simply cancelled.
 */
export function parseWebLoginCallback(callbackUri: string, session: WebLoginSession): string {
  let parsed: url.URL;
  try {
    parsed = url.URL.parseURL(callbackUri);
  } catch (error) {
    throw new AAApiError('The sign-in callback was invalid.');
  }

  const scheme: string = stripTrailingColon(parsed.protocol);
  if (scheme !== 'agents-anywhere'
    || parsed.host !== 'oauth'
    || parsed.pathname !== '/callback'
    || parsed.port.length > 0) {
    throw new AAApiError('The sign-in callback was invalid.');
  }
  if (parsed.hash.length > 0) {
    throw new AAApiError('The sign-in callback was invalid.');
  }

  let entries: string[][] = [];
  try {
    // `URLParams.getAll` takes a name, so the whole query is walked with
    // `forEach`, which yields (value, key) in document order.
    parsed.params.forEach((value: string, key: string) => {
      entries.push([key, value]);
    });
  } catch (error) {
    throw new AAApiError('The sign-in callback was invalid.');
  }

  const seen: Set<string> = new Set();
  let state: string | null = null;
  let code: string | null = null;
  let errorCode: string | null = null;
  let errorDescription: string | null = null;
  for (const entry of entries) {
    const name: string = entry[0];
    const value: string = entry[1];
    if (seen.has(name)) {
      // A repeated parameter is a sign of a malformed or tampered redirect.
      throw new AAApiError('The sign-in callback was invalid.');
    }
    seen.add(name);
    if (name === 'state') {
      state = value;
    } else if (name === 'code') {
      code = value;
    } else if (name === 'error') {
      errorCode = value;
    } else if (name === 'error_description') {
      errorDescription = value;
    }
  }

  if (state !== session.state) {
    // A missing or different `state` is the one rejection that leaves no trace
    // in the redirect, so both sides are logged by length only: 0 means the
    // parameter never came back, any other mismatch means the page authorized
    // against a different attempt. The values themselves are per-attempt CSRF
    // secrets and stay out of the log.
    AALog.warn(`OAuth state mismatch: callback length=${stateLength(state)} session length=${stateLength(session.state)}`);
    throw new AAApiError('The sign-in callback did not match this login session.');
  }
  if (!session.consumeCallback()) {
    throw new AAApiError('This sign-in callback was already handled.');
  }
  if (errorCode !== null && errorCode.length > 0) {
    if (errorCode === 'access_denied') {
      throw new AAApiError('Sign in was cancelled.');
    }
    const description: string | null = optionalString(errorDescription ?? undefined);
    throw new AAApiError(description !== null ? description : errorCode);
  }
  const resolvedCode: string | null = optionalString(code ?? undefined);
  if (resolvedCode === null) {
    throw new AAApiError('The sign-in callback did not include an authorization code.');
  }
  return resolvedCode;
}

function stripTrailingColon(protocol: string): string {
  return protocol.endsWith(':') ? protocol.substring(0, protocol.length - 1) : protocol;
}

/** A state parameter's length, for the mismatch log; 0 when it never came back. */
function stateLength(value: string | null): number {
  return value === null ? 0 : value.length;
}

/** The payload carried by the desktop/web "Phone Connection" QR code. */
export interface MobileLoginQrPayload {
  serverUrl: string;
  userId: string;
  loginToken: string;
  expiresAt: string | null;
}

const MOBILE_LOGIN_QR_TYPE: string = 'agents-anywhere.mobile-login';

/**
 * Parses and validates a scanned QR payload.
 *
 * The type discriminator is checked exactly; `serverUrl` falls back to `webUrl`
 * because older desktop builds emit the latter.
 */
export function parseMobileLoginQr(rawValue: string): MobileLoginQrPayload {
  let body: MobileLoginQrDto;
  try {
    body = JSON.parse(rawValue) as MobileLoginQrDto;
  } catch (error) {
    throw new AAApiError('Scan a valid Agents Anywhere QR code.');
  }
  if (stringOr(body.type, '') !== MOBILE_LOGIN_QR_TYPE) {
    throw new AAApiError('Scan a valid Agents Anywhere QR code.');
  }
  const rawServer: string | null = optionalString(body.serverUrl) ?? optionalString(body.webUrl);
  const origin: string | null = rawServer === null ? null : normalizeServerOrigin(rawServer);
  const userId: string | null = optionalString(body.userId);
  const loginToken: string | null = optionalString(body.loginToken);
  if (origin === null || userId === null || loginToken === null) {
    throw new AAApiError('Scan a valid Agents Anywhere QR code.');
  }
  return {
    serverUrl: origin,
    userId: userId,
    loginToken: loginToken,
    expiresAt: optionalString(body.expiresAt),
  };
}

interface MobileLoginQrDto {
  type?: string;
  serverUrl?: string;
  webUrl?: string;
  userId?: string;
  loginToken?: string;
  expiresAt?: string;
}

/** Re-exported for the QR status DTO consumers. */
export { requireString };
