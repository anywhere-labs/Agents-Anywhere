const API_NAMESPACE = '/api/v2';

export enum ApiRouteStyle {
  Namespaced = 'namespaced',
  Legacy = 'legacy'
}

class ApiRouteStyleCache {
  private styles: Map<string, ApiRouteStyle> = new Map();

  get(origin: string): ApiRouteStyle | null {
    const style = this.styles.get(origin);
    if (style === undefined) {
      return null;
    }
    return style;
  }

  set(origin: string, style: ApiRouteStyle): void {
    this.styles.set(origin, style);
  }
}

const routeStyleCache = new ApiRouteStyleCache();

export function apiPath(path: string): string {
  const normalized = path.startsWith('/') ? path : '/' + path;
  let pathEnd = normalized.length;
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized.charAt(index);
    if (character === '?' || character === '#') {
      pathEnd = index;
      break;
    }
  }
  const pathname = normalized.substring(0, pathEnd);
  if (pathname === API_NAMESPACE || pathname.startsWith(API_NAMESPACE + '/')) {
    return normalized;
  }
  return API_NAMESPACE + normalized;
}

export function legacyApiPath(path: string): string {
  const normalized = path.startsWith('/') ? path : '/' + path;
  if (normalized === API_NAMESPACE) {
    return '/';
  }
  if (normalized.startsWith(API_NAMESPACE + '/')) {
    return normalized.substring(API_NAMESPACE.length);
  }
  return normalized;
}

export function apiUrlCandidates(serverUrl: string, path: string): string[] {
  const origin = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    throw new Error('Server URL must be an HTTP(S) origin.');
  }
  const style = routeStyleCache.get(origin);
  if (style === ApiRouteStyle.Namespaced) {
    return [origin + apiPath(path)];
  }
  if (style === ApiRouteStyle.Legacy) {
    return [origin + legacyApiPath(path)];
  }
  return [origin + apiPath(path), origin + legacyApiPath(path)];
}

export function apiUrl(serverUrl: string, path: string): string {
  const origin = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    throw new Error('Server URL must be an HTTP(S) origin.');
  }
  const style = routeStyleCache.get(origin);
  const suffix = style === ApiRouteStyle.Legacy ? legacyApiPath(path) : apiPath(path);
  return origin + suffix;
}

export function rememberApiUrl(serverUrl: string, resolvedUrl: string): void {
  const origin = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    return;
  }
  if (!resolvedUrl.startsWith(origin)) {
    return;
  }
  let rawPath = resolvedUrl.substring(origin.length);
  const queryIndex = rawPath.indexOf('?');
  if (queryIndex >= 0) {
    rawPath = rawPath.substring(0, queryIndex);
  }
  const hashIndex = rawPath.indexOf('#');
  if (hashIndex >= 0) {
    rawPath = rawPath.substring(0, hashIndex);
  }
  const namespaced = rawPath === API_NAMESPACE || rawPath.startsWith(API_NAMESPACE + '/');
  routeStyleCache.set(origin, namespaced ? ApiRouteStyle.Namespaced : ApiRouteStyle.Legacy);
}

export function usesLegacyApiRoute(serverUrl: string): boolean {
  const origin = normalizeServerOrigin(serverUrl);
  if (origin === null) {
    return false;
  }
  return routeStyleCache.get(origin) === ApiRouteStyle.Legacy;
}

export function webSocketApiUrl(serverUrl: string, path: string): string {
  const httpUrl = apiUrl(serverUrl, path);
  if (httpUrl.startsWith('https://')) {
    return 'wss://' + httpUrl.substring('https://'.length);
  }
  return 'ws://' + httpUrl.substring('http://'.length);
}

export function usesLocalNetworkHost(host: string): boolean {
  const lowered = host.toLowerCase();
  if (lowered === 'localhost' || lowered === '::1' || lowered === '[::1]' || lowered.endsWith('.local')) {
    return true;
  }
  const parts = lowered.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]+$/.test(part)) {
      return false;
    }
    const value = parseInt(part);
    if (value > 255) {
      return false;
    }
    octets.push(value);
  }
  if (octets[0] === 10 || octets[0] === 127) {
    return true;
  }
  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }
  return false;
}

export function normalizeServerOrigin(serverUrl: string): string | null {
  let working = serverUrl.trim();
  while (working.endsWith('/')) {
    working = working.substring(0, working.length - 1);
  }
  if (working.length === 0) {
    return null;
  }

  let candidate = working;
  if (!candidate.includes('://')) {
    const firstSegment = candidate.split('/')[0];
    const hostPart = firstSegment.split(':')[0].toLowerCase();
    if (hostPart.length === 0) {
      return null;
    }
    const hasPort = firstSegment.includes(':');
    const scheme = usesLocalNetworkHost(hostPart) || hasPort ? 'http' : 'https';
    candidate = scheme + '://' + candidate;
  }

  const schemeSeparator = candidate.indexOf('://');
  if (schemeSeparator <= 0) {
    return null;
  }
  const scheme = candidate.substring(0, schemeSeparator).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return null;
  }
  const rest = candidate.substring(schemeSeparator + 3);
  if (rest.length === 0) {
    return null;
  }

  const slashIndex = rest.indexOf('/');
  const authority = slashIndex >= 0 ? rest.substring(0, slashIndex) : rest;
  const path = slashIndex >= 0 ? rest.substring(slashIndex) : '';
  if (authority.includes('@') || authority.includes('?') || authority.includes('#')) {
    return null;
  }
  if (path.includes('?') || path.includes('#')) {
    return null;
  }

  let host = authority;
  let portText = '';
  if (authority.startsWith('[')) {
    const closeIndex = authority.indexOf(']');
    if (closeIndex < 0) {
      return null;
    }
    host = authority.substring(0, closeIndex + 1);
    const afterBracket = authority.substring(closeIndex + 1);
    if (afterBracket.length > 0) {
      if (!afterBracket.startsWith(':')) {
        return null;
      }
      portText = afterBracket.substring(1);
    }
  } else {
    const colonIndex = authority.lastIndexOf(':');
    if (colonIndex >= 0) {
      host = authority.substring(0, colonIndex);
      portText = authority.substring(colonIndex + 1);
      if (host.includes(':')) {
        return null;
      }
    }
  }
  const hostLower = host.toLowerCase();
  if (hostLower.length === 0) {
    return null;
  }
  if (portText.length > 0) {
    if (!/^[0-9]+$/.test(portText)) {
      return null;
    }
    const portNumber = parseInt(portText);
    if (portNumber > 65535) {
      return null;
    }
  }

  const trimmedPath = path.replace(/\/+$/, '');
  if (trimmedPath.length > 0 && trimmedPath !== API_NAMESPACE) {
    return null;
  }

  return scheme + '://' + hostLower + (portText.length > 0 ? ':' + portText : '');
}
