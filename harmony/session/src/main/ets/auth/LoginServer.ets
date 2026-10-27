import { DEBUG } from '../../../../build/default/generated/profile/default/BuildProfile';
import { normalizeServerOrigin, usesLocalNetworkHost } from 'common';

export class LoginServerConnection {
  readonly serverUrl: string;
  readonly oauthWebOrigin: string;

  constructor(serverUrl: string, oauthWebOrigin: string) {
    this.serverUrl = serverUrl;
    this.oauthWebOrigin = oauthWebOrigin;
  }
}

export function resolveLoginServer(serverUrl: string): LoginServerConnection | null {
  const origin = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    return null;
  }
  let webOrigin = origin;
  const schemeSeparator = origin.indexOf('://');
  const scheme = origin.substring(0, schemeSeparator);
  const authority = origin.substring(schemeSeparator + 3);
  let host = authority;
  let portText = '';
  if (authority.startsWith('[')) {
    const closeIndex = authority.indexOf(']');
    if (closeIndex < 0) {
      return null;
    }
    host = authority.substring(0, closeIndex + 1);
    const afterBracket = authority.substring(closeIndex + 1);
    if (afterBracket.startsWith(':')) {
      portText = afterBracket.substring(1);
    }
  } else {
    const colonIndex = authority.lastIndexOf(':');
    if (colonIndex >= 0) {
      host = authority.substring(0, colonIndex);
      portText = authority.substring(colonIndex + 1);
    }
  }
  const hostName = host.startsWith('[') && host.endsWith(']') ? host.substring(1, host.length - 1) : host;
  // The local stack serves the API on 8000 and the login page on 5174.
  // Only in debug builds, so a release build never rewrites a real :8000 server.
  if (DEBUG && portText === '8000' && usesLocalNetworkHost(hostName)) {
    webOrigin = scheme + '://' + host + ':5174';
  }
  return new LoginServerConnection(origin, webOrigin);
}
