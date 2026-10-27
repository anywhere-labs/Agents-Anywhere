import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { LoginServerConnection } from './LoginServer';

export const WEB_LOGIN_CALLBACK_URI = 'agents-anywhere://oauth/callback';
export const WEB_LOGIN_CLIENT_ID = 'agents-anywhere-mobile';

const WEB_LOGIN_CALLBACK_PREFIX = 'agents-anywhere://oauth/callback';
const URL_SAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export class WebLoginSession {
  readonly serverUrl: string;
  readonly oauthWebOrigin: string;
  readonly authorizeUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  private callbackConsumed: boolean = false;

  constructor(serverUrl: string, oauthWebOrigin: string, authorizeUrl: string, state: string,
    codeVerifier: string) {
    this.serverUrl = serverUrl;
    this.oauthWebOrigin = oauthWebOrigin;
    this.authorizeUrl = authorizeUrl;
    this.state = state;
    this.codeVerifier = codeVerifier;
  }

  consumeCallback(): boolean {
    if (this.callbackConsumed) {
      return false;
    }
    this.callbackConsumed = true;
    return true;
  }
}

export enum WebLoginCallbackKind {
  Success = 'success',
  Error = 'error',
  Invalid = 'invalid'
}

export class WebLoginCallback {
  readonly kind: WebLoginCallbackKind;
  readonly code: string;
  readonly message: string;

  constructor(kind: WebLoginCallbackKind, code: string, message: string) {
    this.kind = kind;
    this.code = code;
    this.message = message;
  }
}

export async function createWebLoginSession(server: LoginServerConnection): Promise<WebLoginSession> {
  const codeVerifier = await randomUrlSafeString(32);
  const state = await randomUrlSafeString(24);
  const challenge = await pkceChallenge(codeVerifier);
  const query = 'response_type=code' +
    `&client_id=${encodeURIComponent(WEB_LOGIN_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(WEB_LOGIN_CALLBACK_URI)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    '&code_challenge_method=S256' +
    `&scope=${encodeURIComponent('profile')}` +
    `&state=${encodeURIComponent(state)}`;
  return new WebLoginSession(
    server.serverUrl,
    server.oauthWebOrigin,
    `${server.oauthWebOrigin}/#/mobile-oauth?${query}`,
    state,
    codeVerifier);
}

export function parseWebLoginCallback(callbackUrl: string, session: WebLoginSession): WebLoginCallback {
  const invalid = new WebLoginCallback(WebLoginCallbackKind.Invalid, '',
    'The sign-in callback was invalid.');
  const lowered = callbackUrl.toLowerCase();
  if (!lowered.startsWith(WEB_LOGIN_CALLBACK_PREFIX)) {
    return invalid;
  }
  const rest = callbackUrl.substring(WEB_LOGIN_CALLBACK_PREFIX.length);
  if (rest.length > 0 && !rest.startsWith('?')) {
    return invalid;
  }
  if (rest.includes('#')) {
    return invalid;
  }
  const query = rest.startsWith('?') ? rest.substring(1) : '';
  const seenNames: string[] = [];
  let stateValue: string | null = null;
  let errorValue: string | null = null;
  let errorDescriptionValue: string | null = null;
  let codeValue: string | null = null;
  const parts = query.split('&');
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    const equalsIndex = part.indexOf('=');
    const rawName = equalsIndex >= 0 ? part.substring(0, equalsIndex) : part;
    const rawValue = equalsIndex >= 0 ? part.substring(equalsIndex + 1) : '';
    if (rawName.length === 0) {
      continue;
    }
    let name = '';
    let value = '';
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch (error) {
      return invalid;
    }
    if (seenNames.includes(name)) {
      return invalid;
    }
    seenNames.push(name);
    if (name === 'state') {
      stateValue = value;
    } else if (name === 'error') {
      errorValue = value;
    } else if (name === 'error_description') {
      errorDescriptionValue = value;
    } else if (name === 'code') {
      codeValue = value;
    }
  }
  if (stateValue === null || stateValue !== session.state) {
    return new WebLoginCallback(WebLoginCallbackKind.Invalid, '',
      'The sign-in callback did not match this login session.');
  }
  if (!session.consumeCallback()) {
    return new WebLoginCallback(WebLoginCallbackKind.Invalid, '',
      'This sign-in callback was already handled.');
  }
  if (errorValue !== null && errorValue.length > 0) {
    const message = errorValue === 'access_denied'
      ? 'Sign in was cancelled.'
      : (errorDescriptionValue !== null && errorDescriptionValue.length > 0 ? errorDescriptionValue : errorValue);
    return new WebLoginCallback(WebLoginCallbackKind.Error, '', message);
  }
  if (codeValue === null || codeValue.trim().length === 0) {
    return new WebLoginCallback(WebLoginCallbackKind.Invalid, '',
      'The sign-in callback did not include an authorization code.');
  }
  return new WebLoginCallback(WebLoginCallbackKind.Success, codeValue, '');
}

export async function pkceChallenge(codeVerifier: string): Promise<string> {
  const bytes = new Uint8Array(codeVerifier.length);
  for (let index = 0; index < codeVerifier.length; index++) {
    bytes[index] = codeVerifier.charCodeAt(index) & 0xFF;
  }
  const md = cryptoFramework.createMd('SHA256');
  await md.update({ data: bytes });
  const digest = await md.digest();
  return base64UrlNoPadding(digest.data);
}

export function base64UrlNoPadding(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += URL_SAFE_ALPHABET.charAt(b0 >> 2);
    output += URL_SAFE_ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
    if (index + 1 < bytes.length) {
      output += URL_SAFE_ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6));
    }
    if (index + 2 < bytes.length) {
      output += URL_SAFE_ALPHABET.charAt(b2 & 63);
    }
  }
  return output;
}

function randomUrlSafeString(byteLength: number): Promise<string> {
  const rand = cryptoFramework.createRandom();
  return rand.generateRandom(byteLength).then((data: cryptoFramework.DataBlob) => {
    return base64UrlNoPadding(data.data);
  });
}
