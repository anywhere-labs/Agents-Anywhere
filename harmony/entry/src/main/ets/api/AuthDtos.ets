import {
  booleanOr, numberOr, optionalString, requireString, stringOr,
} from './ApiJson';

/**
 * Auth and identity DTOs.
 *
 * Field names and defaults are taken from `AuthDtos.kt` and the parsing helpers
 * in `ApiClient.kt`; every interface declares its fields optional so an omitted
 * key reads as `undefined` and is normalised by the `parse*` function below.
 *
 * Server semantics that matter:
 *  - `AuthResponse.tokenType` defaults to the lowercase `"bearer"`, while the
 *    OAuth token response defaults to `"Bearer"`. Both are reproduced verbatim
 *    because the stored value is sent back as `Authorization` on some paths.
 */

/** `GET /health` — unauthenticated liveness and version probe. */
export interface HealthDto {
  status?: string;
  version?: string;
}

export interface ParsedHealth {
  status: string;
  version: string;
}

export function parseHealth(dto: HealthDto): ParsedHealth {
  return {
    status: stringOr(dto.status, ''),
    version: stringOr(dto.version, '').trim(),
  };
}

/** `GET /auth/config` — which sign-in methods the deployment offers. */
export interface AuthConfigDto {
  needsBootstrap?: boolean;
  emailVerificationRequired?: boolean;
  registrationOpen?: boolean;
  oauthRegistrationOpen?: boolean;
  oauthEnabled?: boolean;
  oauthProviderLabel?: string;
  setupTokenExpiresAt?: string;
  serverTime?: string;
}

export interface ParsedAuthConfig {
  needsBootstrap: boolean;
  emailVerificationRequired: boolean;
  registrationOpen: boolean;
  oauthRegistrationOpen: boolean;
  oauthEnabled: boolean;
  oauthProviderLabel: string | null;
  setupTokenExpiresAt: string | null;
  serverTime: string;
}

export function parseAuthConfig(dto: AuthConfigDto): ParsedAuthConfig {
  return {
    needsBootstrap: booleanOr(dto.needsBootstrap, false),
    emailVerificationRequired: booleanOr(dto.emailVerificationRequired, false),
    registrationOpen: booleanOr(dto.registrationOpen, false),
    oauthRegistrationOpen: booleanOr(dto.oauthRegistrationOpen, false),
    oauthEnabled: booleanOr(dto.oauthEnabled, false),
    oauthProviderLabel: optionalString(dto.oauthProviderLabel),
    setupTokenExpiresAt: optionalString(dto.setupTokenExpiresAt),
    serverTime: requireString(dto.serverTime, 'serverTime'),
  };
}

/** `GET /auth/me` and the account-mutating endpoints. */
export interface AuthMeDto {
  userId?: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
  role?: string;
  disabled?: boolean;
  avatar?: string;
  serverTime?: string;
}

export interface ParsedAuthMe {
  userId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  role: string;
  disabled: boolean;
  avatar: string | null;
  serverTime: string;
}

export function parseAuthMe(dto: AuthMeDto): ParsedAuthMe {
  return {
    userId: requireString(dto.userId, 'userId'),
    email: optionalString(dto.email),
    displayName: stringOr(dto.displayName, ''),
    emailVerified: booleanOr(dto.emailVerified, false),
    role: requireString(dto.role, 'role'),
    disabled: booleanOr(dto.disabled, false),
    avatar: optionalString(dto.avatar),
    serverTime: requireString(dto.serverTime, 'serverTime'),
  };
}

/** The `auth` object inside the mobile-login exchange response. */
export interface AuthResponseDto {
  userId?: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
  role?: string;
  accessToken?: string;
  tokenType?: string;
  serverTime?: string;
}

export interface ParsedAuthResponse {
  userId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  role: string;
  accessToken: string;
  tokenType: string;
  serverTime: string;
}

/**
 * Used by `POST /auth/mobile-login/exchange`. Note the lowercase `"bearer"`
 * default, which differs from the OAuth response below.
 */
