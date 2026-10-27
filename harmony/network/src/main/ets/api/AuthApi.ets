import { ApiClient } from './ApiClient';
import { AuthConfigResponse, AuthMeResponse, OAuthTokenResponse } from './AuthDtos';
import { ApiException } from 'common';
import {
  objGetBool,
  objGetNumber,
  objGetOptString,
  objGetRecord,
  objGetString
} from 'common';

export interface MobileLoginStatus {
  status: string;
  userId: string;
  deviceName: string;
  expiresAt: string;
  requestedAt: string;
  approvedAt: string;
  serverTime: string;
}

export interface MobileLoginExchange {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  displayName: string;
  email: string;
  role: string;
  userId: string;
}

export function parseAuthMeResponse(value: Record<string, Object>): AuthMeResponse {
  return {
    userId: objGetString(value, 'userId', ''),
    email: objGetOptString(value, 'email'),
    displayName: objGetString(value, 'displayName', ''),
    emailVerified: objGetBool(value, 'emailVerified', false),
    role: objGetString(value, 'role', ''),
    disabled: objGetBool(value, 'disabled', false),
    avatar: objGetOptString(value, 'avatar'),
    serverTime: objGetString(value, 'serverTime', '')
  };
}

export class AuthApi {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  async me(serverUrl: string, token: string): Promise<AuthMeResponse> {
    const body = await this.client.getJson(serverUrl, '/auth/me', token);
    return parseAuthMeResponse(body);
  }

  async updateDisplayName(serverUrl: string, token: string, displayName: string): Promise<AuthMeResponse> {
    const body: Record<string, Object> = { 'displayName': displayName.trim() };
    const response = await this.client.putJson(serverUrl, '/auth/me/profile', body, token);
    return parseAuthMeResponse(response);
  }

  async updateAvatar(serverUrl: string, token: string, avatar: string): Promise<AuthMeResponse> {
    const body: Record<string, Object> = { 'avatar': avatar };
    const response = await this.client.putJson(serverUrl, '/auth/me/avatar', body, token);
    return parseAuthMeResponse(response);
  }

  async clearAvatar(serverUrl: string, token: string): Promise<AuthMeResponse> {
    const response = await this.client.deleteJson(serverUrl, '/auth/me/avatar', token);
    return parseAuthMeResponse(response);
  }

  async changePassword(serverUrl: string, token: string, newPassword: string): Promise<void> {
    const body: Record<string, Object> = { 'newPassword': newPassword };
    await this.client.postJson(serverUrl, '/auth/change-password', body, token);
  }

  async sendEmailCode(serverUrl: string, token: string, email: string): Promise<void> {
    const body: Record<string, Object> = { 'email': email };
    await this.client.postJson(serverUrl, '/auth/send-email-code', body, token);
  }

  async bindEmail(serverUrl: string, token: string, email: string, code: string): Promise<AuthMeResponse> {
    const body: Record<string, Object> = { 'email': email, 'code': code };
    const response = await this.client.postJson(serverUrl, '/auth/bind-email', body, token);
    return parseAuthMeResponse(response);
  }

  async authConfig(serverUrl: string): Promise<AuthConfigResponse> {
    const body = await this.client.getJson(serverUrl, '/auth/config');
    return {
      needsBootstrap: objGetBool(body, 'needsBootstrap', false),
      registrationOpen: objGetBool(body, 'registrationOpen', false),
      oauthRegistrationOpen: objGetBool(body, 'oauthRegistrationOpen', false),
      oauthEnabled: objGetBool(body, 'oauthEnabled', false),
      oauthProviderLabel: objGetOptString(body, 'oauthProviderLabel'),
      setupTokenExpiresAt: objGetOptString(body, 'setupTokenExpiresAt'),
      serverTime: objGetString(body, 'serverTime', ''),
      emailVerificationRequired: objGetBool(body, 'emailVerificationRequired', false)
    };
  }

  async requireHealthyServer(serverUrl: string): Promise<void> {
    const health = await this.client.getJson(serverUrl, '/health');
    if (objGetString(health, 'status', '') !== 'ok') {
      throw new ApiException('The address did not return a healthy Agents Anywhere server.');
    }
  }

  async requireWebLoginHost(webOrigin: string): Promise<void> {
    await this.client.requireHtmlDocument(webOrigin, '/');
  }

  async oauthToken(serverUrl: string, code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
    const fields: Record<string, string> = {
      'grant_type': 'authorization_code',
      'code': code,
      'client_id': 'agents-anywhere-mobile',
      'redirect_uri': 'agents-anywhere://oauth/callback',
      'code_verifier': codeVerifier
    };
    const body = await this.client.postForm(serverUrl, '/oauth/token', fields);
    return {
      accessToken: objGetString(body, 'access_token', ''),
      tokenType: objGetString(body, 'token_type', 'Bearer'),
      expiresIn: objGetNumber(body, 'expires_in', 0),
      scope: objGetString(body, 'scope', ''),
      refreshToken: objGetOptString(body, 'refresh_token')
    };
  }

  async requestMobileLogin(serverUrl: string, userId: string, loginToken: string,
    deviceName: string | null): Promise<void> {
    const request: Record<string, Object> = {
      'userId': userId,
      'loginToken': loginToken,
      'deviceName': deviceName === null ? '' : deviceName
    };
    await this.client.postJson(serverUrl, '/auth/mobile-login/request', request, null);
  }

  async mobileLoginStatus(serverUrl: string, loginToken: string): Promise<MobileLoginStatus> {
    const request: Record<string, Object> = { 'loginToken': loginToken };
    const body = await this.client.postJson(serverUrl, '/auth/mobile-login/status', request);
    return {
      status: objGetString(body, 'status', ''),
      userId: objGetString(body, 'userId', ''),
      deviceName: objGetString(body, 'deviceName', ''),
      expiresAt: objGetString(body, 'expiresAt', ''),
      requestedAt: objGetString(body, 'requestedAt', ''),
      approvedAt: objGetString(body, 'approvedAt', ''),
      serverTime: objGetString(body, 'serverTime', '')
    };
  }

  async exchangeMobileLogin(serverUrl: string, userId: string, loginToken: string): Promise<MobileLoginExchange> {
    const request: Record<string, Object> = { 'userId': userId, 'loginToken': loginToken };
    const body = await this.client.postJson(serverUrl, '/auth/mobile-login/exchange', request);
    const auth = objGetRecord(body, 'auth');
    if (auth === null) {
      throw new ApiException('The server returned an invalid response.');
    }
    return {
      accessToken: objGetString(auth, 'accessToken', ''),
      refreshToken: objGetString(body, 'refreshToken', ''),
      expiresAt: objGetString(body, 'expiresAt', ''),
      displayName: objGetString(auth, 'displayName', ''),
      email: objGetString(auth, 'email', ''),
      role: objGetString(auth, 'role', ''),
      userId: objGetString(auth, 'userId', '')
    };
  }
}