export function parseAuthResponse(dto: AuthResponseDto): ParsedAuthResponse {
  return {
    userId: requireString(dto.userId, 'userId'),
    email: optionalString(dto.email),
    displayName: stringOr(dto.displayName, ''),
    emailVerified: booleanOr(dto.emailVerified, false),
    role: requireString(dto.role, 'role'),
    accessToken: requireString(dto.accessToken, 'accessToken'),
    tokenType: stringOr(dto.tokenType, 'bearer'),
    serverTime: requireString(dto.serverTime, 'serverTime'),
  };
}

/** `POST /oauth/token` — the PKCE authorization-code exchange. */
export interface OAuthTokenDto {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface ParsedOAuthToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  refreshToken: string | null;
}

export function parseOAuthToken(dto: OAuthTokenDto): ParsedOAuthToken {
  return {
    accessToken: requireString(dto.access_token, 'access_token'),
    tokenType: stringOr(dto.token_type, 'Bearer'),
    expiresIn: numberOr(dto.expires_in, 0),
    scope: stringOr(dto.scope, ''),
    refreshToken: optionalString(dto.refresh_token),
  };
}

/** `POST /auth/email-code`. */
export interface EmailCodeDto {
  expiresIn?: number;
  retryAfter?: number;
}

export interface ParsedEmailCode {
  expiresIn: number;
  retryAfter: number;
}

export function parseEmailCode(dto: EmailCodeDto): ParsedEmailCode {
  return {
    expiresIn: numberOr(dto.expiresIn, 0),
    retryAfter: numberOr(dto.retryAfter, 0),
  };
}

/** `POST /auth/mobile-login/{request,status}` — the QR sign-in status object. */
export interface MobileLoginStatusDto {
  status?: string;
  userId?: string;
  deviceName?: string;
  expiresAt?: string;
  requestedAt?: string;
  approvedAt?: string;
  serverTime?: string;
}

export interface ParsedMobileLoginStatus {
  status: string;
  userId: string | null;
  deviceName: string | null;
  expiresAt: string | null;
  requestedAt: string | null;
  approvedAt: string | null;
  serverTime: string;
}

export function parseMobileLoginStatus(dto: MobileLoginStatusDto): ParsedMobileLoginStatus {
  return {
    status: requireString(dto.status, 'status'),
    userId: optionalString(dto.userId),
    deviceName: optionalString(dto.deviceName),
    expiresAt: optionalString(dto.expiresAt),
    requestedAt: optionalString(dto.requestedAt),
    approvedAt: optionalString(dto.approvedAt),
    serverTime: requireString(dto.serverTime, 'serverTime'),
  };
}

/** `POST /auth/mobile-login/exchange` — trades the one-time token for a session. */
export interface MobileLoginExchangeDto {
  auth?: AuthResponseDto;
  refreshToken?: string;
  expiresAt?: string;
  serverTime?: string;
}

export interface ParsedMobileLoginExchange {
  auth: ParsedAuthResponse;
  refreshToken: string;
  expiresAt: string;
  serverTime: string;
}

export function parseMobileLoginExchange(dto: MobileLoginExchangeDto): ParsedMobileLoginExchange {
  if (dto.auth === undefined || dto.auth === null) {
    requireString(undefined, 'auth');
  }
  return {
    auth: parseAuthResponse(dto.auth as AuthResponseDto),
    refreshToken: requireString(dto.refreshToken, 'refreshToken'),
    expiresAt: requireString(dto.expiresAt, 'expiresAt'),
    serverTime: requireString(dto.serverTime, 'serverTime'),
  };
}

/** QR sign-in status values reported by the Server. */
export class MobileLoginStatus {
  static readonly PENDING_WEB_CONFIRM: string = 'pending_web_confirm';
  static readonly APPROVED: string = 'approved';
  static readonly REJECTED: string = 'rejected';
  static readonly EXPIRED: string = 'expired';
  static readonly CONSUMED: string = 'consumed';
}
